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
