import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Absolute filesystem path to the RLN circuit wasm (for rlnjs RLNProver in Node). */
export const rlnWasmPath = fileURLToPath(new URL('../artifacts/rln/circuit.wasm', import.meta.url));

/** Absolute filesystem path to the RLN proving key (for rlnjs RLNProver in Node). */
export const rlnZkeyPath = fileURLToPath(new URL('../artifacts/rln/final.zkey', import.meta.url));

/** Parsed RLN Groth16 verification key (for rlnjs RLNVerifier). */
export const rlnVerificationKey: unknown = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../artifacts/rln/verification_key.json', import.meta.url)),
    'utf8',
  ),
);
