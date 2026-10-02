// 测试用: 以「另一个 agent」的身份启动连接器 (父进程是这个脚本, 而不是测试主进程)
import { spawn } from 'node:child_process';
const p = spawn('node', [new URL('../connector/index.js', import.meta.url).pathname], { stdio: 'inherit' });
p.on('exit', (c) => process.exit(c ?? 0));
process.stdin.on('end', () => p.kill());
