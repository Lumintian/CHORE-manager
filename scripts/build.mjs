import { spawnSync } from 'node:child_process';
import { mkdirSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
rmSync('dist', { recursive: true, force: true });
const tscBin = existsSync('node_modules/.bin/tsc') ? resolve('node_modules/.bin/tsc') : 'tsc';
const result = spawnSync(tscBin, ['-p', 'tsconfig.json'], { stdio: 'inherit', shell: process.platform === 'win32' });
if (result.status !== 0) process.exit(result.status ?? 1);
mkdirSync('dist/public', { recursive: true });
for (const file of ['index.html', 'styles.css']) copyFileSync(`client/${file}`, `dist/public/${file}`);
