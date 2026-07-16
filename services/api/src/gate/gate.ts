import { evaluate, parsePolicy, type PolicyNode } from '@discreetly/policy';
import type { VerifiedIdentityWithEpoch } from '../minister/verify.js';
import { joinNullifier } from './join-nullifier.js';

export interface GateInput {
  idToken: string;
  rlnIdentifier: bigint;
  policy: PolicyNode;
  verify: (idToken: string) => Promise<VerifiedIdentityWithEpoch>;
  now?: number;
}

export interface GateResult {
  allowed: boolean;
  sub: string;
  joinNullifier: bigint;
  /**
   * The verified `minister_anon_epoch` from the id_token (undefined when the
   * token carries no epoch claim). Authorizes an epoch-gated leaf write in
   * `membership.join` / `membership.rotate` (audit finding C1).
   */
  tokenEpoch?: number;
}

/**
 * Verify a Minister id_token and decide room access against the room policy,
 * evaluating the policy INLINE against the freshly-presented token's badges
 * ALONE (Path B / Phase 3). There is no durable proven-badge store and no union:
 * each room-join runs the per-room SDK flow that mints a fresh token carrying the
 * room's minimal satisfying set, and the gate sees only that token.
 *
 * Fork F-D (constrained leaves) is satisfied for free: with no durable set, every
 * leaf - bare or `where`/`maxAgeDays`-constrained - is checked by `evaluate`/
 * `leafSatisfied` against a live, just-verified VC. The whole F-D mechanism
 * existed only to protect constrained leaves from the durable union; removing the
 * union removes the hazard. After admission, Semaphore membership carries access
 * (the badge is a one-time gate).
 */
export async function evaluateGate(input: GateInput): Promise<GateResult> {
  const { sub, badges, minister_anon_epoch } = await input.verify(input.idToken);
  const now = input.now ?? Math.floor(Date.now() / 1000);

  let allowed = false;
  try {
    // Defense-in-depth: re-parse the stored policy before evaluating so a
    // tampered or legacy DB row fails closed via schema validation, not only
    // via evaluate's runtime throw.
    const policy = parsePolicy(input.policy);
    allowed = evaluate(policy, badges, now) === true; // inline, token-only
  } catch {
    // malformed/unrecognized policy => fail closed (deny)
    allowed = false;
  }
  return {
    allowed,
    sub,
    joinNullifier: joinNullifier(sub, input.rlnIdentifier),
    tokenEpoch: minister_anon_epoch,
  };
}
