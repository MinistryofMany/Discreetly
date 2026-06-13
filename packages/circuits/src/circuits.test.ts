import { describe, it, expect } from 'vitest';
import { statSync } from 'node:fs';
import { rlnWasmPath, rlnZkeyPath, rlnVerificationKey } from './index.js';

describe('@discreetly/circuits RLN artifacts', () => {
  it('resolves wasm and zkey to real, non-trivial files', () => {
    expect(statSync(rlnWasmPath).size).toBeGreaterThan(1_000_000);
    expect(statSync(rlnZkeyPath).size).toBeGreaterThan(1_000_000);
  });

  it('exposes a groth16 verification key with 5 public signals', () => {
    const vk = rlnVerificationKey as { protocol: string; curve: string; nPublic: number };
    expect(vk.protocol).toBe('groth16');
    expect(vk.curve).toBe('bn128');
    expect(vk.nPublic).toBe(5);
  });
});
