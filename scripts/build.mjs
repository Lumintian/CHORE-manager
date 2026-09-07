import { spawnSync } from 'node:child_process';
import { mkdirSync, copyFileSync, rmSync } from 'node:fs';
rmSync('dist', { recursive: true, force: true });
const result = spawnSync('tsc', ['-p', 'tsconfig.json'], { stdio: 'inherit', shell: process.platform === 'win32' });
if (result.status !== 0) process.exit(result.status ?? 1);
mkdirSync('dist/public', { recursive: true });
for (const file of ['index.html', 'styles.css']) copyFileSync(`client/${file}`, `dist/public/${file}`);
