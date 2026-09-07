import { spawn, spawnSync } from 'node:child_process';
import { watch, copyFileSync } from 'node:fs';
const result = spawnSync(process.execPath, ['scripts/build.mjs'], { stdio: 'inherit' });
if (result.status !== 0) process.exit(1);
const compiler = spawn('tsc', ['--watch', '--preserveWatchOutput'], { stdio: 'inherit', shell: process.platform === 'win32' });
const server = spawn(process.execPath, ['--watch', 'dist/server/main.js'], { stdio: 'inherit' });
const assets = watch('client', (_, name) => {
  if (name === 'index.html' || name === 'styles.css') copyFileSync(`client/${name}`, `dist/public/${name}`);
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { assets.close(); compiler.kill(); server.kill(); });
