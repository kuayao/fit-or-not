import { spawn } from 'node:child_process';

const children = ['server/src/index.ts', 'server/src/worker.ts'].map(path => spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'watch', '--env-file=.env', path], { stdio: 'inherit' }));
function stop() { for (const child of children) child.kill('SIGTERM'); }
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
for (const child of children) child.on('exit', code => { if (code) { process.exitCode = code; stop(); } });
