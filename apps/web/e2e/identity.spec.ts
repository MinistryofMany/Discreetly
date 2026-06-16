import { test, expect, type Page } from '@playwright/test';

const PASSWORD = 'correct horse battery staple';

// The identity commitment is masked by default behind a Reveal toggle; click it
// (when present) so the digits render before we read or compare them.
async function revealCommitment(page: Page): Promise<void> {
  const reveal = page.getByRole('button', { name: /^reveal$/i });
  if (await reveal.isVisible().catch(() => false)) await reveal.click();
}

test.describe('identity panel', () => {
  test('create, lock, wrong-password reject, unlock', async ({ page }) => {
    await page.goto('/identity');

    // Create.
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: /^create identity$/i }).click();
    await expect(page.getByText('Unlocked', { exact: true })).toBeVisible();
    await revealCommitment(page);
    const commitment = await page.locator('text=commitment:').innerText();
    expect(commitment).toMatch(/commitment: \d+/);

    // Lock -> stored, locked state.
    await page.getByRole('button', { name: /^lock$/i }).click();
    await expect(page.getByText(/an encrypted identity is stored on this device/i)).toBeVisible();

    // Wrong password is rejected (sonner toast, stays locked).
    await page.getByLabel('Password').fill('wrong-password');
    await page.getByRole('button', { name: /^unlock$/i }).click();
    await expect(page.getByText(/incorrect password|wrong password/i)).toBeVisible();
    await expect(page.getByText('Unlocked', { exact: true })).toBeHidden();

    // Correct password unlocks and restores the same commitment.
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: /^unlock$/i }).click();
    await expect(page.getByText('Unlocked', { exact: true })).toBeVisible();
    await revealCommitment(page);
    await expect(page.locator('text=commitment:')).toHaveText(commitment);
  });

  test('export backup downloads, import restores, remove clears', async ({ page, context }) => {
    await page.goto('/identity');
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: /^create identity$/i }).click();
    await expect(page.getByText('Unlocked', { exact: true })).toBeVisible();
    const commitment = await page.locator('text=commitment:').innerText();

    // Export -> a JSON download is produced; capture its bytes for re-import.
    await page.getByLabel('Password').fill(PASSWORD);
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: /export backup/i }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/discreetly-identity-.*\.json/);
    const path = await download.path();
    const fs = await import('node:fs/promises');
    const backupJson = await fs.readFile(path, 'utf8');
    expect(JSON.parse(backupJson)).toHaveProperty('ciphertext');

    // Remove from device (confirm dialog auto-accepted).
    page.once('dialog', (d) => void d.accept());
    await page.getByRole('button', { name: /remove from device/i }).click();
    await expect(page.getByText(/no identity yet/i)).toBeVisible();

    // Import the backup file into a clean device.
    await page.getByLabel('Password').fill(PASSWORD);
    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: /import backup/i }).click();
    const chooser = await fileChooserPromise;
    await chooser.setFiles({
      name: 'backup.json',
      mimeType: 'application/json',
      buffer: Buffer.from(backupJson),
    });

    // Save the imported identity, then confirm the commitment round-trips.
    await page.getByRole('button', { name: /save to this device/i }).click();
    await expect(page.getByText('Unlocked', { exact: true })).toBeVisible();
    await expect(page.locator('text=commitment:')).toHaveText(commitment);

    // context kept to satisfy fixture signature; localStorage is per-page here.
    void context;
  });
});
