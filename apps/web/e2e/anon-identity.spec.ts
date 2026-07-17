/**
 * One-root anonymous-identity invariants the security audit asked for.
 *
 * 1. Fragment survival: the Ministry `#minister_anon` branch survives the whole
 *    OIDC callback chain (mock 3xx -> Auth.js callback -> landing page) and the
 *    app derives the EXPECTED per-room identity from it - asserted against the
 *    exact commitment recomputed from the delivered branch, not merely that some
 *    identity exists. A client-side redirect anywhere in that chain would destroy
 *    the fragment; this proves it did not.
 *
 * 2. Re-key leaf count: a Ministry re-key (a strictly-greater `minister_anon_epoch`
 *    delivering a NEW branch -> a NEW derived commitment) SWAPS the room's single
 *    leaf in place via the epoch-gated `membership.rotate` (audit finding C1). The
 *    leaf count stays exactly ONE: the replacement swaps, it never multiplies (an
 *    unbounded leaf-multiply would defeat RLN's per-identity rate limit).
 */
import { test, expect } from '@playwright/test';
import { signIn, resetData, subFor, getPrisma, unique } from './harness/helpers.js';
import { expectedCommitment, mintTestToken, rotateMembership } from './harness/anon.js';

// Browser RLN proving + WS round-trips are slow.
test.setTimeout(180_000);

test.beforeEach(async () => {
  await resetData();
});

async function createOpenRoom(name: string, slug: string) {
  const db = getPrisma();
  return db.room.create({
    data: {
      name,
      slug,
      rlnIdentifier: String(Date.now()) + String(Math.floor(Math.random() * 1_000_000)),
      // Long epoch window so CI's slow browser proving can't roll the epoch over.
      rateLimit: 3_600_000,
      userMessageLimit: 100,
      visibility: 'PUBLIC',
      encryption: 'PLAINTEXT',
      accessPolicy: { allOf: [] },
    },
  });
}

test('the #minister_anon fragment survives the OIDC callback chain to the EXPECTED derived identity', async ({
  page,
}) => {
  const db = getPrisma();
  const email = 'frag-survivor@example.com';
  const room = await createOpenRoom('Fragment Room', unique('frag'));

  // Sign in (the mock stamps `#minister_anon` on its 3xx and a signed
  // minister_anon_epoch on the id_token), then open the room and join. The join
  // writes the leaf under the browser-DERIVED identity commitment.
  await signIn(page, { email, name: email });
  await page.goto(`/rooms/${room.id}`);
  await page.getByRole('button', { name: /^join$/i }).click();
  await expect(page.getByPlaceholder(/type a message/i)).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => db.membershipLeaf.count({ where: { roomId: room.id } })).toBe(1);

  // The stored commitment must equal the identity DERIVED from the exact branch
  // the mock delivered - proof the fragment survived the callback chain intact
  // and the app derived the expected identity (not just any identity).
  const leaf = await db.membershipLeaf.findFirstOrThrow({ where: { roomId: room.id } });
  expect(leaf.identityCommitment).toBe(await expectedCommitment(email, room.id, 1));
});

test('an epoch-gated re-key swaps the room leaf in place: exactly one leaf, the new commitment', async ({
  page,
}) => {
  const db = getPrisma();
  const email = 'rekey-user@example.com';
  const sub = subFor(email);
  const room = await createOpenRoom('Re-key Room', unique('rekey'));

  // Sign in at epoch 1 and join: one leaf at the epoch-1 commitment (C1).
  await signIn(page, { email, name: email });
  await page.goto(`/rooms/${room.id}`);
  await page.getByRole('button', { name: /^join$/i }).click();
  await expect(page.getByPlaceholder(/type a message/i)).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => db.membershipLeaf.count({ where: { roomId: room.id } })).toBe(1);

  const c1 = (await db.membershipLeaf.findFirstOrThrow({ where: { roomId: room.id } }))
    .identityCommitment;
  expect(c1).toBe(await expectedCommitment(email, room.id, 1));

  // Ministry re-keys: epoch 2 delivers a NEW branch -> a NEW derived commitment.
  const c2 = await expectedCommitment(email, room.id, 2);
  expect(c2).not.toBe(c1);

  // Drive the epoch-gated swap. The app ships no browser rotate control, so the
  // Ministry-re-key primitive (`membership.rotate`) is exercised directly with an
  // epoch-2 token minted by the SAME running mock issuer (the key the API trusts).
  const token2 = await mintTestToken(sub, 2);
  const res = await rotateMembership({
    roomId: room.id,
    idToken: token2,
    newIdentityCommitment: c2,
  });
  expect(res.ok, `rotate rejected: ${res.reason ?? ''}`).toBe(true);

  // Exactly ONE leaf still - now at C2. The swap replaced the leaf in place; a
  // re-key never adds a second leaf (which would multiply the RLN rate budget).
  expect(await db.membershipLeaf.count({ where: { roomId: room.id } })).toBe(1);
  const after = await db.membershipLeaf.findFirstOrThrow({ where: { roomId: room.id } });
  expect(after.identityCommitment).toBe(c2);
  expect(
    await db.membershipLeaf.count({ where: { roomId: room.id, identityCommitment: c1 } }),
  ).toBe(0);
});
