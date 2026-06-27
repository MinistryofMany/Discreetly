/**
 * Per-room badge disclosure (Phase 3 / Path B) end-to-end - the INLINE,
 * grant-based, SDK-run model.
 *
 * Each room-join runs the framework-agnostic `@minister/client` auth-code+PKCE
 * flow at dedicated RP routes (`/api/room-auth/start` + `/api/room-auth/callback`),
 * NOT Auth.js's third-`signIn`-arg merge. The start route requests the room's
 * UNION badge scope plus a `minister_policy` AST; the mock issuer (simulating
 * Minister's grant) discloses ONE minimal satisfying set and mints a FRESH
 * per-room id_token; the callback verifies it and hands it back to the gate,
 * which evaluates the room policy INLINE on that token alone.
 *
 * There is NO durable RP badge store: the `ProvenBadge` table has been DROPped,
 * so a later room with a not-yet-disclosed-this-flow badge requires a fresh
 * room-scoped sign-in and admits on the fresh token. After admission, Semaphore
 * membership (`MembershipLeaf`) carries access.
 *
 * The over-disclosure-to-RP invariant is asserted via the mock issuer's
 * authorize log (the requested scope) and the minted disclosure: a UNION scope
 * never becomes a UNION disclosure - Minister discloses exactly one minimal
 * satisfying set per room.
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
  lastAuthorizeHasMinisterPolicy,
  grantedTypesFor,
} from './harness/helpers.js';

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

/**
 * Run the per-room disclosure flow for `roomId`: click the room-scoped sign-in,
 * consent at the mock issuer, and land back on the room with the fresh per-room
 * token picked up. After this returns the JoinPanel shows the "Join" button.
 */
async function discloseForRoom(page: Page, roomId: string, email: string): Promise<void> {
  await openRoomUnlocked(page, roomId);
  // Either the first-time "Sign in with Minister" or the "Sign in to disclose
  // badges" button starts the SDK flow; both navigate to /api/room-auth/start.
  const signIn = page.getByRole('button', { name: /sign in (with minister|to disclose badges)/i });
  await signIn.first().click();
  await consent(page, email);
  // Back on the room with `?roomAuthPickup=...`; RoomView picks the fresh
  // per-room token up ONCE and stashes it in sessionStorage keyed by roomId.
  // Wait for that stash to land BEFORE the unlock reload (the pickup row is
  // single-use; navigating away before it lands would lose the token).
  await page.waitForURL(new RegExp(`/rooms/${roomId}`), { timeout: 30_000 });
  await page.waitForFunction(
    (key) => window.sessionStorage.getItem(key) !== null,
    `roomToken:${roomId}`,
    { timeout: 30_000 },
  );
  // Re-unlock (the OIDC round-trip dropped the in-memory identity) to reveal the
  // Join button; RoomView restores the stashed token on remount.
  await openRoomUnlocked(page, roomId);
}

test('join Room(A) discloses only {A}; a later Room(A AND B) needs a fresh disclosure of {A,B} and admits inline', async ({
  page,
}) => {
  const db = getPrisma();
  const email = `disc-inline-${Date.now()}@example.com`;

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

  await createIdentity(page, ID_PASSWORD);

  // --- Room A: disclose {age-over-18} and join inline. ---
  await discloseForRoom(page, roomA.id, email);
  // The authorize requested exactly badge:age-over-18.
  expect(await lastAuthorizeBadgeScopes()).toEqual(['badge:age-over-18']);
  await page.getByRole('button', { name: /^join$/i }).click();
  await expect.poll(() => db.membershipLeaf.count({ where: { roomId: roomA.id } })).toBe(1);

  // --- Room B (A AND B): a fresh per-room disclosure of the FULL set. ---
  // No durable store carries A forward, so the gate needs the fresh token to
  // carry BOTH types. The start route requests the room's UNION scope.
  await discloseForRoom(page, roomB.id, email);
  // ASSERT: the authorize requested the room's FULL set (A AND B) and NOTHING
  // else - one minimal satisfying set, never the whole wallet.
  expect(await lastAuthorizeBadgeScopes()).toEqual([
    'badge:age-over-18',
    'badge:residency-country',
  ]);
  expect(await lastAuthorizeHasMinisterPolicy()).toBe(true);

  // Join Room B inline on the fresh token carrying {age-over-18, residency-country}.
  await page.getByRole('button', { name: /^join$/i }).click();
  await expect.poll(() => db.membershipLeaf.count({ where: { roomId: roomB.id } })).toBe(1);
});

test('NO durable RP badge store exists: the ProvenBadge table is gone', async () => {
  const db = getPrisma();
  // The model was deleted and DROPped; the Prisma client has no `provenBadge`
  // delegate, and the table does not exist in the database.
  expect((db as unknown as Record<string, unknown>).provenBadge).toBeUndefined();
  const rows = await db.$queryRawUnsafe<Array<{ exists: boolean }>>(
    `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'ProvenBadge') AS exists`,
  );
  expect(rows[0]?.exists).toBe(false);
});

test('a CONSTRAINED leaf admits only via the live VC in the fresh token (F-D, inline)', async ({
  page,
}) => {
  // F-D is automatic under Path B: with no durable union, every leaf - bare or
  // constrained - is checked against the just-verified live token. A constrained
  // `age-over-18` (where: { threshold: 18 }) admits because the mock VC carries
  // that attribute; the same fresh-token flow supplies it.
  const db = getPrisma();
  const email = `disc-fd-${Date.now()}@example.com`;

  const room = await createRoom({
    name: 'Constrained Age Room',
    slug: unique('constrained-age'),
    accessPolicy: { badge: { type: 'age-over-18', where: { threshold: 18 } } },
  });

  await createIdentity(page, ID_PASSWORD);
  await discloseForRoom(page, room.id, email);
  expect(await lastAuthorizeBadgeScopes()).toEqual(['badge:age-over-18']);
  await page.getByRole('button', { name: /^join$/i }).click();
  await expect.poll(() => db.membershipLeaf.count({ where: { roomId: room.id } })).toBe(1);
});

test('a missing required badge denies inline: no leaf is created', async ({ page }) => {
  const db = getPrisma();
  const email = `disc-deny-${Date.now()}@example.com`;

  // Room requires invite-code; the user signs in globally (badge-free) and
  // attempts to join WITHOUT running the room disclosure - the gate denies.
  const room = await createRoom({
    name: 'Invite Room',
    slug: unique('invite'),
    accessPolicy: { badge: { type: 'invite-code' } },
  });

  // Global (badge-free) header sign-in, then identity.
  await page.goto('/');
  await page.getByRole('button', { name: /sign in with minister/i }).first().click();
  await consent(page, email);
  await createIdentity(page, ID_PASSWORD);

  // Attempt Join directly with only the badge-free global session token.
  await openRoomUnlocked(page, room.id);
  await page.getByRole('button', { name: /^join$/i }).click();
  await expect(page.getByText(/do not satisfy this room/i)).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => db.membershipLeaf.count({ where: { roomId: room.id } })).toBe(0);
});

test('global header sign-in discloses nothing (openid profile only)', async ({ page }) => {
  const email = `disc-global-${Date.now()}@example.com`;

  await page.goto('/');
  await page.getByRole('button', { name: /sign in with minister/i }).first().click();
  await consent(page, email);

  // The top-level header sign-in (Auth.js `ministerProvider`) requests exactly
  // `openid profile` - it owns ONLY the badge-free global login.
  expect(await lastAuthorizeScope()).toBe('openid profile');
});

test('OR room: the per-room authorize sends the UNION scope + minister_policy; Minister discloses exactly ONE branch', async ({
  page,
}) => {
  const db = getPrisma();
  const email = `disc-or-${Date.now()}@example.com`;

  const room = await createRoom({
    name: 'OR Room',
    slug: unique('or'),
    accessPolicy: {
      anyOf: [{ badge: { type: 'age-over-18' } }, { badge: { type: 'residency-country' } }],
    },
  });

  await createIdentity(page, ID_PASSWORD);
  await discloseForRoom(page, room.id, email);

  // The authorize carried the UNION of both candidate types AND a minister_policy
  // param so Minister (the mock) selects the branch.
  expect(await lastAuthorizeBadgeScopes()).toEqual([
    'badge:age-over-18',
    'badge:residency-country',
  ]);
  expect(await lastAuthorizeHasMinisterPolicy()).toBe(true);

  // Join succeeds inline. The over-disclosure invariant: even though BOTH types
  // were in scope, the mock issuer disclosed exactly ONE branch (the most-
  // anonymous: age-over-18). The grant the mock recorded therefore holds only
  // age-over-18, never the union.
  await page.getByRole('button', { name: /^join$/i }).click();
  await expect.poll(() => db.membershipLeaf.count({ where: { roomId: room.id } })).toBe(1);
  expect(await grantedTypesFor(subFor(email))).toEqual(['age-over-18']);
});

test('transparency grant: a repeat authorize for the same client surfaces the already-granted types', async ({
  page,
}) => {
  // The grant lives on Minister (the IdP), not the RP - Discreetly keeps NO
  // durable badge store. We assert the Discreetly-observable consequence: after
  // disclosing {age-over-18} to this client once, the mock issuer (simulating
  // Minister's per-(user,client) grant) reports age-over-18 as already granted,
  // which is what drives the transparency "already proven to this platform"
  // section at the next authorize. A second room that ALSO needs age-over-18 plus
  // a new residency-country discloses both on a fresh token and admits inline.
  const db = getPrisma();
  const email = `disc-grant-${Date.now()}@example.com`;
  const sub = subFor(email);

  const roomA = await createRoom({
    name: 'Grant Age Room',
    slug: unique('grant-age'),
    accessPolicy: { badge: { type: 'age-over-18' } },
  });
  const roomB = await createRoom({
    name: 'Grant Age+Res Room',
    slug: unique('grant-age-res'),
    accessPolicy: {
      allOf: [{ badge: { type: 'age-over-18' } }, { badge: { type: 'residency-country' } }],
    },
  });

  await createIdentity(page, ID_PASSWORD);

  // Room A: disclose {age-over-18}. The grant now records age-over-18.
  await discloseForRoom(page, roomA.id, email);
  await page.getByRole('button', { name: /^join$/i }).click();
  await expect.poll(() => db.membershipLeaf.count({ where: { roomId: roomA.id } })).toBe(1);
  expect(await grantedTypesFor(sub)).toEqual(['age-over-18']);

  // Room B: needs {age-over-18, residency-country}. The repeat authorize shows
  // age-over-18 as already granted (transparency) AND residency-country as new;
  // the mock issuer discloses BOTH on the fresh token and the gate admits inline.
  await discloseForRoom(page, roomB.id, email);
  expect(await lastAuthorizeBadgeScopes()).toEqual([
    'badge:age-over-18',
    'badge:residency-country',
  ]);
  await page.getByRole('button', { name: /^join$/i }).click();
  await expect.poll(() => db.membershipLeaf.count({ where: { roomId: roomB.id } })).toBe(1);

  // The grant is the monotone union of everything proven to this client.
  expect(await grantedTypesFor(sub)).toEqual(['age-over-18', 'residency-country']);
});
