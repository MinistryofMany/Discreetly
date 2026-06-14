// Ambient module declarations for crypto deps that ship runtime code but no
// resolvable types under moduleResolution:"Bundler" (their package.json exports
// maps omit a "types" condition). Consumers of @discreetly/crypto reference this
// file in their tsconfig "include".
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
