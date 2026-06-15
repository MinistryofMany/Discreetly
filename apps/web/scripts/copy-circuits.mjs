import { copyFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const src = join(repoRoot, 'packages', 'circuits', 'artifacts', 'rln');
const dest = join(here, '..', 'public', 'circuits', 'rln');

const files = ['circuit.wasm', 'final.zkey'];

await mkdir(dest, { recursive: true });

for (const file of files) {
  const from = join(src, file);
  if (!existsSync(from)) {
    console.error(`[copy-circuits] missing artifact: ${from}`);
    process.exit(1);
  }
  await copyFile(from, join(dest, file));
  console.log(`[copy-circuits] ${file} -> public/circuits/rln/${file}`);
}
