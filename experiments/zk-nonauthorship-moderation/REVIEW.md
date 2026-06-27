# Adversarial soundness review — verdict: NOT SOUND as designed

> **Read this before trusting the prototype.** The prototype's test suite passes,
> but it only exercises the *honest* author (one identity, honest `enabled[]`).
> An adversarial reviewer **empirically broke the scheme** with real, verifying
> Groth16 proofs against the actual compiled circuits. Do not turn this on. Do
> not treat the green tests as evidence the scheme works.

## The breaks (both demonstrated with passing proofs)

**Break 1 — Sybil / multi-seat (CRITICAL, the whole ballgame).**
The circuit binds the answer to *a* leaf the prover owns (`rc = Poseidon(Poseidon(s), uml) ∈ R`), never to *the* leaf that authored `M`, and never to *all* seats the human controls. Discreetly is open anonymous join with no one-identity-per-person rule — and multi-device deliberately gives one person several seats. So the author of `M` (sent under seat `s1`) simply answers the non-authorship challenge with a **second** seat `s2`: `Poseidon(DOM, s2, idM) ≠ T_M` is true, the `≠` gadget is satisfiable, the proof verifies, and they publish a normal-looking `cn`. The author clears their own challenge; nothing is excluded. Verified with a real proof.

**Break 2 — batch `enabled[]` unbound (CRITICAL).**
In `nonauthorship_batch.circom`, each per-entry non-equality is gated by a **private** witness `enabled[i]`, but `setDigest` folds only `(idM_i, e_i)` and never commits to `enabled[]`. The author of entry `j` submits `enabled[j]=0`: the incriminating constraint vanishes, the digest is byte-identical, the proof verifies. Every author clears any batch, for any `k`, with no second identity needed. Verified with a real proof.

**Break 3 — root cause (architectural).** There is no binding between the answering seat and the authoring seat anywhere in the construction. Statement S (the send-time tag binding) is unbuilt in the prototype, and even fully built it only pins `T_M ↔ s1` — it does nothing to force the *answerer* to range over *every* seat the human owns. Anonymous membership + per-seat answers + free multi-registration = unfixable at the circuit level.

## Partials (privacy / griefing)
- **Break 4:** the R1 roll-call reuses `cn = Poseidon(s, challengeId)` across both the non-authorship and presence proofs, so the server links every clearance to an already-public `rc` — more linkage than the design claims (not catastrophic; `rc` is public).
- **Break 5:** the churn defense rests entirely on BATCH-A, which Break 2 invalidates, so the mass-flag → `O(k)`-proofs griefing lever is fully open. Replay is handled; the live-root check is only prose and must be made strict.
- Tag unlinkability and frame-an-honest-member resistance **do** hold (the latter is moot — the author just clears).

## Top fixes, in order (1–3 are blocking)
1. **Sybil is the gate.** Without a hard one-identity-per-person anchor — which Discreetly lacks and which contradicts its anonymity model — non-authorship-by-exclusion is unsalvageable. This is a **product** question before any circuit work.
2. **Bind `enabled[]` into `setDigest`** (or drop per-slot enable and pad with provably-non-equal sentinels), so disabling a real entry changes the public commitment.
3. **Actually build + enforce Statement S**, and state the one-seat-per-author assumption it silently requires.
4. Domain-separate R1's presence nullifier from the non-authorship nullifier.
5. Make the live-root check normative and bind proofs to a fresh epoch nonce.

## What this means
The scheme as conceived does not work in Discreetly's model. It would only be viable with a one-identity-per-person anchor that the anonymity model deliberately rejects. This reinforces the two open product questions already in `DESIGN.md`: **does Discreetly want content bans at all**, and if rooms are ephemeral (history kept only weeks), does offending content age out before this would ever matter? On current evidence the answer is to keep this OFF and lean on ephemeral history + the existing per-room admin ban / RLN slashing instead.
