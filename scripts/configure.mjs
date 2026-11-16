import { readFile, writeFile, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

const exists = await access('.env').then(() => true, () => false);
if (!exists) {
  await writeFile('.env', (await readFile('.env.example', 'utf8')).replace('replace-with-at-least-32-random-characters', randomBytes(32).toString('hex')), { mode: 0o600 });
}
const env = await readFile('.env', 'utf8');
const appId = env.match(/^WECHAT_APP_ID=(.*)$/m)?.[1].trim();
if (!appId) {
  console.log('已创建本地 .env。请填写 WECHAT_APP_ID 和 WECHAT_APP_SECRET，再运行 npm run configure。');
  process.exit(0);
}
if (!/^wx[a-f0-9]{16}$/.test(appId)) throw new Error('WECHAT_APP_ID 格式不正确');
await writeFile('project.config.json', JSON.stringify({
  appid: appId,
  projectname: '搭搭不搭搭',
  compileType: 'miniprogram',
  miniprogramRoot: 'miniprogram/',
  libVersion: '3.18.0',
  setting: {
    es6: true, enhance: true, minified: true, urlCheck: false,
    useCompilerPlugins: ['typescript'], packNpmManually: true,
    packNpmRelationList: [{ packageJsonPath: './miniprogram/package.json', miniprogramNpmDistDir: './miniprogram/' }]
  }
}, null, 2) + '\n');
console.log('已更新微信工程配置。AppSecret 仅保存在本机 .env 中。');
