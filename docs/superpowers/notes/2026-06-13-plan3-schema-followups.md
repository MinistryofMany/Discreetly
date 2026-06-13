# Plan 3 (backend) schema follow-ups

Items surfaced during the Foundation code-quality review of `@discreetly/db` that were deliberately deferred to Plan 3, where the gate / message-pipeline / ban query patterns become concrete. Adding indexes/constraints to an empty dev database via migration is free, so these are best added once the real access paths exist (and aimed at the right columns).

When writing Plan 3, fold these into the first schema-extension task and decide each against the actual queries:

- **Ban lookup index.** Add an index matching how the gate actually checks bans. Join-time check is by `(roomId, joinNullifier)` — already indexed. If the message/forensic path ever queries bans by `rateCommitment`, add `@@index([roomId, rateCommitment])` then.
- **Ban dedup semantics.** Decide explicitly: event-log (append-only, query via `EXISTS`, duplicates allowed — current implicit model) vs deduped record (partial `@@unique` on non-null `joinNullifier` / `rateCommitment`). Pick one when the ban write path is implemented.
- **`MembershipLeaf.identityCommitment` index.** Add `@@index([roomId, identityCommitment])` only if the verification/ban-recovery path looks leaves up by `identityCommitment` rather than by the already-unique `rateCommitment`.
- **`Membership` ↔ `Ban` linkage.** The `MembershipStatus.BANNED` enum value and the separate `Ban` table are currently disconnected by design. When implementing bans, either add a `banId` FK on `Membership` or a schema comment so the relationship is self-documenting.
- **`AuditLog` indexes.** Add `@@index([actor])` / `@@index([action])` when the admin UI's audit queries are defined (Plan 4).

Also for the eventual monorepo `CLAUDE.md`: document the **internal-TS-package pattern** — packages expose `./src/index.ts` via `main`/`exports` and are resolved as source through `moduleResolution: "Bundler"`. There is intentionally no build step and no TS project references; do not "fix" this by adding a build step or `composite`, which would break source resolution.
