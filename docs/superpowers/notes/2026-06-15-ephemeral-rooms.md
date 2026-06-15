# Ephemeral rooms (transport-only relay)

## Model

A room with `persistence === 'EPHEMERAL'` is a pure transport relay. A message
is verified, fanned out over Redis pub/sub to whoever is subscribed RIGHT NOW,
and then forgotten:

- No `Message` row is ever written. There is no history and nothing to restore.
- A client that connects later sees only messages sent after it connected.
  Closing the tab loses the feed.
- `message.router.ts` `message.list` returns `[]` for non-PERSISTENT rooms, so
  the web client's history backfill is empty - no late-joiner backfill.

PERSISTENT rooms keep their exact prior behavior: verify -> `checkCollision`
(DB) -> `prisma.message.create` (with the P2002 backstop) -> publish.

## Why a transient collision store is still required

RLN rate-limiting/bans must keep working in ephemeral rooms. The bandwidth-share
recovery scheme needs the server to remember the cryptographic share point
(`x:y`) each nullifier emitted in the current epoch:

- Same nullifier, same `x` -> duplicate (drop, no re-broadcast).
- Same nullifier, different `x` -> the user signed two different messages under
  one rate-limit slot -> Shamir-recover their secret and ban them.

In PERSISTENT rooms this state is implicit in the `Message` rows. EPHEMERAL rooms
write no rows, so we keep a separate, content-free record of just the points.

## Design: atomic transient Redis record

`services/api/src/messaging/ephemeral-collision.ts`,
`checkEphemeralCollision({ roomId, epoch, nullifier, x, y, ttlMs })`, returns the
same union as `collision.ts` (`{kind:'new'|'duplicate'|'collision', prior?}`).

- Key: `eph:nul:<roomId>:<epoch>:<nullifier>`
- Value: `"<x>:<y>"` (cryptographic points only - never message content)
- Lua (single atomic op, run via the existing `publisher()` ioredis client):

  ```
  local p=redis.call('GET',KEYS[1]); if p then return p end;
  redis.call('SET',KEYS[1],ARGV[1],'PX',ARGV[2]); return false
  ```

  - Reply is a string (the prior `x:y`) -> parse: `priorX === x` => `duplicate`,
    else `collision` with `{x:priorX, y:priorY}`.
  - Reply is `false` (ioredis maps it to `null`) -> `new`; the point is now
    recorded by the same call.

This is race-free: two concurrent sends for the same nullifier cannot both see
`new`, because GET-or-SET is one atomic script. (The prior legacy ephemeral store
keyed on the unbound client `message.epoch`; here `epoch` is the proof-bound
value returned by `verifyMessage`, closing that dedup-bypass gap.)

## TTL rationale

`ttlMs = room.rateLimit * 4`. `rateLimit` is the epoch width in ms. The verifier
accepts a proof whose epoch is within +/-1 of the current epoch (a 3-epoch-wide
window). A point recorded at the trailing edge of that window must remain visible
across every epoch in which a colliding proof could still be accepted; 4x the
epoch width covers the 3-epoch window with margin. After expiry the record is
GC'd automatically by Redis - no sweeper needed - and the nullifier's slot is
naturally fresh once its epochs are no longer acceptable.

## Bans persist

Collisions in ephemeral rooms route through the same `handleCollision` ->
`banOnCollision` path as persistent rooms. A `Ban` row + `Membership.status =
BANNED` + pruned (`revokedAt`) leaves are written. Bans are membership state, not
messages, so they are durable regardless of room persistence.

## Tests

- `services/api/src/messaging/pipeline.ephemeral.test.ts` (real RLN proof):
  valid send -> `{status:'sent'}`, broadcast received by a live subscriber,
  `message.count` is 0; same proof again -> `{status:'duplicate'}` with no
  re-broadcast, still 0 rows; collision -> `{status:'banned'}`, membership
  BANNED + `Ban` row + leaves pruned, still 0 `Message` rows. Transient Redis
  keys are purged in `afterAll`.
- `apps/web/e2e/ephemeral.spec.ts`: live subscriber connected at send time
  receives the message; `db.message.count` stays 0; a page opened after the send
  sees an empty feed (no backfill).
