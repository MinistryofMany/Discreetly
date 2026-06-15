import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const verifierPath = join(here, 'rln-verify.mts');

function verifyInNode(payload: { proof: unknown }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', verifierPath], {
      cwd: join(here, '..'),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', () => {
      if (err.trim().length > 0) {
        // tsx may emit warnings; only reject on a hard ERROR line.
        if (err.includes('ERROR')) {
          reject(new Error(`verifier stderr: ${err}`));
          return;
        }
      }
      resolve(out.trim());
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

test('browser generates an RLN proof that the node verifier accepts', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('pageerror', (e) => consoleErrors.push(e.message));

  await page.goto('/dev/rln-spike');
  await expect(page.locator('#run-spike')).toBeVisible();

  await page.locator('#run-spike').click();

  // Proving in-browser (wasm + snark) can take a while; poll the status.
  await expect(page.locator('#spike-status')).toContainText(/done|error/, { timeout: 90_000 });

  const status = await page.locator('#spike-status').innerText();
  const detail = await page.locator('#spike-detail').innerText();
  expect(status, `spike failed in browser: ${detail}`).toContain('done');

  const proofJson = await page.evaluate(
    () => (window as unknown as { __rlnSpikeProof?: string }).__rlnSpikeProof,
  );
  expect(proofJson, 'browser did not expose a proof').toBeTruthy();

  const proof = JSON.parse(proofJson as string);
  expect(proof.snarkProof?.publicSignals?.root).toBeTruthy();

  const result = await verifyInNode({ proof });
  expect(result, 'node verifier rejected the browser proof').toBe('VALID');

  expect(consoleErrors, `browser page errors: ${consoleErrors.join('; ')}`).toEqual([]);
});
