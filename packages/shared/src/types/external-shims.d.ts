// Ambient module declarations for crypto deps that ship runtime code but no
// resolvable types under moduleResolution:"Bundler" (their package.json exports
// maps omit a "types" condition). Referenced from the api/web tsconfig
// "include"; the RLN math itself now lives in @ministryofmany/rln, which carries
// its own internal shims.
declare module 'ffjavascript' {
  export class ZqField {
    constructor(p: bigint);
    add(a: bigint, b: bigint): bigint;
    sub(a: bigint, b: bigint): bigint;
    mul(a: bigint, b: bigint): bigint;
    div(a: bigint, b: bigint): bigint;
    normalize(a: bigint): bigint;
  }
}

declare module '@semaphore-protocol/group' {
  export type MerkleProof = {
    root: bigint | string;
    leaf: bigint | string;
    siblings: (bigint | string)[];
    pathIndices: number[];
  };
  export class Group {
    constructor(id: bigint | number | string, treeDepth?: number, members?: (bigint | string)[]);
    readonly root: bigint | string;
    indexOf(member: bigint | string): number;
    generateMerkleProof(index: number): MerkleProof;
  }
}
