// 集成测试: 真实连接器进程 + 用 Node 模拟的扩展端 (同一份 session.js).
// 运行: node test/integration.test.mjs   (macOS 上会在钥匙串里写测试凭据, 结束时删除)
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import * as P from '../extension/protocol.js';
import { ExtensionSide } from '../extension/session.js';

const require = createRequire(new URL('../connector/', import.meta.url));
const WebSocket = require('ws');
const root = new URL('..', import.meta.url).pathname;
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(ok ? 'PASS' : 'FAIL', name, extra); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connector(viaLauncher = false) {
  const args = viaLauncher ? [root + 'test/launch.mjs'] : [root + 'connector/index.js'];
  const p = spawn('node', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  p.log = '';
  p.port = new Promise((res) => p.stderr.on('data', (d) => { p.log += d; const m = String(d).match(/127\.0\.0\.1:(\d+), 等待/); if (m) res(Number(m[1])); }));
  let buf = '', id = 1; const replies = new Map();
  p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(l); replies.get(m.id)?.(m); } catch {} } });
  const rpc = (method, params) => new Promise((res) => { const i = id++; replies.set(i, res); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
  p.init = async () => { await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-client', version: '9.9' } }); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'); };
  p.tool = async (name, args = {}) => { const r = await rpc('tools/call', { name, arguments: args }); return { err: !!r.result?.isError, text: r.result?.content?.[0]?.text || '' }; };
  p.end = () => new Promise((res) => { p.on('exit', res); p.stdin.end(); });
  return p;
}

// 模拟扩展: 身份与信任表跨连接保留, 和真扩展一样
const extId = await (async () => { const kp = await P.newSigningKey(); return { sk: kp.privateKey, pub: await P.exportPub(kp.publicKey) }; })();
const trust = new Map();

function fakeExt(port, handler = (m) => ({ id: m.id, ok: true, result: [{ tabId: 1, from: 'fake-ext' }] })) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: 'chrome-extension://test' });
  const st = { ready: false, pending: false, closed: false };
  const side = new ExtensionSide(
    { sendText: (d) => ws.send(d), sendBinary: (d) => ws.send(d), close: (c) => ws.close(c) },
    {
      identity: extId,
      trustOf: (p) => trust.get(p) || null,
      onTrusted: (p) => trust.set(p, 'trusted'),
      onReady: () => (st.ready = true),
      onPending: () => (st.pending = true),
      onMessage: (m) => m.id !== undefined && side.send(handler(m)),
    }
  );
  ws.on('message', (d, bin) => side.receive(bin ? d : d.toString()));
  ws.on('close', (code) => { st.closed = true; st.code = code; });
  return Object.assign(st, { side, ws, close: () => ws.close() });
}

const codeIn = (t) => t.match(/配对码 ([0-9A-Z]{4}-[0-9A-Z]{4})/)?.[1];

// 1. 首次: 待配对, 工具返回配对码; 用码配对后可用
const A = connector(); await A.init(); const pa = await A.port;
let e = fakeExt(pa); await sleep(500);
let r = await A.tool('chrome_tabs');
const code = codeIn(r.text);
check('未配对时工具返回配对码', r.err && e.pending && !!code, code);
const st = await A.tool('chrome_status');
check('chrome_status 显示待配对与同一个码', st.text.includes('待配对') && st.text.includes(code));
check('agent 身份被识别 (测试进程: 按脚本路径)', /integration\.test\.mjs/.test(st.text) && /"strength": "path"/.test(st.text));
check('错码被拒', (await e.side.pair('ZZZZ-ZZZZ')) === false);
check('正确码配对成功', (await e.side.pair(code)) === true); await sleep(200);
r = await A.tool('chrome_tabs');
check('配对后工具调用走通 (经加密通道)', !r.err && r.text.includes('fake-ext'), r.text.slice(0, 50));

// 2. 同一个 agent 的新会话: 直接就绪, 不用配对
const B = connector(); await B.init(); const pb = await B.port;
const e2 = fakeExt(pb); await sleep(600);
r = await B.tool('chrome_tabs');
check('同一 agent 的新会话免配对', e2.ready && !e2.pending && !r.err, r.text.slice(0, 40));

// 3. 扩展重连 (模拟扩展重载): 不用重新配对
e2.close(); await sleep(200);
const e2b = fakeExt(pb); await sleep(500);
check('扩展重连后免配对', e2b.ready && !(await B.tool('chrome_tabs')).err);

// 4. 另一个 agent (父进程不同): 拿不到 A 的信任, 需要自己配对
const C = connector(true); await C.init(); const pc = await C.port;
const e3 = fakeExt(pc); await sleep(600);
r = await C.tool('chrome_tabs');
check('不同 agent 不继承信任, 需要单独配对', r.err && !!codeIn(r.text) && e3.pending && !e3.ready);

// 5. 在线猜码: 3 次错误后码作废换新
const c1 = codeIn(r.text);
for (let i = 0; i < 3; i++) await e3.side.pair(P.newCode());
const c2 = codeIn((await C.tool('chrome_tabs')).text);
check('连续 3 次错码后换新配对码', c1 && c2 && c1 !== c2, `${c1} -> ${c2}`);

// 6. 撤销: 扩展把 A/B 这个 agent 标为撤销 -> 连接器换钥, 重新进入待配对
const oldPub = [...trust.entries()].find(([, v]) => v === 'trusted')[0];
trust.set(oldPub, 'revoked');
e2b.close(); await sleep(200);
fakeExt(pb); await sleep(800); // 这一条会被告知 revoked, 连接器换钥后断开
const e4 = fakeExt(pb); await sleep(800);
r = await B.tool('chrome_tabs');
check('撤销后连接器换新密钥并要求重新配对', r.err && !!codeIn(r.text) && e4.pending && B.log.includes('更换密钥'));

// 7. 网页来源 / 无来源的连接直接被拒
const bad = await new Promise((res) => { const w = new WebSocket(`ws://127.0.0.1:${pa}`, { origin: 'https://evil.example' }); w.on('unexpected-response', (_q, x) => res(x.statusCode)); w.on('open', () => res('open')); w.on('error', () => {}); });
check('网页来源被拒', bad === 401, String(bad));

for (const p of [A, B, C]) await p.end();
for (const x of [e, e2b, e3, e4]) try { x.close(); } catch {}

// 清理测试凭据 (钥匙串)
if (process.platform === 'darwin') {
  for (const id of [`path:${root}test/integration.test.mjs`, `path:${root}test/launch.mjs`]) {
    const acct = createHash('sha256').update(id).digest('hex').slice(0, 32);
    try { execFileSync('security', ['delete-generic-password', '-s', 'chrome-bridge', '-a', acct], { stdio: 'ignore' }); } catch {}
  }
}
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
