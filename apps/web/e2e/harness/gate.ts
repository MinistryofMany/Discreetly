/**
 * Spec-side access to the API's per-room join-nullifier derivation, so a test can
 * pre-seed a membership keyed by the same `(roomId, joinNullifier)` the backend
 * computes on join. Re-exported from the API source to avoid drift: if the
 * derivation changes there, these specs follow automatically.
 */
export { joinNullifier } from '../../../../services/api/src/gate/join-nullifier.js';
