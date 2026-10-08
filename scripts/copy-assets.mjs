import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcUi = resolve(root, 'src', 'ui');
const distUi = resolve(root, 'dist', 'ui');

if (!existsSync(distUi)) {
  mkdirSync(distUi, { recursive: true });
}

for (const file of ['index.html', 'app.js', 'app.css', 'favicon.svg']) {
  const src = resolve(srcUi, file);
  const dest = resolve(distUi, file);
  if (existsSync(src)) {
    cpSync(src, dest);
  }
}
