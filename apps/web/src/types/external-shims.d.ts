// Ambient declarations for deps that ship runtime + .d.ts but whose package.json
// `exports` maps omit a resolvable "types" condition under
// moduleResolution:"bundler". Mirrors packages/shared/src/types/external-shims.d.ts.

declare module '@semaphore-protocol/identity' {
  export class Identity {
    constructor(identityOrMessage?: string);
    readonly trapdoor: bigint;
    readonly nullifier: bigint;
    readonly secret: bigint;
    readonly commitment: bigint;
    getTrapdoor(): bigint;
    getNullifier(): bigint;
    getSecret(): bigint;
    getCommitment(): bigint;
    toString(): string;
  }
}

declare module 'rlnjs' {
  export type StrBigInt = string | bigint;
  export type RLNPublicSignals = {
    x: StrBigInt;
    externalNullifier: StrBigInt;
    y: StrBigInt;
    root: StrBigInt;
    nullifier: StrBigInt;
  };
  export type RLNSNARKProof = {
    proof: {
      pi_a: StrBigInt[];
      pi_b: StrBigInt[][];
      pi_c: StrBigInt[];
      protocol: string;
      curve: string;
    };
    publicSignals: RLNPublicSignals;
  };
  export type RLNFullProof = {
    snarkProof: RLNSNARKProof;
    epoch: bigint;
    rlnIdentifier: bigint;
  };
  export type VerificationKey = {
    protocol: string;
    curve: string;
    nPublic: number;
    vk_alpha_1: string[];
    vk_beta_2: string[][];
    vk_gamma_2: string[][];
    vk_delta_2: string[][];
    vk_alphabeta_12: string[][][];
    IC: string[][];
  };
  export class RLNProver {
    constructor(wasmFilePath: string | Uint8Array, finalZkeyPath: string | Uint8Array);
    generateProof(args: {
      rlnIdentifier: bigint;
      identitySecret: bigint;
      userMessageLimit: bigint;
      messageId: bigint;
      merkleProof: { root: StrBigInt; leaf: StrBigInt; siblings: StrBigInt[]; pathIndices: number[] };
      x: bigint;
      epoch: bigint;
    }): Promise<RLNFullProof>;
  }
  export class RLNVerifier {
    constructor(verificationKey: VerificationKey);
    verifyProof(rlnIdentifier: bigint, rlnFullProof: RLNFullProof): Promise<boolean>;
  }
}
