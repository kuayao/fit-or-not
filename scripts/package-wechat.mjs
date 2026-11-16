import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pipeline } from 'node:stream/promises';
import { buildSync, transform } from 'esbuild';
import yazl from 'yazl';

const root = process.cwd();
const local = process.argv.includes('--local');
const environment = local ? 'local' : 'production';
const outputRoot = local ? 'release/local' : 'release';
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'fit-or-not-wechat-'));
const target = path.join(stage, 'wechat');
const mini = path.join(target, 'miniprogram');
const productionConfig = 'miniprogram/config/environment.production.ts';
const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
const project = JSON.parse(fs.readFileSync('project.config.json', 'utf8'));
const sha256 = data => createHash('sha256').update(data).digest('hex');
function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
}
const sourceFiles = files('miniprogram').filter(file => !file.includes('/node_modules/') && !file.includes('/miniprogram_npm/')
  && !file.endsWith('.d.ts') && /\.(ts|json|wxml|wxss|wxs|svg)$/.test(file)
  && !['package.json', 'package-lock.json', 'tsconfig.json'].includes(path.basename(file)));
for (const file of sourceFiles.filter(file => file !== productionConfig)) {
  const dest = path.join(target, file).replace(/\.ts$/, '.js');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const contents = fs.readFileSync(file === 'miniprogram/config/environment.ts' && !local ? productionConfig : file);
  fs.writeFileSync(dest, file.endsWith('.ts')
    ? (await transform(contents.toString(), { loader: 'ts', format: 'cjs', target: 'es2015', minify: true })).code
    : contents);
}
fs.copyFileSync('miniprogram/assets/icons/LICENSE', path.join(mini, 'assets/icons/LICENSE'));
fs.cpSync('miniprogram/miniprogram_npm', path.join(mini, 'miniprogram_npm'), { recursive: true });
project.setting = { es6: true, enhance: true, minified: true, urlCheck: !local, useCompilerPlugins: [], packNpmManually: false, ignoreUploadUnusedFiles: true };
fs.writeFileSync(path.join(target, 'project.config.json'), JSON.stringify(project, null, 2) + '\n');

const reachable = new Set();
function resolveFile(base) {
  const resolved = [base, base + '.js', path.join(base, 'index.js')]
    .find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!resolved) throw new Error(`依赖文件不存在：${base}`);
  return resolved;
}
function resolveImport(file, spec) {
  if (spec.startsWith('.')) return resolveFile(path.resolve(path.dirname(file), spec));
  if (spec.startsWith('/')) return resolveFile(path.join(mini, spec));
  for (let dir = path.dirname(file); dir.startsWith(mini); dir = path.dirname(dir)) {
    const base = path.join(dir, 'miniprogram_npm', spec);
    const resolved = [base, base + '.js', path.join(base, 'index.js')]
      .find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    if (resolved) return resolved;
  }
  throw new Error(`npm 依赖不存在：${spec}，引用位置：${file}`);
}
function visit(file) {
  if (reachable.has(file)) return;
  reachable.add(file);
  const contents = fs.readFileSync(file, 'utf8');
  if (file.endsWith('.json')) {
    for (const spec of Object.values(JSON.parse(contents).usingComponents || {})) {
      const base = spec.startsWith('.') ? path.resolve(path.dirname(file), spec)
        : path.join(mini, spec.startsWith('/') ? spec : 'miniprogram_npm/' + spec);
      for (const ext of ['.js', '.json', '.wxml', '.wxss']) visit(resolveFile(base + ext));
    }
  }
  if (/\.(js|wxs)$/.test(file)) {
    const result = buildSync({
      stdin: { contents, sourcefile: file }, bundle: true, external: ['*'],
      write: false, metafile: true, treeShaking: false, logLevel: 'silent'
    });
    for (const input of Object.values(result.metafile.inputs)) {
      for (const imported of input.imports) visit(resolveImport(file, imported.path));
    }
  }
  if (file.endsWith('.wxml')) {
    for (const match of contents.matchAll(/<(?:import|include|wxs)\b[^>]*\bsrc=["']([^"']+)["']/g))
      visit(resolveFile(match[1].startsWith('/') ? path.join(mini, match[1]) : path.resolve(path.dirname(file), match[1])));
  }
  if (file.endsWith('.wxss')) {
    for (const match of contents.matchAll(/@import\s+(?:url\()?\s*["']([^"']+)["']/g))
      visit(resolveFile(match[1].startsWith('/') ? path.join(mini, match[1]) : path.resolve(path.dirname(file), match[1])));
  }
}
for (const file of files(mini).filter(file => !file.includes('/miniprogram_npm/'))) visit(file);
for (const file of files(path.join(mini, 'miniprogram_npm'))) if (!reachable.has(file)) fs.unlinkSync(file);

const apiBaseUrl = createRequire(import.meta.url)(path.join(mini, 'config/environment.js')).API_BASE_URL;
const metadata = {
  name: project.projectname, version, environment, builtAt: new Date().toISOString(),
  apiBaseUrl, appId: project.appid, javascriptTarget: 'ES2015 CommonJS',
  build: { dependencyResolution: 'completed', javascriptTarget: 'ES2015 CommonJS' }
};
fs.writeFileSync(path.join(target, 'release.json'), JSON.stringify(metadata, null, 2) + '\n');
fs.writeFileSync(path.join(target, 'source-sha256.json'), JSON.stringify(Object.fromEntries(
  [...sourceFiles, 'package.json', 'scripts/package-wechat.mjs', 'scripts/build-wechat.mjs', 'scripts/build-wechat-deps.mjs']
    .map(file => [file, sha256(fs.readFileSync(file))])
), null, 2) + '\n');
fs.writeFileSync(path.join(target, 'README.txt'), local
  ? `搭搭不搭搭 ${version} 本地小程序\nAPI：${apiBaseUrl}\n使用微信开发者工具导入本目录。需保持本地 API 与 worker 运行。\n本包已编译为 ES2015 CommonJS，已包含 npm 依赖。未执行真机验收。\n`
  : `搭搭不搭搭 ${version} 生产小程序\nAPI：${apiBaseUrl}\n使用微信开发者工具导入本目录，本地调试使用源码项目根目录。\n微信合法域名：${new URL(apiBaseUrl).origin}\n后端部署目录 .env 的 PUBLIC_BASE_URL=${apiBaseUrl.replace(/\/api$/, '')}\n本包已编译为 ES2015 CommonJS，已包含 npm 依赖。未执行微信上传、发布或真机验收。\n`);
fs.writeFileSync(path.join(target, 'SHA256SUMS'), files(target)
  .map(file => `${sha256(fs.readFileSync(file))}  ${path.relative(target, file)}`).join('\n') + '\n');
const archiveName = `fit-or-not-wechat-${version}-${environment}.zip`;
const zip = new yazl.ZipFile();
for (const file of files(target)) zip.addFile(file, 'wechat/' + path.relative(target, file));
const zipDone = pipeline(zip.outputStream, fs.createWriteStream(path.join(stage, archiveName)));
zip.end();
await zipDone;
fs.mkdirSync(outputRoot, { recursive: true });
fs.rmSync(path.join(outputRoot, 'wechat'), { recursive: true, force: true });
fs.cpSync(target, path.join(outputRoot, 'wechat'), { recursive: true });
fs.copyFileSync(path.join(stage, archiveName), path.join(root, outputRoot, archiveName));
fs.writeFileSync(path.join(outputRoot, 'SHA256SUMS'), fs.readdirSync(outputRoot, { withFileTypes: true })
  .filter(entry => entry.isFile() && /\.(zip|tar\.gz|json|md)$/.test(entry.name))
  .map(entry => `${sha256(fs.readFileSync(path.join(outputRoot, entry.name)))}  ${entry.name}`).join('\n') + '\n');
fs.rmSync(stage, { recursive: true });
console.log(`${local ? '本地' : '生产'}工程：${outputRoot}/wechat\n小程序包：${outputRoot}/${archiveName}\nAPI：${apiBaseUrl}`);
