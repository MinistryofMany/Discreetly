import { evaluate, parsePolicy, type PolicyNode } from '@discreetly/policy';
import type { VerifiedIdentity } from '../minister/verify.js';
import { joinNullifier } from './join-nullifier.js';

export interface GateInput {
  idToken: string;
  rlnIdentifier: bigint;
  policy: PolicyNode;
  verify: (idToken: string) => Promise<VerifiedIdentity>;
  now?: number;
}

export interface GateResult {
  allowed: boolean;
  sub: string;
  joinNullifier: bigint;
}

/** Verify a Minister id_token and decide room access against the room policy. */
export async function evaluateGate(input: GateInput): Promise<GateResult> {
  const { sub, badges } = await input.verify(input.idToken);
  const now = input.now ?? Math.floor(Date.now() / 1000);
  let allowed = false;
  try {
    // Defense-in-depth: re-parse the stored policy before evaluating so a
    // tampered or legacy DB row fails closed via schema validation, not only
    // via evaluate's runtime throw.
    const policy = parsePolicy(input.policy);
    allowed = evaluate(policy, badges, now) === true;
  } catch {
    // malformed/unrecognized policy => fail closed (deny)
    allowed = false;
  }
  return { allowed, sub, joinNullifier: joinNullifier(sub, input.rlnIdentifier) };
}
