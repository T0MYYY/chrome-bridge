// 识别启动本连接器的 agent, 并读写它的长期凭据.
//
// 身份 (macOS): 沿父进程链跳过 shell/npx 之类的中间层, 找到 agent 进程, 用 codesign
// 校验这个运行中进程的签名, 取「团队 ID + 标识符」. agent 升级后身份不变; 别的软件
// 自己启动连接器时, 父进程是它自己, 签名对不上, 拿不到已配对 agent 的凭据.
// 没有签名的 agent (如跑在 node 上的 CLI) 退化为按可执行文件 / 脚本路径识别.
// 父进程已消失等无法识别的情况: 返回 null, 调用方改用只在本进程有效的临时身份.
//
// 凭据: macOS 存钥匙串 (经 `security -i` 从 stdin 写入, 不出现在进程参数里),
// 其他系统存 ~/.config/chrome-bridge/agents/*.json (0600).

import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const run = (cmd, args) =>
  new Promise((resolve) =>
    execFile(cmd, args, { timeout: 5000 }, (e, stdout, stderr) => resolve({ ok: !e, stdout: String(stdout), stderr: String(stderr) }))
  );

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'env', 'timeout', 'nohup']);
const NODE_LIKE = new Set(['node', 'bun', 'deno']);
const NODE_WRAPPERS = /(^|\/)(npx|npm|pnpm|yarn|bunx|npx-cli\.js|npm-cli\.js)$/;
const SERVICE = 'chrome-bridge';

async function proc(pid) {
  const r = await run('ps', ['-o', 'ppid=,comm=', '-p', String(pid)]);
  const m = r.stdout.trim().match(/^(\d+)\s+(.*)$/);
  if (!m) return null;
  const args = (await run('ps', ['-o', 'args=', '-p', String(pid)])).stdout.trim();
  return { pid, ppid: Number(m[1]), comm: m[2], base: path.basename(m[2]).replace(/^-/, ''), args };
}

// node/bun 进程跑的脚本 (第一个不是选项的参数)
function scriptOf(args) {
  const parts = args.split(/\s+/).slice(1);
  return parts.find((a) => !a.startsWith('-')) || '';
}

async function codesignOf(pid) {
  const verify = await run('codesign', ['--verify', String(pid)]);
  if (!verify.ok) return null;
  const d = await run('codesign', ['-dv', '--verbose=2', String(pid)]);
  const out = d.stderr;
  const get = (k) => out.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1];
  const team = get('TeamIdentifier');
  const identifier = get('Identifier');
  if (!team || team === 'not set' || !identifier) return null;
  const org = out.match(/^Authority=Developer ID Application: (.*?) \(/m)?.[1] || out.match(/^Authority=Apple Development: (.*?) \(/m)?.[1];
  return { team, identifier, org };
}

export async function identifyAgent() {
  let p = await proc(process.ppid);
  for (let hops = 0; p && hops < 6; hops++) {
    const viaNodeWrapper = NODE_LIKE.has(p.base) && NODE_WRAPPERS.test(scriptOf(p.args));
    if (!SHELLS.has(p.base) && !viaNodeWrapper && !NODE_WRAPPERS.test(p.base)) break;
    p = p.ppid > 1 ? await proc(p.ppid) : null;
  }
  if (!p || p.pid <= 1) return null;

  if (process.platform === 'darwin') {
    const sig = await codesignOf(p.pid);
    // 校验期间父进程若已退出, pid 可能被复用: 再确认一次链路仍在
    if (process.ppid === 1) return null;
    if (sig) {
      return {
        id: `codesign:${sig.team}:${sig.identifier}`,
        label: sig.org ? `${sig.identifier} · ${sig.org}` : sig.identifier,
        strength: 'signed',
      };
    }
  }

  if (NODE_LIKE.has(p.base)) {
    const script = scriptOf(p.args);
    if (script) {
      const real = await fs.realpath(script).catch(() => script);
      return { id: `path:${real}`, label: `${path.basename(real)} (${p.base}, 未签名)`, strength: 'path' };
    }
  }
  const exe = await exePath(p.pid);
  if (!exe) return null;
  return { id: `path:${exe}`, label: `${path.basename(exe)} (未签名)`, strength: 'path' };
}

async function exePath(pid) {
  if (process.platform === 'linux') return fs.readlink(`/proc/${pid}/exe`).catch(() => null);
  const r = await run('lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn']);
  return r.stdout.split('\n').find((l) => l.startsWith('n'))?.slice(1) || null;
}

// ---------------- 凭据存储 ----------------

const account = (agentId) => createHash('sha256').update(agentId).digest('hex').slice(0, 32);
const fileOf = (agentId) => path.join(os.homedir(), '.config', 'chrome-bridge', 'agents', account(agentId) + '.json');

export async function loadCredential(agentId) {
  try {
    if (process.platform === 'darwin') {
      const r = await run('security', ['find-generic-password', '-s', SERVICE, '-a', account(agentId), '-w']);
      if (!r.ok) return null;
      return JSON.parse(Buffer.from(r.stdout.trim(), 'base64').toString());
    }
    return JSON.parse(await fs.readFile(fileOf(agentId), 'utf8'));
  } catch {
    return null;
  }
}

export async function saveCredential(agentId, cred) {
  const json = JSON.stringify(cred);
  if (process.platform === 'darwin') {
    const value = Buffer.from(json).toString('base64'); // base64 不含空格引号, 无需转义
    const label = 'Chrome Bridge agent key';
    const cmd = `add-generic-password -U -s ${SERVICE} -a ${account(agentId)} -l "${label}" -j "${agentId.replace(/"/g, '')}" -w ${value}\n`;
    await new Promise((resolve, reject) => {
      const p = spawn('security', ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => (err += d));
      p.on('exit', (code) => (code === 0 && !err.trim() ? resolve() : reject(new Error('写入钥匙串失败: ' + err.trim()))));
      p.stdin.end(cmd);
    });
    return;
  }
  const f = fileOf(agentId);
  await fs.mkdir(path.dirname(f), { recursive: true, mode: 0o700 });
  await fs.writeFile(f, json, { mode: 0o600 });
}
