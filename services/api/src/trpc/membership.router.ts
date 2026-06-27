import { z } from 'zod';
import { prisma } from '@discreetly/db';
import type { PolicyNode } from '@discreetly/policy';
import { router, publicProcedure } from './trpc.js';
import { evaluateGate } from '../gate/gate.js';
import { joinRoom, rotateDevice } from '../membership/membership.js';
import { loadProvenTypes, recordProvenTypes } from '../membership/proven-badges.js';

export const membershipRouter = router({
  join: publicProcedure
    .input(
      z.object({
        roomId: z.string(),
        idToken: z.string(),
        identityCommitment: z.string(),
        deviceLabel: z.string().max(100).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // SECURITY MODEL (M-1, accepted): `membership.join` trusts a bearer
      // `idToken` minted by Minister. The gate re-verifies its signature, issuer,
      // audience, and expiry (`ctx.verify`), but a bearer token presented inside
      // its (~10 min) validity window is replayable - there is no per-request
      // nonce/PoP at this tRPC layer. Anti-replay relies on TLS in transit plus
      // the SHORT token lifetime; the OIDC `nonce` that binds the token to a
      // browser login is enforced upstream at the Auth.js callback (see
      // `apps/web/src/auth.ts`), not here. This is the existing model and is
      // documented in AUDIT.md (M-1).
      const room = await prisma.room.findUnique({ where: { id: input.roomId } });
      if (!room) return { ok: false as const, reason: 'no-room' as const };
      // The gate evaluates the room policy against (live token badges) UNION the
      // user's durable proven badge TYPES (F-D: only bare type-only leaves may be
      // satisfied from the durable store), keyed on the verified `sub`.
      const gate = await evaluateGate({
        idToken: input.idToken,
        rlnIdentifier: BigInt(room.rlnIdentifier),
        policy: room.accessPolicy as unknown as PolicyNode,
        verify: ctx.verify,
        loadProvenTypes,
      });
      if (!gate.allowed) return { ok: false as const, reason: 'policy-denied' as const };
      // Admit + record the newly-verified disclosed badge TYPES atomically: a
      // failed join must not leave an orphan ProvenBadge write, and a recorded
      // proof must always correspond to a real admission. The write is keyed on
      // the verified `sub` (never client input), so it is non-forgeable.
      return prisma.$transaction(async (tx) => {
        const result = await joinRoom({
          room,
          joinNullifier: gate.joinNullifier.toString(),
          identityCommitment: input.identityCommitment,
          deviceLabel: input.deviceLabel,
          tx,
        });
        if (result.ok && gate.tokenBadgeTypes.length > 0) {
          await recordProvenTypes(gate.sub, gate.tokenBadgeTypes, tx);
        }
        return result;
      });
    }),
  // Authoritative durable proven-badge read, so the client can compute a correct
  // join "delta" (request only genuinely-new badges). Verifies a fresh id_token
  // from the Authorization header and keys on the verified `sub`, so it only ever
  // returns predicates to the `sub` that owns them - returning by any
  // client-supplied key would be forgeable.
  provenBadges: publicProcedure.query(async ({ ctx }) => {
    if (!ctx.adminIdToken) return { badgeTypes: [] as string[] };
    let sub: string;
    try {
      ({ sub } = await ctx.verify(ctx.adminIdToken));
    } catch {
      // Invalid/expired token -> disclose nothing (fail closed). The client then
      // computes the delta as "prove everything the room needs".
      return { badgeTypes: [] as string[] };
    }
    const badgeTypes = await loadProvenTypes(sub);
    return { badgeTypes };
  }),
  rotate: publicProcedure
    .input(
      z.object({
        roomId: z.string(),
        idToken: z.string(),
        oldIdentityCommitment: z.string(),
        newIdentityCommitment: z.string(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const room = await prisma.room.findUnique({ where: { id: input.roomId } });
      if (!room) return { ok: false as const, reason: 'no-room' as const };
      // Admission uses the same union-with-durable evaluation as join, so a user
      // who already proved a room's badges can rotate a device without re-proving.
      // Rotation is not a new proof event, so it does not write ProvenBadge.
      const gate = await evaluateGate({
        idToken: input.idToken,
        rlnIdentifier: BigInt(room.rlnIdentifier),
        policy: room.accessPolicy as unknown as PolicyNode,
        verify: ctx.verify,
        loadProvenTypes,
      });
      if (!gate.allowed) return { ok: false as const, reason: 'policy-denied' as const };
      return rotateDevice({
        room,
        joinNullifier: gate.joinNullifier.toString(),
        oldIdentityCommitment: input.oldIdentityCommitment,
        newIdentityCommitment: input.newIdentityCommitment,
      });
    }),
});
