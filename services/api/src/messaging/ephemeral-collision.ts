import { publisher } from '../realtime/redis.js';
import type { CollisionCheck } from './collision.js';

/**
 * Transient, race-free RLN collision check for EPHEMERAL rooms.
 *
 * EPHEMERAL rooms persist NO message rows, so there is no DB record to dedup
 * against. RLN rate-limiting still requires the server to remember the
 * cryptographic share point (`x:y`) emitted by each nullifier for the current
 * epoch, so a second send under the same nullifier can be classified as a
 * duplicate (same `x`) or a collision (different `x` => spam => ban). We store
 * ONLY those points - never message content - under an auto-expiring Redis key.
 *
 * Key:   eph:nul:<roomId>:<epoch>:<nullifier>
 * Value: "<x>:<y>"
 *
 * The check-and-record is a single atomic Lua script (GET-or-SET-with-PX), so
 * two concurrent sends for the same nullifier cannot both observe "new".
 */
const CHECK_AND_RECORD = `local p=redis.call('GET',KEYS[1]); if p then return p end; redis.call('SET',KEYS[1],ARGV[1],'PX',ARGV[2]); return false`;

export interface EphemeralCollisionInput {
  roomId: string;
  epoch: bigint;
  nullifier: string;
  x: string;
  y: string;
  /** Auto-expiry for the point record, in milliseconds. */
  ttlMs: number;
}

export async function checkEphemeralCollision(
  input: EphemeralCollisionInput,
): Promise<CollisionCheck> {
  const key = `eph:nul:${input.roomId}:${input.epoch}:${input.nullifier}`;
  const value = `${input.x}:${input.y}`;
  const ttl = Math.max(1, Math.floor(input.ttlMs));

  // ioredis maps Lua `false` to `null`. A non-null reply is the prior "x:y".
  const prior = (await publisher().eval(CHECK_AND_RECORD, 1, key, value, String(ttl))) as
    | string
    | null;

  if (prior == null) return { kind: 'new' };

  const sep = prior.indexOf(':');
  const priorX = sep === -1 ? prior : prior.slice(0, sep);
  const priorY = sep === -1 ? '' : prior.slice(sep + 1);
  if (priorX === input.x) return { kind: 'duplicate' };
  return { kind: 'collision', prior: { x: priorX, y: priorY } };
}
