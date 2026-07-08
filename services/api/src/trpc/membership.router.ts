import { z } from 'zod';
import { prisma } from '@discreetly/db';
import type { PolicyNode } from '@discreetly/policy';
import { router, publicProcedure } from './trpc.js';
import { evaluateGate } from '../gate/gate.js';
import { joinRoom, rotateDevice } from '../membership/membership.js';

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
      // per-room sign-in is enforced upstream by the SDK-run flow's callback
      // (`apps/web/src/app/api/room-auth/callback`, via `exchangeCode`), not here.
      // This is the existing model and is documented in AUDIT.md (M-1).
      const room = await prisma.room.findUnique({ where: { id: input.roomId } });
      if (!room) return { ok: false as const, reason: 'no-room' as const };
      // The gate evaluates the room policy INLINE against the freshly-presented
      // token's badges alone (Path B): no durable proven store, no union. The
      // per-room SDK flow mints a fresh token carrying the room's minimal
      // satisfying set; the gate sees only that token (keyed on the verified
      // `sub`). After admission, Semaphore membership carries access.
      const gate = await evaluateGate({
        idToken: input.idToken,
        rlnIdentifier: BigInt(room.rlnIdentifier),
        policy: room.accessPolicy as unknown as PolicyNode,
        verify: ctx.verify,
      });
      if (!gate.allowed) return { ok: false as const, reason: 'policy-denied' as const };
      const joined = await joinRoom({
        room,
        joinNullifier: gate.joinNullifier.toString(),
        identityCommitment: input.identityCommitment,
        deviceLabel: input.deviceLabel,
      });
      if (!joined.ok) return joined;
      // Return the caller's OWN room pseudonym (derived server-side from their
      // verified sub). The stock client stores it locally and attaches it to
      // message.send as the client-asserted moderation link (ban-author path).
      return { ...joined, joinNullifier: gate.joinNullifier.toString() };
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
      // Admission uses the same inline token-only evaluation as join: rotation
      // re-presents a per-room token whose badges must satisfy the policy.
      const gate = await evaluateGate({
        idToken: input.idToken,
        rlnIdentifier: BigInt(room.rlnIdentifier),
        policy: room.accessPolicy as unknown as PolicyNode,
        verify: ctx.verify,
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
