const entrypoints = {
  api: '../dist/server/src/index.js',
  worker: '../dist/server/src/worker.js',
  invite: '../dist/server/src/invite.js'
};
const mode = process.argv[2] || 'api';
if (!Object.hasOwn(entrypoints, mode)) throw new Error(`不支持的启动模式：${mode}`);
await import(entrypoints[mode]);
