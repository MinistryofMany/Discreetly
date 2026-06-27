// EXPLORATORY PROTOTYPE - NOT wired into Discreetly.
//
// End-to-end test of the non-authorship moderation circuits:
//   1. Build a depth-20 Semaphore group of member rate-commitments.
//   2. Mint a message tag T_M for the AUTHOR (DESIGN.md Statement S).
//   3. NON-AUTHOR: generate a witness + full Groth16 proof and VERIFY it (PASS).
//   4. AUTHOR: attempt witness generation -> MUST FAIL (diff = 0, no inverse).
//   5. Batch (BATCH-A): non-author clears a 4-message batch (PASS);
//      author of one batch entry fails witness generation (MUST FAIL).
//
// Uses circom (nix) -> already compiled in build/, and snarkjs from the
// Discreetly workspace pnpm store (resolved at runtime).

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  TAG_DOMAIN,
  leafFromSecret,
  tagFromSecret,
  challengeNullifier,
  batchEntry,
  derivedTag,
  modInv,
  sub,
  merkleWitness,
  MERKLE_TREE_DEPTH,
} from './lib.mjs';
import { poseidon3 } from 'poseidon-lite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const BUILD = join(ROOT, 'build');

// Resolve snarkjs from the Discreetly workspace (already vendored there).
const require = createRequire(import.meta.url);
let snarkjs;
const snarkjsCandidates = [
  'snarkjs',
  resolve(ROOT, '../../../Discreetly/node_modules/.pnpm/snarkjs@0.7.6/node_modules/snarkjs/main.cjs'),
];
for (const c of snarkjsCandidates) {
  try {
    snarkjs = require(c);
    break;
  } catch {
    /* try next */
  }
}
if (!snarkjs) throw new Error('could not resolve snarkjs');

let failures = 0;
const ok = (m) => console.log(`  PASS  ${m}`);
const bad = (m) => {
  failures++;
  console.log(`  FAIL  ${m}`);
};

// snarkjs CLI (handles bn128 curve resolution for powers-of-tau).
// Derive the package dir from the resolved main entry (exports map blocks a
// direct subpath require).
const SNARKJS_CLI = join(dirname(require.resolve('snarkjs')), 'cli.cjs');
function sjcli(args) {
  execFileSync(process.execPath, [SNARKJS_CLI, ...args], { stdio: 'pipe' });
}

// ---- snarkjs helpers (groth16, bn128) ----
async function setup(name, power) {
  const r1cs = join(BUILD, `${name}.r1cs`);
  const ptau = join(BUILD, `pot${power}_final.ptau`);
  if (!existsSync(ptau)) {
    const p0 = join(BUILD, `pot${power}_0.ptau`);
    const p1 = join(BUILD, `pot${power}_1.ptau`);
    sjcli(['powersoftau', 'new', 'bn128', String(power), p0, '-v']);
    sjcli(['powersoftau', 'contribute', p0, p1, '--name=proto', '-v', '-e=entropy-1']);
    sjcli(['powersoftau', 'prepare', 'phase2', p1, ptau, '-v']);
  }
  const zkey0 = join(BUILD, `${name}_0.zkey`);
  const zkey = join(BUILD, `${name}.zkey`);
  const vkeyPath = join(BUILD, `${name}_vkey.json`);
  sjcli(['groth16', 'setup', r1cs, ptau, zkey0, '-v']);
  sjcli(['zkey', 'contribute', zkey0, zkey, '--name=proto', '-v', '-e=entropy-2']);
  sjcli(['zkey', 'export', 'verificationkey', zkey, vkeyPath, '-v']);
  const { readFileSync } = await import('node:fs');
  const vkey = JSON.parse(readFileSync(vkeyPath, 'utf8'));
  return { zkey, vkey };
}

// A tiny CommonJS witness runner per circuit (circom's witness_calculator.js is
// CJS; this dir is ESM, so we shell out to a .cjs wrapper). The wrapper exits
// non-zero when an in-circuit constraint is violated (e.g. diff*inv===1 for the
// author) -> exactly the "author cannot generate a witness" signal.
function ensureWitnessRunner(name) {
  const { writeFileSync } = require('node:fs');
  // The circom-emitted witness_calculator.js uses module.exports (CommonJS),
  // but the prototype package.json sets "type":"module" and that propagates
  // into build/. Pin the build js dir back to CommonJS so the .js loads.
  const dirPkg = join(BUILD, `${name}_js`, 'package.json');
  if (!existsSync(dirPkg)) writeFileSync(dirPkg, JSON.stringify({ type: 'commonjs' }));
  const runner = join(BUILD, `${name}_js`, 'run_witness.cjs');
  if (!existsSync(runner)) {
    writeFileSync(
      runner,
      [
        'const wc = require("./witness_calculator.js");',
        'const { readFileSync, writeFileSync } = require("fs");',
        'const [wasm, inp, out] = process.argv.slice(2);',
        'const input = JSON.parse(readFileSync(inp, "utf8"));',
        'wc(readFileSync(wasm)).then(async (c) => {',
        '  const buff = await c.calculateWTNSBin(input, 0);',
        '  writeFileSync(out, buff);',
        '}).catch((e) => { console.error(String(e.message || e)); process.exit(7); });',
        '',
      ].join('\n'),
    );
  }
  return runner;
}

// Generate witness. Throws if the circuit is unsatisfiable for `input`.
async function genWitness(name, input) {
  const { writeFileSync } = require('node:fs');
  const wasm = join(BUILD, `${name}_js`, `${name}.wasm`);
  const runner = ensureWitnessRunner(name);
  const inPath = join(BUILD, `${name}_input.json`);
  const wtns = join(BUILD, `${name}.wtns`);
  writeFileSync(inPath, JSON.stringify(input));
  try {
    execFileSync(process.execPath, [runner, wasm, inPath, wtns], { stdio: 'pipe' });
  } catch (err) {
    const msg = (err.stderr ? err.stderr.toString() : '') || err.message;
    throw new Error(msg.trim() || 'witness generation failed');
  }
  return wtns;
}

async function proveAndVerify(name, vkey, zkey, wtns) {
  const { proof, publicSignals } = await snarkjs.groth16.prove(zkey, wtns);
  const verified = await snarkjs.groth16.verify(vkey, publicSignals, proof);
  return { verified, publicSignals };
}

// stringify all bigints in an input object for snarkjs
function S(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = Array.isArray(v) ? v.map((x) => x.toString()) : v.toString();
  }
  return out;
}

async function main() {
  console.log('ZK non-authorship moderation prototype - e2e test');
  console.log(`TAG_DOMAIN = ${TAG_DOMAIN}`);
  console.log('');

  // ---- shared world: a room with several seated members ----
  const rlnIdentifier = 1234567890n;
  const uml = 10n;
  const sAuthor = 111111111111111n;
  const sNonAuthor = 222222222222222n;
  const sOther = 333333333333333n;

  const leafAuthor = leafFromSecret(sAuthor, uml);
  const leafNon = leafFromSecret(sNonAuthor, uml);
  const leafOther = leafFromSecret(sOther, uml);
  const leaves = [leafAuthor, leafNon, leafOther];

  // ---- mint the message tag T_M for the AUTHOR (Statement S) ----
  const idM = poseidon3([rlnIdentifier, 42n, 7n]); // stands in for Poseidon(roomId, msgSalt)
  const T_M = tagFromSecret(sAuthor, idM);
  const challengeId = 999n;

  // =====================================================================
  // SINGLE-MESSAGE CIRCUIT
  // =====================================================================
  console.log('[single] trusted setup (groth16/bn128)...');
  const single = await setup('nonauthorship', 16);

  // --- NON-AUTHOR: should produce a VALID proof ---
  {
    const mw = merkleWitness(rlnIdentifier, leaves, leafNon);
    const myTag = tagFromSecret(sNonAuthor, idM);
    const tagInv = modInv(sub(myTag, T_M)); // diff != 0 -> invertible
    const input = S({
      root: mw.root,
      idM,
      authorTag: T_M,
      userMessageLimit: uml,
      challengeId,
      identitySecret: sNonAuthor,
      pathElements: mw.pathElements,
      pathIndices: mw.pathIndices,
      tagInv,
    });
    try {
      const wtns = await genWitness('nonauthorship', input);
      const { verified, publicSignals } = await proveAndVerify(
        'nonauthorship',
        single.vkey,
        single.zkey,
        wtns,
      );
      const cn = challengeNullifier(sNonAuthor, challengeId);
      const cnMatch = publicSignals[0] === cn.toString();
      if (verified && cnMatch) ok('non-author produces a VALID non-authorship proof (cn matches)');
      else bad(`non-author proof verify=${verified} cnMatch=${cnMatch}`);
    } catch (err) {
      bad(`non-author witness/proof threw unexpectedly: ${err.message}`);
    }
  }

  // --- AUTHOR: witness generation MUST FAIL (diff = 0, no inverse) ---
  {
    const mw = merkleWitness(rlnIdentifier, leaves, leafAuthor);
    const myTag = tagFromSecret(sAuthor, idM); // == T_M
    let tagInv;
    try {
      tagInv = modInv(sub(myTag, T_M)); // sub == 0 -> throws in JS already
      // If JS somehow yields a value, feed a bogus inverse so the circuit must reject.
    } catch {
      tagInv = 0n; // author cannot supply a valid inverse for 0
    }
    const input = S({
      root: mw.root,
      idM,
      authorTag: T_M,
      userMessageLimit: uml,
      challengeId,
      identitySecret: sAuthor,
      pathElements: mw.pathElements,
      pathIndices: mw.pathIndices,
      tagInv,
    });
    let threw = false;
    try {
      await genWitness('nonauthorship', input);
    } catch (err) {
      threw = true;
      ok(`author CANNOT generate a witness (constraint unsatisfiable): ${firstLine(err.message)}`);
    }
    if (!threw) {
      // last-resort: even if witness gen passed, the proof must fail to verify.
      bad('author unexpectedly produced a witness (should be unsatisfiable)');
    }
  }

  // --- CONTROL A: the author's failure is the TAG inequality, not membership.
  // Same author secret + valid Merkle path, but answering a DIFFERENT message
  // (idM2, T_M2 by someone else) -> they ARE a non-author there and CAN clear.
  {
    const idM2 = poseidon3([rlnIdentifier, 84n, 9n]);
    const T_M2 = tagFromSecret(sOther, idM2); // a message the *other* member wrote
    const mw = merkleWitness(rlnIdentifier, leaves, leafAuthor);
    const myTag = tagFromSecret(sAuthor, idM2);
    const tagInv = modInv(sub(myTag, T_M2));
    const input = S({
      root: mw.root,
      idM: idM2,
      authorTag: T_M2,
      userMessageLimit: uml,
      challengeId,
      identitySecret: sAuthor,
      pathElements: mw.pathElements,
      pathIndices: mw.pathIndices,
      tagInv,
    });
    try {
      const wtns = await genWitness('nonauthorship', input);
      const { verified } = await proveAndVerify('nonauthorship', single.vkey, single.zkey, wtns);
      if (verified)
        ok('control: the SAME member is a valid non-author of a DIFFERENT message (failure was the tag, not membership)');
      else bad('control: member could not clear a message they did not write');
    } catch (err) {
      bad(`control non-author-of-other threw: ${err.message}`);
    }
  }

  // --- CONTROL B: a non-member (secret not in the tree) is rejected even though
  // their tag != T_M -> membership binding holds (DESIGN.md sec 4.4).
  {
    const sOutsider = 444444444444444n;
    // Forge a Merkle path: take a real member's path but use the outsider secret.
    const mw = merkleWitness(rlnIdentifier, leaves, leafNon);
    const myTag = tagFromSecret(sOutsider, idM);
    const tagInv = modInv(sub(myTag, T_M));
    const input = S({
      root: mw.root, // real root
      idM,
      authorTag: T_M,
      userMessageLimit: uml,
      challengeId,
      identitySecret: sOutsider, // NOT the secret behind leafNon
      pathElements: mw.pathElements,
      pathIndices: mw.pathIndices,
      tagInv,
    });
    let rejected = false;
    try {
      await genWitness('nonauthorship', input); // leaf won't hash to root
    } catch {
      rejected = true;
    }
    if (rejected) ok('control: a NON-MEMBER cannot clear (membership binding holds)');
    else bad('control: non-member unexpectedly produced a witness');
  }

  // =====================================================================
  // BATCHED CIRCUIT (BATCH-A), K=4
  // =====================================================================
  console.log('');
  console.log('[batch] trusted setup (groth16/bn128)...');
  const K = 4;
  const batch = await setup('nonauthorship_batch', 16);

  // Build a batch of moderated messages. Authors: entry 0 by sOther, entry 1 by
  // sAuthor, entries 2/3 padding (disabled).
  const batchChallengeId = 555n;
  const idM0 = poseidon3([rlnIdentifier, 1n, 1n]);
  const idM1 = poseidon3([rlnIdentifier, 2n, 2n]);
  const e0 = batchEntry(idM0, tagFromSecret(sOther, idM0));
  const e1 = batchEntry(idM1, tagFromSecret(sAuthor, idM1));
  // padding slots: idM=0, e=1 (per DESIGN.md sec 10.5 sentinel), enabled=0
  const idMs = [idM0, idM1, 0n, 0n];
  const es = [e0, e1, 1n, 1n];
  const enabled = [1n, 1n, 0n, 0n];

  // setDigest = fold over (idM_i, e_i)
  function foldDigest(idMs, es) {
    let acc = 0n;
    for (let i = 0; i < K; i++) acc = poseidon3([acc, idMs[i], es[i]]);
    return acc;
  }
  const setDigest = foldDigest(idMs, es);

  function batchInput(s) {
    const leaf = leafFromSecret(s, uml);
    const mw = merkleWitness(rlnIdentifier, leaves, leaf);
    const invs = [];
    for (let i = 0; i < K; i++) {
      const d = derivedTag(s, idMs[i]);
      const diff = sub(d, es[i]);
      // For enabled slots diff must be != 0 for a non-author; for padding slots
      // diff is generally != 0 too, but enabled=0 makes invs irrelevant.
      invs.push(diff === 0n ? 0n : modInv(diff));
    }
    return {
      mw,
      input: S({
        root: mw.root,
        userMessageLimit: uml,
        challengeBatchId: batchChallengeId,
        setDigest,
        idM: idMs,
        e: es,
        identitySecret: s,
        pathElements: mw.pathElements,
        pathIndices: mw.pathIndices,
        invs,
        enabled,
      }),
    };
  }

  // --- NON-AUTHOR of the whole batch: should PASS ---
  {
    const { input } = batchInput(sNonAuthor);
    try {
      const wtns = await genWitness('nonauthorship_batch', input);
      const { verified, publicSignals } = await proveAndVerify(
        'nonauthorship_batch',
        batch.vkey,
        batch.zkey,
        wtns,
      );
      const cn = challengeNullifier(sNonAuthor, batchChallengeId);
      const cnMatch = publicSignals[0] === cn.toString();
      if (verified && cnMatch)
        ok('non-author clears the whole BATCH in one VALID proof (cn matches)');
      else bad(`batch non-author verify=${verified} cnMatch=${cnMatch}`);
    } catch (err) {
      bad(`batch non-author threw unexpectedly: ${err.message}`);
    }
  }

  // --- AUTHOR of entry 1 (sAuthor): witness generation MUST FAIL ---
  {
    const { input } = batchInput(sAuthor);
    let threw = false;
    try {
      await genWitness('nonauthorship_batch', input);
    } catch (err) {
      threw = true;
      ok(`author of a batch entry CANNOT clear the batch: ${firstLine(err.message)}`);
    }
    if (!threw) bad('batch author unexpectedly produced a witness (should be unsatisfiable)');
  }

  console.log('');
  if (failures === 0) {
    console.log('ALL CHECKS PASSED');
  } else {
    console.log(`${failures} CHECK(S) FAILED`);
  }
  process.exit(failures === 0 ? 0 : 1);
}

function firstLine(s) {
  return String(s).split('\n')[0].slice(0, 120);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
