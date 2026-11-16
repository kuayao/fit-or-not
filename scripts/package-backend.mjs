import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

const environment = process.argv[2] || 'production';
if (!['local', 'production'].includes(environment)) throw new Error('环境必须为 local 或 production');
const local = environment === 'local';
const outputRoot = local ? 'release/local' : 'release';
const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
const platform = `linux/${local && process.arch === 'arm64' ? 'arm64' : 'amd64'}`;
const image = `fit-or-not-backend:${version}${local ? '-local' : ''}`;
const imageArchive = `fit-or-not-backend-${version}${local ? '-local' : ''}-${platform.replace('/', '-')}.tar.gz`;
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'fit-or-not-backend-'));
const target = path.join(stage, 'backend');
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
fs.mkdirSync(target);
execFileSync('docker', ['build', '--platform', platform, '-f', 'deploy/Dockerfile', '-t', image, '.'], { stdio: 'inherit' });
const save = spawn('docker', ['save', image], { stdio: ['ignore', 'pipe', 'inherit'] });
const saved = new Promise((resolve, reject) => {
  save.on('error', reject);
  save.on('exit', code => code === 0 ? resolve() : reject(new Error(`docker save 失败：${code}`)));
});
await Promise.all([pipeline(save.stdout, createGzip(), fs.createWriteStream(path.join(target, imageArchive))), saved]);
const composeSource = local ? 'deploy/compose.local-app.yml' : 'deploy/compose.production.yml';
fs.writeFileSync(path.join(target, 'compose.yml'), fs.readFileSync(composeSource, 'utf8')
  .replace(/image: fit-or-not-backend:[^\n]+/g, `image: ${image}`)
  .replace(/platform: linux\/[^\n]+/g, `platform: ${platform}`));
const envSource = local ? '.env.example' : 'deploy/.env.example';
const env = fs.readFileSync(envSource, 'utf8');
fs.writeFileSync(path.join(target, '.env'), local
  ? env.replace(/^HOST=.*$/m, 'HOST=0.0.0.0').replace(/^DB_HOST=.*$/m, 'DB_HOST=fit-or-not-local-db-1')
    .replace(/^DB_PORT=.*$/m, 'DB_PORT=5432').replace(/^MEDIA_DIR=.*$/m, 'MEDIA_DIR=/app/media')
    .replace(/^WECHAT_APP_ID=.*$/m, `WECHAT_APP_ID=${JSON.parse(fs.readFileSync('project.config.json', 'utf8')).appid}`)
  : env);
fs.writeFileSync(path.join(target, 'release.json'), JSON.stringify({
  version, environment, platform, image, imageArchive, builtAt: new Date().toISOString(),
  envFile: '.env', composeFile: 'compose.yml'
}, null, 2) + '\n');
const sourceFiles = [
  'package.json', 'package-lock.json', 'deploy/Dockerfile', 'deploy/start.mjs', composeSource, envSource,
  'miniprogram/api/contracts.ts', 'miniprogram/utils/layout.ts', 'scripts/package-backend.mjs',
  ...fs.readdirSync('server', { recursive: true }).filter(file => /\.(ts|sql|json)$/.test(file)).map(file => path.join('server', file))
];
fs.writeFileSync(path.join(target, 'source-sha256.json'), JSON.stringify(Object.fromEntries(sourceFiles.map(file => [file, sha256(file)])), null, 2) + '\n');
fs.writeFileSync(path.join(target, 'README.md'), `# 搭搭不搭搭 ${version} ${local ? '本地' : '生产'}后端\n\n平台：${platform}，镜像：${image}。\n\n${local ? '先在源码根目录执行 npm run db:up，准备本地 PostgreSQL 及其网络。' : '提前准备已有 PostgreSQL 的专用数据库、账号和 schema 建表权限。'}\n\n编辑本目录 .env，填写微信及 AI 密钥、数据库配置、媒体签名密钥。签名密钥可用 openssl rand -hex 32 生成。升级时保留服务器原有 .env 和媒体卷；部署配置文件统一为 .env。\n\n\`\`\`sh\ndocker load -i ${imageArchive}\ndocker compose -f compose.yml up -d\n\`\`\`\n\nAPI 与 worker 启动时自动迁移。${local ? '小程序使用本地 API http://127.0.0.1:3006/api。' : '小程序 API 为 https://fabric.wapiti.vip/ootd/api；反代将 /ootd/ 转发到 http://127.0.0.1:3006/。'}\n\n本包由构建与归档流程生成，打包时不启动容器、不执行集成测试或检查服务器。\n`);
fs.writeFileSync(path.join(target, 'SHA256SUMS'), fs.readdirSync(target).map(file => `${sha256(path.join(target, file))}  ${file}`).join('\n') + '\n');
const archiveName = `fit-or-not-backend-${version}-${environment}-${platform.replace('/', '-')}.tar.gz`;
execFileSync('tar', ['-czf', path.join(stage, archiveName), '-C', stage, 'backend'], { stdio: 'inherit', env: { ...process.env, COPYFILE_DISABLE: '1' } });
fs.mkdirSync(outputRoot, { recursive: true });
fs.rmSync(path.join(outputRoot, 'backend'), { recursive: true, force: true });
fs.cpSync(target, path.join(outputRoot, 'backend'), { recursive: true });
fs.copyFileSync(path.join(stage, archiveName), path.join(outputRoot, archiveName));
fs.writeFileSync(path.join(outputRoot, 'SHA256SUMS'), fs.readdirSync(outputRoot, { withFileTypes: true })
  .filter(entry => entry.isFile() && /\.(zip|tar\.gz|json|md)$/.test(entry.name))
  .map(entry => `${sha256(path.join(outputRoot, entry.name))}  ${entry.name}`).join('\n') + '\n');
fs.rmSync(stage, { recursive: true });
console.log(`后端目录：${outputRoot}/backend\n后端包：${outputRoot}/${archiveName}\n镜像：${image}`);
