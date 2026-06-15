import { describe, it, expect } from 'vitest';
import { makeProofCtx, proofFor } from '../test/rln-fixtures.js';
import { verifyMessage } from './verify-message.js';

describe('verifyMessage', () => {
  it('accepts a valid proof and returns the proof-bound epoch + nullifier', async () => {
    const ctx = makeProofCtx();
    const proof = await proofFor(ctx, 'hello world', 42n);
    const res = await verifyMessage({
      rlnIdentifier: ctx.rlnIdentifier,
      proof,
      content: 'hello world',
      leaves: ctx.leaves,
      currentEpoch: 42n,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.epoch).toBe(42n);
      expect(res.nullifier).toBeTruthy();
    }
  });

  it('rejects when content does not match the proof signal', async () => {
    const ctx = makeProofCtx();
    const proof = await proofFor(ctx, 'hello world', 42n);
    const res = await verifyMessage({
      rlnIdentifier: ctx.rlnIdentifier,
      proof,
      content: 'tampered',
      leaves: ctx.leaves,
      currentEpoch: 42n,
    });
    expect(res).toMatchObject({ ok: false, reason: 'bad-signal' });
  });

  it('returns bad-proof (does not throw) on a malformed proof envelope', async () => {
    const ctx = makeProofCtx();
    const res = await verifyMessage({
      rlnIdentifier: ctx.rlnIdentifier,
      // Empty object: no epoch / snarkProof.publicSignals.
      proof: {} as never,
      content: 'hi',
      leaves: ctx.leaves,
      currentEpoch: 42n,
    });
    expect(res).toMatchObject({ ok: false, reason: 'bad-proof' });
  });

  it('rejects an out-of-window epoch', async () => {
    const ctx = makeProofCtx();
    const proof = await proofFor(ctx, 'hi', 42n);
    const res = await verifyMessage({
      rlnIdentifier: ctx.rlnIdentifier,
      proof,
      content: 'hi',
      leaves: ctx.leaves,
      currentEpoch: 100n,
    });
    expect(res).toMatchObject({ ok: false, reason: 'bad-epoch' });
  });
});
