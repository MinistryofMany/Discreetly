import { evaluateWithProven, parsePolicy, type PolicyNode } from '@discreetly/policy';
import type { VerifiedIdentity } from '../minister/verify.js';
import { joinNullifier } from './join-nullifier.js';

export interface GateInput {
  idToken: string;
  rlnIdentifier: bigint;
  policy: PolicyNode;
  verify: (idToken: string) => Promise<VerifiedIdentity>;
  /**
   * Load the durable proven badge TYPES for a verified `sub`. Injected so the
   * gate stays unit-testable and the router can wire it to the ProvenBadge
   * store. Omit (default empty) to evaluate against the token alone.
   */
  loadProvenTypes?: (sub: string) => Promise<readonly string[]>;
  now?: number;
}

export interface GateResult {
  allowed: boolean;
  sub: string;
  joinNullifier: bigint;
  /** Verified badge types carried by the presented token (to record as proven). */
  tokenBadgeTypes: string[];
}

/**
 * Verify a Minister id_token and decide room access against the room policy,
 * evaluating the policy against (live token badges) UNION (the user's durable
 * proven badge types). Fork F-D is enforced inside `evaluateWithProven`: a
 * constrained leaf (`where`/`maxAgeDays`) can never be satisfied from the durable
 * store - only bare type-only leaves can. The durable store therefore can only
 * shrink disclosure, never over-admit.
 */
export async function evaluateGate(input: GateInput): Promise<GateResult> {
  const { sub, badges } = await input.verify(input.idToken);
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const tokenBadgeTypes = [...new Set(badges.map((b) => b.type))];

  let allowed = false;
  try {
    // Defense-in-depth: re-parse the stored policy before evaluating so a
    // tampered or legacy DB row fails closed via schema validation, not only
    // via evaluate's runtime throw.
    const policy = parsePolicy(input.policy);
    // The durable proven set is loaded only after the token is verified, so its
    // key (`sub`) is non-forgeable. A load failure must fail closed (deny), not
    // silently widen to "no proven types".
    const provenTypes = new Set(input.loadProvenTypes ? await input.loadProvenTypes(sub) : []);
    allowed = evaluateWithProven(policy, badges, provenTypes, now) === true;
  } catch {
    // malformed/unrecognized policy or a proven-set load failure => fail closed
    allowed = false;
  }
  return { allowed, sub, joinNullifier: joinNullifier(sub, input.rlnIdentifier), tokenBadgeTypes };
}
