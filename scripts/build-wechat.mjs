import { spawnSync } from 'node:child_process';

const result = spawnSync(process.env.WECHAT_CLI || '/Applications/wechatwebdevtools.app/Contents/MacOS/cli', ['build-npm', '--project', process.cwd()], { encoding: 'utf8' });
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
if (result.error) throw result.error;
if (result.status !== 0 || !`${result.stdout}${result.stderr}`.includes('✔ build-npm')) throw new Error('微信 npm 构建失败');
await import('./build-wechat-deps.mjs');
