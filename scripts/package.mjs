import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
const environment = process.argv[2];
if (!['local', 'production'].includes(environment)) throw new Error('环境必须为 local 或 production');
const outputRoot = environment === 'local' ? 'release/local' : 'release';
execFileSync('npm', ['run', 'typecheck'], { stdio: 'inherit' });
execFileSync('npm', ['run', 'build:wechat'], { stdio: 'inherit' });
execFileSync(process.execPath, ['scripts/package-wechat.mjs', ...(environment === 'local' ? ['--local'] : [])], { stdio: 'inherit' });
execFileSync(process.execPath, ['scripts/package-backend.mjs', environment], { stdio: 'inherit' });
const metadata = {
  version: JSON.parse(fs.readFileSync('package.json', 'utf8')).version,
  environment, builtAt: new Date().toISOString(),
  backend: JSON.parse(fs.readFileSync(path.join(outputRoot, 'backend/release.json'), 'utf8')),
  wechat: JSON.parse(fs.readFileSync(path.join(outputRoot, 'wechat/release.json'), 'utf8')),
  steps: ['typecheck', 'build', 'archive', 'sha256']
};
fs.writeFileSync(path.join(outputRoot, 'release.json'), JSON.stringify(metadata, null, 2) + '\n');
fs.writeFileSync(path.join(outputRoot, 'SHA256SUMS'), fs.readdirSync(outputRoot, { withFileTypes: true })
  .filter(entry => entry.isFile() && /\.(zip|tar\.gz|json|md)$/.test(entry.name))
  .map(entry => `${createHash('sha256').update(fs.readFileSync(path.join(outputRoot, entry.name))).digest('hex')}  ${entry.name}`).join('\n') + '\n');
console.log(`${environment === 'local' ? '本地' : '生产'}前后端打包完成：${outputRoot}/`);
