import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build, transform } from 'esbuild';

await build({
  stdin: { contents: "export * from 'zod';", resolveDir: process.cwd(), sourcefile: 'zod-entry.js' },
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2015',
  minify: true,
  outfile: 'miniprogram/miniprogram_npm/zod/index.js'
});
const npmRoot = 'miniprogram/miniprogram_npm';
for (const file of await readdir(npmRoot, { recursive: true, withFileTypes: true })) {
  if (!file.isFile() || !file.name.endsWith('.js')) continue;
  const path = join(file.parentPath, file.name);
  await writeFile(path, (await transform(await readFile(path, 'utf8'), {
    target: 'es2015',
    format: 'cjs',
    minify: true
  })).code);
}
console.log('已生成微信可加载的 ES2015 CommonJS 依赖，包括 TDesign 和 Zod。');
