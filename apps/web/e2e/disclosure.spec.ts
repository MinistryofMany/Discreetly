/**
 * Per-room badge disclosure (Phase 1, model 2b) end-to-end.
 *
 * Model 2b: each room join requests from Minister that room's FULL required badge
 * set (a single chosen branch), NOT the not-yet-proven delta - never the whole
 * wallet and never another room's badges. The mock issuer records the authorize
 * `scope` (`/test/authorize-log`) and mints exactly the consented-scope badges,
 * so the requested scope is the ground truth for "what was disclosed". DB truth
 * (MembershipLeaf, ProvenBadge) is asserted via the e2e Prisma client.
 *
 * The cross-room join works despite next-auth v5 beta.31 NOT updating the stored
 * `Account.id_token` on a second sign-in for an already-linked account: the
 * Minister provider's `profile()` callback captures the fresh token at the OAuth
 * callback, records the disclosed badge TYPES into the durable `ProvenBadge`
 * store, and refreshes `Account.id_token` - so the gate's (live token) UNION
 * (durable proven types) admits the second room.
 */
import { test, expect, type Page } from '@playwright/test';
import {
  createIdentity,
  resetData,
  subFor,
  getPrisma,
  unique,
  lastAuthorizeBadgeScopes,
  lastAuthorizeScope,
} from './harness/helpers.js';
import { userKeyForSub } from './harness/gate.js';

const ID_PASSWORD = 'test-password-123';

// Browser RLN proving + OIDC round-trips are slow.
test.setTimeout(180_000);

test.beforeEach(async () => {
  await resetData();
});

interface RoomOpts {
  name: string;
  slug: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  accessPolicy: any;
}

async function createRoom(opts: RoomOpts) {
  const db = getPrisma();
  return db.room.create({
    data: {
      name: opts.name,
      slug: opts.slug,
      rlnIdentifier: String(Date.now()) + String(Math.floor(Math.random() * 1_000_000)),
      rateLimit: 1000,
      userMessageLimit: 100,
      maxDevices: 3,
      visibility: 'PUBLIC',
      encryption: 'PLAINTEXT',
      accessPolicy: opts.accessPolicy,
    },
  });
}

/** Drive the mock consent form (no badge boxes - badges derive from scope). */
async function consent(page: Page, email: string): Promise<void> {
  await page.waitForURL(/\/oidc\/authorize/, { timeout: 30_000 });
  await page.locator('#email').fill(email);
  await page.locator('#approve').click();
  await page.waitForURL((url) => !url.pathname.startsWith('/oidc'), { timeout: 30_000 });
}

/** Open a room and unlock the (already-created) local identity to reveal the JoinPanel. */
async function openRoomUnlocked(page: Page, roomId: string): Promise<void> {
  await page.goto(`/rooms/${roomId}`);
  await page.getByLabel('Password', { exact: true }).fill(ID_PASSWORD);
  await page.getByRole('button', { name: /^unlock$/i }).click();
}

test('joining Room(A) requests only A badge scope; a later Room(A AND B) requests A AND B (2b full set) and still joins', async ({
  page,
}) => {
  const db = getPrisma();
  const email = `disc-delta-${Date.now()}@example.com`;
  const sub = subFor(email);
  const userKey = userKeyForSub(sub);

  const roomA = await createRoom({
    name: 'Age Room',
    slug: unique('age'),
    accessPolicy: { badge: { type: 'age-over-18' } },
  });
  const roomB = await createRoom({
    name: 'Age+Residency Room',
    slug: unique('age-res'),
    accessPolicy: {
      allOf: [{ badge: { type: 'age-over-18' } }, { badge: { type: 'residency-country' } }],
    },
  });

  // --- Spec 1: clean session joins Room(A). Identity first, then room-scoped sign-in. ---
  await createIdentity(page, ID_PASSWORD);
  await openRoomUnlocked(page, roomA.id);
  // The room-scoped "Sign in with Minister" requests only A's badge.
  await page.getByRole('button', { name: /sign in with minister/i }).click();
  await consent(page, email);

  // ASSERT: the authorize requested exactly badge:age-over-18 (and none of the
  // other four badge scopes).
  expect(await lastAuthorizeBadgeScopes()).toEqual(['badge:age-over-18']);

  // Join Room(A): unlock again (the OIDC round-trip dropped in-memory identity).
  await openRoomUnlocked(page, roomA.id);
  await page.getByRole('button', { name: /^join$/i }).click();
  await expect.poll(() => db.membershipLeaf.count({ where: { roomId: roomA.id } })).toBe(1);

  // ProvenBadge now records age-over-18 for this user.
  await expect
    .poll(() => db.provenBadge.count({ where: { userKey, badgeType: 'age-over-18' } }))
    .toBe(1);

  // --- Spec 2: join Room(A AND B). Model 2b -> request the room's FULL set. ---
  await openRoomUnlocked(page, roomB.id);
  // The current session token proves only A, so the room is not satisfied yet;
  // the JoinPanel offers a room-scoped re-sign-in requesting the room's FULL
  // required set (A AND B), not just the not-yet-proven delta.
  await page.getByRole('button', { name: /re-sign in to disclose badges/i }).click();
  await consent(page, email);

  // ASSERT (2b): the new authorize requested the room's FULL set -
  // age-over-18 AND residency-country - and NONE of the other three badge scopes.
  expect(await lastAuthorizeBadgeScopes()).toEqual([
    'badge:age-over-18',
    'badge:residency-country',
  ]);

  // Join Room(B): the gate admits via (live token: age-over-18, residency-country)
  // UNION (durable proven set). The fresh token's badges were captured at the
  // OAuth callback (ProvenBadge + refreshed Account.id_token), so even though
  // next-auth froze the first token, the second room's badges reach the gate.
  // Unlock again post-redirect, then join.
  await openRoomUnlocked(page, roomB.id);
  await page.getByRole('button', { name: /^join$/i }).click();
  await expect.poll(() => db.membershipLeaf.count({ where: { roomId: roomB.id } })).toBe(1);

  // Both badge types are now durably proven for this user (exactly one row each).
  await expect.poll(() => db.provenBadge.count({ where: { userKey } })).toBe(2);
  expect(
    await db.provenBadge.count({ where: { userKey, badgeType: 'age-over-18' } }),
  ).toBe(1);
  expect(
    await db.provenBadge.count({ where: { userKey, badgeType: 'residency-country' } }),
  ).toBe(1);
});

test('F-D: a durable bare-type proof does NOT satisfy a CONSTRAINED leaf - the gate forces a live re-prove', async ({
  page,
}) => {
  // The single most security-critical invariant of the durable store: it carries
  // only a badge TYPE (no attribute values, no issued-at), so it may satisfy a
  // BARE type-only leaf but NEVER a constrained (`where`/`maxAgeDays`) one. A
  // constrained leaf must always re-prove against a live VC. We:
  //   1. join Room A = bare `age-over-18` (records the durable type),
  //   2. overwrite the live session token with a BADGE-FREE global sign-in (the
  //      durable `age-over-18` survives; the live token no longer carries it),
  //   3. attempt Room B = CONSTRAINED `age-over-18` (`where: { threshold: 18 }`):
  //      the durable type alone must DENY (no live VC), then
  //      re-sign-in to disclose the live VC and confirm it JOINS.
  const db = getPrisma();
  const email = `disc-fd-${Date.now()}@example.com`;
  const sub = subFor(email);
  const userKey = userKeyForSub(sub);

  const roomA = await createRoom({
    name: 'Bare Age Room',
    slug: unique('bare-age'),
    accessPolicy: { badge: { type: 'age-over-18' } },
  });
  const roomB = await createRoom({
    name: 'Constrained Age Room',
    slug: unique('constrained-age'),
    // Constrained leaf: predicates on the `threshold` attribute, so it can be
    // satisfied ONLY by a live VC carrying that attribute - never by the durable
    // (attribute-less) proven set. The mock `age-over-18` VC carries
    // `{ threshold: 18 }`, so a live re-prove satisfies it.
    accessPolicy: { badge: { type: 'age-over-18', where: { threshold: 18 } } },
  });

  // --- Step 1: join Room A (bare). Records the durable `age-over-18` type. ---
  await createIdentity(page, ID_PASSWORD);
  await openRoomUnlocked(page, roomA.id);
  await page.getByRole('button', { name: /sign in with minister/i }).click();
  await consent(page, email);
  await openRoomUnlocked(page, roomA.id);
  await page.getByRole('button', { name: /^join$/i }).click();
  await expect.poll(() => db.membershipLeaf.count({ where: { roomId: roomA.id } })).toBe(1);
  await expect
    .poll(() => db.provenBadge.count({ where: { userKey, badgeType: 'age-over-18' } }))
    .toBe(1);

  // --- Step 2: badge-free global sign-in overwrites the live session token. ---
  // The durable proof persists (record-only, never removed); the live token now
  // carries NO `age-over-18` VC, so the only possible source for Room B's
  // constrained leaf would be the (insufficient) durable set. Sign out first (we
  // are still signed in from the Room A flow), then do the badge-free global
  // sign-in from the landing CTA. The `profile()` capture refreshes the stored
  // `Account.id_token` to this badge-free token.
  await page.goto('/');
  await page.getByRole('button', { name: /sign out/i }).click();
  await expect(page.getByRole('button', { name: /sign in with minister/i })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole('button', { name: /sign in with minister/i }).first().click();
  await consent(page, email);
  expect(await lastAuthorizeScope()).toBe('openid profile');
  // Durable proof is still present after the badge-free sign-in.
  expect(await db.provenBadge.count({ where: { userKey, badgeType: 'age-over-18' } })).toBe(1);

  // --- Step 3a: attempt Room B with NO live VC. The durable type must NOT
  // satisfy the constrained leaf - the server gate denies (F-D). ---
  await openRoomUnlocked(page, roomB.id);
  await page.getByRole('button', { name: /^join$/i }).click();
  await expect(page.getByText(/do not satisfy this room/i)).toBeVisible({ timeout: 30_000 });
  // Hard DB truth: no leaf was created for Room B by the durable-only attempt.
  await expect.poll(() => db.membershipLeaf.count({ where: { roomId: roomB.id } })).toBe(0);

  // --- Step 3b: re-sign-in to disclose the LIVE `age-over-18` VC. Now the
  // constrained leaf is satisfied by the live VC and the join succeeds. ---
  await openRoomUnlocked(page, roomB.id);
  await page.getByRole('button', { name: /re-sign in to disclose badges/i }).click();
  await consent(page, email);
  expect(await lastAuthorizeBadgeScopes()).toEqual(['badge:age-over-18']);
  await openRoomUnlocked(page, roomB.id);
  await page.getByRole('button', { name: /^join$/i }).click();
  await expect.poll(() => db.membershipLeaf.count({ where: { roomId: roomB.id } })).toBe(1);
});

test('a missing required badge denies: no leaf, no ProvenBadge', async ({ page }) => {
  const db = getPrisma();
  const email = `disc-deny-${Date.now()}@example.com`;
  const sub = subFor(email);
  const userKey = userKeyForSub(sub);

  // Room requires invite-code, but we will disclose NONE (sign in globally,
  // badge-free) and attempt to join.
  const room = await createRoom({
    name: 'Invite Room',
    slug: unique('invite'),
    accessPolicy: { badge: { type: 'invite-code' } },
  });

  // Global (badge-free) sign-in from the header, then create identity.
  await page.goto('/');
  await page.getByRole('button', { name: /sign in with minister/i }).first().click();
  await consent(page, email);
  await createIdentity(page, ID_PASSWORD);

  // Attempt to join WITHOUT disclosing invite-code: drive Join directly (do not
  // re-sign-in). The gate denies (policy-denied).
  await openRoomUnlocked(page, room.id);
  await page.getByRole('button', { name: /^join$/i }).click();
  await expect(page.getByText(/do not satisfy this room/i)).toBeVisible({ timeout: 30_000 });

  // DB truth: zero leaves and zero ProvenBadge rows for this user.
  await expect.poll(() => db.membershipLeaf.count({ where: { roomId: room.id } })).toBe(0);
  await expect.poll(() => db.provenBadge.count({ where: { userKey } })).toBe(0);
});

test('global sign-in discloses nothing (openid profile only)', async ({ page }) => {
  const email = `disc-global-${Date.now()}@example.com`;

  await page.goto('/');
  await page.getByRole('button', { name: /sign in with minister/i }).first().click();
  await consent(page, email);

  // The top-level sign-in requests exactly `openid profile`.
  expect(await lastAuthorizeScope()).toBe('openid profile');
});

test('OR room (INTERIM): requests a single branch, joins with one badge, one ProvenBadge row', async ({
  page,
}) => {
  const db = getPrisma();
  const email = `disc-or-${Date.now()}@example.com`;
  const sub = subFor(email);
  const userKey = userKeyForSub(sub);

  const room = await createRoom({
    name: 'OR Room',
    slug: unique('or'),
    accessPolicy: {
      anyOf: [{ badge: { type: 'age-over-18' } }, { badge: { type: 'residency-country' } }],
    },
  });

  await createIdentity(page, ID_PASSWORD);
  await openRoomUnlocked(page, room.id);
  await page.getByRole('button', { name: /sign in with minister/i }).click();
  await consent(page, email);

  // ASSERT: exactly one branch requested (the cheapest default = age-over-18),
  // not the union of both branches.
  const badgeScopes = await lastAuthorizeBadgeScopes();
  expect(badgeScopes).toHaveLength(1);
  expect(badgeScopes).toEqual(['badge:age-over-18']);

  // Join succeeds with the single disclosed badge; one ProvenBadge row written.
  await openRoomUnlocked(page, room.id);
  await page.getByRole('button', { name: /^join$/i }).click();
  await expect.poll(() => db.membershipLeaf.count({ where: { roomId: room.id } })).toBe(1);
  await expect.poll(() => db.provenBadge.count({ where: { userKey } })).toBe(1);
  expect(await db.provenBadge.count({ where: { userKey, badgeType: 'age-over-18' } })).toBe(1);
});
