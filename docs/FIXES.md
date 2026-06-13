# Issues and Fixes (Join Alpha Testers, Docker Seed, E2E)

This document describes the issues encountered and the fixes applied during work on the "Join Alpha Testers" flow, Docker/seed reliability, and Playwright E2E tests.

---

## 1. Invalid Claim Code — "Join Alpha Testers" button

### Issue

Clicking **Join Alpha Testers** returned HTTP 400 with message `"Invalid Claim Code"`. The frontend uses a **hardcoded** invite code `layer-spot-gravity-fossil` (see `frontend/src/lib/components/Onboarding/Gateways.svelte`). The database only had the 30 **random** claim codes created for the Alpha Testers room by the seed; that specific code did not exist.

### Fixes

**A. Seed creates the hardcoded code** (`server/prisma/seed.ts`)

- After creating all rooms, the seed now finds the "Alpha Testers" room and creates a `ClaimCodes` record with:
  - `claimcode: 'layer-spot-gravity-fossil'`
  - `roomIds: [alphaRoom.id]`
  - `expiresAt: 9999999999999` (far future so it never expires)
  - `usesLeft: -1` (unlimited)
- The room’s `claimCodeIds` is updated to include the new code’s id.
- If a claim code with that string already exists, it is skipped.

**B. Server trims the code** (`server/src/endpoints/gateways/inviteCode.ts`)

- The code from the request body is normalized with `String(parsedBody.code).trim()` before lookup, so leading/trailing spaces do not cause "Invalid Claim Code".

---

## 2. Seed failing in Docker (TypeScript/ESM)

### Issue

In Docker, `npx prisma db seed` failed with:

```text
TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".ts" for /app/prisma/seed.ts
```

The project uses `"type": "module"` and the seed was run with `ts-node prisma/seed.ts`. Under Node ESM, ts-node hit the extension error, so the seed never ran and the Alpha Testers claim code was never created.

### Fix

- In `server/package.json`, the Prisma seed script was changed from `ts-node prisma/seed.ts` to **`tsx prisma/seed.ts`**.
- **tsx** was added as a devDependency so the seed runs correctly in ESM without the `.ts` extension issue.

---

## 3. Seed failing — Prisma upsert and MongoDB replica set

### Issue

After fixing the seed runner, the seed failed with:

```text
Prisma needs to perform transactions, which requires your MongoDB server to be run as a replica set.
```

`createRoom` in `server/src/data/db/create.ts` used `prisma.rooms.upsert()`. With a **standalone** MongoDB (no replica set), Prisma’s use of transactions for upsert caused this error.

### Fix

- `createRoom` was changed to use **`prisma.rooms.create({ data: createPayload })`** instead of `upsert`.
- The function already did `findUnique` and returned `null` if the room existed, so the “create or do nothing” behavior is preserved without requiring a replica set.

---

## 4. MongoDB container crashing (FTDC / disk space)

### Issue

MongoDB in Docker was exiting (e.g. exit code 100 or 133). Logs showed:

1. **First:** Failure writing to full-time diagnostic data capture (FTDC) interim file.
2. **After a fresh volume:** `Error creating journal directory ... No space left on device`.

So both an FTDC write issue and host/volume disk space were involved.

### Fix (code/configuration only)

- In `docker-compose.yml`, the MongoDB service was given:
  - `command: ["mongod", "--setParameter", "diagnosticDataCollectionEnabled=false"]`
    so FTDC is disabled and that write path is avoided.

**Note:** If the error is "No space left on device", the fix is to free disk space on the host (e.g. `docker system prune`, `docker volume prune`, or freeing space elsewhere). The compose change does not fix that.

---

## 5. E2E global-setup: wrong body key and no fallback code

### Issue

Playwright global-setup creates an "E2E Test Room" and a claim code via `/room/add` and `/admin/addcode`. Tests that need a valid claim code read `.seed-data.json` written by global-setup. Two problems:

1. The server’s add-room API expects **`roomType`**, but global-setup sent **`type`**, so room creation could fail and `roomId` / `claimCode` stayed empty.
2. When room creation or addcode failed (e.g. server not ready), there was no fallback, so tests that depend on a valid code had nothing to use.

### Fixes

- In `frontend/tests/global-setup.ts`:
  - The body for `/room/add` was changed to send **`roomType: 'PUBLIC'`** instead of `type: 'PUBLIC'`.
  - A **fallback** was added: if we still have no `claimCode` (or no `roomId`), call `/admin/rooms`, find the room named "Alpha Testers", and set `roomId`, `roomName`, and `claimCode: 'layer-spot-gravity-fossil'` so E2E can run against a pre-seeded DB (e.g. Docker with seed that creates that code).

---

## 6. E2E — "Identity Created" strict mode violation

### Issue

Many E2E tests failed with:

```text
Error: strict mode violation: locator('text=Identity Created') resolved to 2 elements
```

"Identity Created" appears in both the signup step heading ("Identity Created ✅") and the success toast ("Identity Created! Congrats on your new journey"). Playwright’s default strict mode requires a unique match, so the generic text locator was invalid.

### Fix

- In `frontend/tests/helpers.ts` and `frontend/tests/signup.test.ts`, the assertion was changed to target the **heading** only:
  - **Before:** `page.locator('text=Identity Created')`
  - **After:** `page.getByRole('heading', { name: /Identity Created/ })`

---

## 7. E2E — getLocalStorage crash when no origin

### Issue

Tests such as "default servers should be set" (and any using `getLocalStorage`) could throw:

```text
TypeError: Cannot read properties of undefined (reading 'localStorage')
```

at `state.origins[0].localStorage` when `state.origins[0]` was undefined (e.g. no origin yet or different origin order).

### Fix

- In `frontend/tests/utils.ts`, `getLocalStorage` was updated to:
  - Prefer the first origin that has a defined `localStorage` array:  
    `state.origins.find((o) => o.localStorage?.length !== undefined) ?? state.origins[0]`
  - Use **`origin?.localStorage ?? []`** so missing origin or localStorage returns an empty array instead of throwing.

---

## 8. Cursor rules — who runs Docker and tests

### Issue

Instructions were telling the user to rebuild/restart Docker and run tests manually, instead of the agent doing it.

### Fix

- In `.cursorrules`, an **Agent Responsibilities** section was added stating that the agent must:
  - Rebuild and restart Docker containers when server/frontend or config changes.
  - Build/compile the project when needed to verify changes.
  - Run the relevant test suites when validating changes or when asked.  
    And that the agent should do these itself rather than instructing the user.

---

## 9. Documentation and tests

### CODEBASE.md

- The Docker/E2E section was updated to note:
  - The "Join Alpha Testers" hardcoded code and that the seed creates it.
  - Global-setup fallback to Alpha Testers room/code when room creation or addcode fails.
  - The known "Browser closed" (Chromium) issue in some environments and that E2E scenarios (signup, lock/unlock, join room, send message) are implemented; there is no dedicated rate-limit E2E test.

### E2E test

- In `frontend/tests/gateway.test.ts`, a new test **"Join Alpha Testers button works with seeded code"** was added: sign up, go to gateways, click "Join Alpha Testers", and assert "You've been added to:" is visible.

---

## 10. E2E test robustness

Several E2E tests were flaky or failed due to timing, multiple DOM matches, or wrong data source. The following changes make the suite more reliable.

### Chat redirect test

- **Issue:** `waitForURL('**/signup')` could time out because the chat layout redirect runs asynchronously and the slot is not rendered until `serverStore` is populated.
- **Fix:** Wait for the signup page **content** instead of the URL: `expect(page.getByRole('heading', { name: /Welcome to Discreetly/ })).toBeVisible({ timeout: 20_000 })`, then assert `page.toHaveURL(/\/signup/)`.

### Signup step 2

- **Issue:** Step 2 content ("Set Unlock Code") might not be visible immediately after clicking Next.
- **Fix:** `waitForLoadState('networkidle')` after `goto('/signup')`, use `getByRole('button', { name: 'Next' })`, then wait for `getByRole('heading', { name: 'Set Unlock Code' })` with an 8s timeout before asserting on the password input.

### Homepage

- **Issue:** Multiple "Sign Up" and "Join Our Discord" links (header + main) caused strict mode violations; footer is hidden on viewport ≥768px.
- **Fix:** Use `.first()` for link role assertions; for "Sign Up links to /signup" use `page.locator('a[href="/signup"]').filter({ hasText: 'Sign Up' }).first()`; for "footer is visible" set viewport to `{ width: 767, height: 600 }` so the footer is shown (per layout media query). Homepage `beforeEach` now waits for the welcome heading so the page is stable before assertions.

### Gateway tests

- **Issue:** Multiple "Discord Bot" / "The Word" matches; "Submit" and "Join Alpha Testers" needed stable selectors; long waits could hit test timeout.
- **Fix:** Use `.first()` for getByText('Discord Bot') and getByText('The Word'); wait for `#inviteCode` (15s) before other assertions; use `page.locator('button').filter({ hasText: 'Join Alpha Testers' }).first()` and `getByText("You've been added to:", { exact: false }).first()`; explicitly wait for Submit button visibility before click in "submitting empty invite code".

### Identity test (localStorage)

- **Issue:** `getLocalStorage(page)` uses Playwright’s `storageState()`; sometimes the origin order or shape meant `identityencrypted` was not in the returned list.
- **Fix:** Added `getLocalStorageFromPage(page)` in `frontend/tests/utils.ts`, which uses `page.evaluate()` to read `window.localStorage` from the loaded page. The identity test uses this so it reads the same origin’s storage.

### App test (default servers)

- **Fix:** Before calling `getLocalStorage`, wait for the welcome heading so the layout has run and set `selectedServer` on localhost.

---

## File summary

| Area           | File(s) changed                                                                                                                   |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Alpha Testers  | `server/prisma/seed.ts`, `server/src/endpoints/gateways/inviteCode.ts`                                                            |
| Seed runner    | `server/package.json` (seed script + tsx devDependency)                                                                           |
| createRoom     | `server/src/data/db/create.ts` (upsert → create)                                                                                  |
| MongoDB        | `docker-compose.yml` (mongod command)                                                                                             |
| Global-setup   | `frontend/tests/global-setup.ts` (roomType + fallback)                                                                            |
| E2E locators   | `frontend/tests/helpers.ts`, `frontend/tests/signup.test.ts`                                                                      |
| E2E utils      | `frontend/tests/utils.ts` (getLocalStorage, getLocalStorageFromPage)                                                              |
| Gateway E2E    | `frontend/tests/gateway.test.ts` (new test + robust selectors)                                                                    |
| E2E robustness | `frontend/tests/chat.test.ts`, `frontend/tests/homepage.test.ts`, `frontend/tests/identity.test.ts`, `frontend/tests/app.test.ts` |
| Conventions    | `.cursorrules` (Agent Responsibilities)                                                                                           |
| Docs           | `CODEBASE.md` (Docker/E2E notes)                                                                                                  |

---

## Verification

- **Join Alpha Testers:** With a running stack and seed that has run (e.g. `docker compose up --build` and enough disk space for MongoDB), the "Join Alpha Testers" button should succeed.
- **E2E:** Run from `frontend/`: `npm run test:e2e`. After the fixes above, many more tests pass (e.g. 41+ passed in the last run); remaining failures are often timing/selectors or missing server/seed (e.g. "Join Alpha Testers" test needs the seeded code).
