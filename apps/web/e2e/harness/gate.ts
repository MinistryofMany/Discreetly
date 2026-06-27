/**
 * Spec-side access to the API's per-room join-nullifier derivation, so a test can
 * pre-seed a membership keyed by the same `(roomId, joinNullifier)` the backend
 * computes on join. Re-exported from the API source to avoid drift: if the
 * derivation changes there, these specs follow automatically.
 */
import { joinNullifier, toField } from '../../../../services/api/src/gate/join-nullifier.js';

export { joinNullifier };

/**
 * The ProvenBadge `userKey` for a verified pairwise sub: `toField(sub)` as a
 * decimal string, the same reduction the API's proven-badge store uses. Lets a
 * spec scope ProvenBadge assertions to one user. Re-derived from the API source
 * (not duplicated) so it follows any change to the reduction.
 */
export function userKeyForSub(sub: string): string {
  return toField(sub).toString();
}
