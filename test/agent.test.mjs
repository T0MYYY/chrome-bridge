// agent 识别: 哪些父进程是启动层 (shell / npm 等), 应跳过继续往上找
import { isLauncher } from '../connector/agent.js';
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(ok ? 'PASS' : 'FAIL', name, extra); };
const p = (comm, args = comm) => ({ comm, base: comm.split('/').pop().replace(/^-/, ''), args });

check('shell', isLauncher(p('/bin/zsh', '/bin/zsh -c x')) && isLauncher(p('-zsh')));
check('npx 可执行文件', isLauncher(p('/usr/local/bin/npx')));
check('node 跑 npm-cli.js', isLauncher(p('node', 'node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js run x')));
check('npm 改过进程标题 (npm run x)', isLauncher(p('npm run who', 'npm run who')));
check('npx 改过进程标题 (npm exec x)', isLauncher(p('npm exec chrome-bridge', 'npm exec chrome-bridge')));
check('真正的 agent 不是启动层', !isLauncher(p('claude', 'claude --x')) && !isLauncher(p('node', 'node /path/to/my-agent.js')));
console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
process.exit(results.every(Boolean) ? 0 : 1);
