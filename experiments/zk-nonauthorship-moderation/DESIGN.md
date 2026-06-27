# ZK Non-Authorship Moderation for Discreetly — Design (EXPLORATORY)

> **STATUS: EXPLORATORY DESIGN ONLY. DO NOT WIRE INTO THE LIVE APP.**
>
> This document designs a hypothetical moderation scheme for the Discreetly
> anonymous group-chat app. It is a research artifact for evaluation by the
> product owner. **Nothing here is implemented, enabled, or approved for the live
> system.** The scheme requires a *new message-envelope field*, a *second proving
> circuit*, and a *new moderation/challenge subsystem*, none of which exist today.
> Any prototype must live entirely behind a disabled feature flag in a throwaway
> branch and must never touch the production send/verify path. See
> [§9 Integration sketch (KEPT OFF)](#9-integration-sketch-kept-off) and
> [§11 Open product questions](#11-open-product-questions) — note in particular
> that the product may not want content bans at all, and that ephemeral room
> retention may make this entire feature unnecessary.

---

## 0. The idea, restated and made rigorous

Messages in Discreetly are anonymous: a poster proves Semaphore membership +
RLN rate-limiting, and the stored envelope carries **no stable per-message author
tag** (today: `{ epoch, rlnNullifier (per-epoch), content, proof, sessionColor }`).

The product owner's idea inverts the moderation burden. To moderate a flagged
message `M` **without deanonymizing anyone**:

> Ask *every* member to produce a ZK proof that they did **not** author `M`.
> The actual author is the one member who *cannot* produce a valid
> non-authorship proof. They are identified only **by exclusion** — they fail to
> clear the challenge and lose standing — and no one ever learns who they are.

To make "non-authorship of a specific message" a *provable* statement, the system
must mint, at send time, a **per-message author tag** `T_M` that is:

1. **Bound** to the poster's identity secret `s` (only the true author can have
   produced it), and
2. **Unlinkable** across messages (it must not let anyone cluster a poster's
   messages, which would silently deanonymize them).

The non-authorship proof is then a proof of the negation: *"the tag I would
produce for `M` is not `T_M`."* This document specifies `T_M`, the exact ZK
statements (both the augmented send-time proof and the non-authorship proof),
the soundness arguments, the exclusion/revocation semantics, a **batched**
variant to survive churn, the threat model, and a precise circuit spec for a
prototyper.

A crucial, easy-to-miss point drives the whole construction:

> **Non-authorship is only meaningful if authorship was *committed* at send
> time.** `T_M` must have been published *by `M` itself*, and `M`'s send-time
> proof must have proven that `T_M` was computed from the *same* secret `s` whose
> rate-commitment sits in the group Merkle tree. Without that binding, the true
> author could simply lie ("my tag for `M` isn't `T_M`") and clear the
> challenge. So this scheme is **not** a pure add-on to the current envelope: it
> requires augmenting the *send* circuit too. This is called out explicitly
> throughout.

---

## 1. Background: the identity & crypto model we must reuse (verified against source)

All of the following is read from the live Discreetly source so the new circuits
stay byte-compatible with deployed conventions. Field is BN254 scalar field
`p = 21888242871839275222246405745257275088548364400416034343698204186575808495617`.
All hashes are Poseidon over this field (`poseidon-lite` / circomlib `Poseidon`).

| Quantity | Definition | Source |
| --- | --- | --- |
| Identity secret | `s` (Semaphore: `s = Poseidon(nullifier, trapdoor)`) | `rlnjs/src/common.ts` `calculateIdentitySecret` |
| Identity commitment | `idc = Poseidon(s)` | `packages/crypto/src/shamir.ts` `getIdentityCommitmentFromSecret`, `RLN2DHCircuit/.../idcNullifier.circom` |
| Rate commitment (Merkle **leaf**) | `rc = Poseidon(idc, userMessageLimit)` | `packages/crypto/src/field.ts` `getRateCommitmentHash`; `rlnjs` `calculateRateCommitment` |
| Group Merkle tree | depth **20**, leaves = rate commitments, root `R` | `packages/crypto/src/rln/merkle.ts` `MERKLE_TREE_DEPTH = 20` |
| RLN external nullifier | `extNull = Poseidon(epoch, rlnIdentifier)` | `rlnjs` `calculateExternalNullifier` |
| RLN per-epoch nullifier | `nullifier = Poseidon(a1)` where `a1 = Poseidon(s, extNull, messageId)` (RLN v2) | `rlnjs` circuit (public signal `nullifier`) |
| RLN share | `x = signalHash(content)`, `y = s + a1·x` (Shamir line) | `verify-message.ts`, `shamir.ts` |
| Signal hash | `x = keccak256(utf8(content)) >> 8` | `packages/crypto/src/signal-hash.ts` |
| Revocation primitive | resolve leaf by `rc` → set `Membership.status = BANNED` → prune all its leaves → write `Ban` row | `services/api/src/admin/ban-admin.ts` `banMembershipByLeaf` |

Key implications the design leans on:

- The Merkle **leaf is the rate commitment** `rc = Poseidon(Poseidon(s), userMessageLimit)`.
  Any membership proof (including non-authorship) must open the tree at a leaf and
  re-derive `rc` from a private `s` and the public `userMessageLimit`. This is the
  **binding to the group** that stops a member lying about their secret (§4).
- The existing RLN per-epoch `nullifier` is **per-epoch, not per-message-author**:
  it is the same for every message a user sends in one epoch and changes every
  epoch. It is therefore *useless* as a stable per-message author tag and as an
  unlinkable one. We need a **new** tag. (This is exactly why the envelope "carries
  no stable per-message author tag" today.)
- Revocation already operates by `rateCommitment` and prunes the whole membership.
  The exclusion outcome (§5) reuses `banMembershipByLeaf` unchanged in spirit.

---

## 2. The per-message author tag `T_M`

### 2.1 Requirements

`T_M` is a single field element published in the envelope of message `M`. It must
satisfy:

- **(Author-binding)** `T_M = F(s, idM)` for a fixed function `F`, where `s` is
  the poster's identity secret and `idM` is a per-message identifier. Only a party
  knowing `s` can have produced `T_M`.
- **(Soundness anchor)** At send time, `M`'s proof attests that `T_M = F(s, idM)`
  for the *same* `s` whose `rc = Poseidon(Poseidon(s), uml)` is a leaf of `R`.
  Without this, `T_M` is an unbound number and the whole scheme collapses (§1).
- **(Unlinkability)** Given `T_{M}` and `T_{M'}` for two messages by the same or
  different authors, no PPT adversary can decide "same author" better than guessing.
- **(Determinism / soundness of the negation)** `F(·, idM)` is a *deterministic
  function of `s`* for fixed `idM` — there is exactly one correct `T_M` per
  `(s, idM)`. Otherwise a non-author could not be *forced* to a value, and the
  author could not be *pinned* to `T_M`.

> Determinism vs. unlinkability are in tension: a deterministic function of `s`
> alone leaks linkage. We resolve it by binding to a **public, per-message,
> server-chosen** `idM` (see §2.3): `F` is deterministic in `s` *given `idM`*, and
> `idM` is fresh and independent per message, so outputs are unlinkable across
> messages while remaining a hard-pinned target within one message.

### 2.2 Construction

```
idM   = Poseidon(roomId_F, msgSalt)           // public, per-message identifier
T_M   = Poseidon(s, idM)                       // per-message author tag
```

where:

- `roomId_F` is the room's `rlnIdentifier` (already a field element).
- `msgSalt` is a **fresh, server-assigned** random field element minted by the API
  when `M` is accepted (NOT client-chosen — see §2.3 and §10 for why). It is stored
  on the `Message` row and is public.
- `idM` is therefore a public, unpredictable-at-send-time, per-message value.

`T_M` is **author-binding** (knows `s`), **deterministic given `idM`** (exactly one
`T_M` per `(s, idM)`), and **unlinkable** across messages: `Poseidon` is a PRF-like
hash; with independent `idM` per message, `{T_M}` are pseudorandom and
indistinguishable from fresh random elements without `s` (formally, under the
standard "Poseidon is a random oracle / PRF" heuristic used throughout
RLN/Semaphore). Two tags by the same author share no extractable relation because
each is `H(s, ·)` at a different, independent second argument.

> **Domain separation.** To avoid any cross-protocol collision with the existing
> RLN nullifier (`Poseidon(a1)`) or rate commitment, prepend a constant domain tag:
> `T_M = Poseidon(TAG_DOMAIN, s, idM)` with `TAG_DOMAIN = "discreetly/nonauth/v1"`
> reduced to a field element. The circuit spec (§10) uses the 3-input form.

### 2.3 Why `msgSalt` is server-assigned (a real soundness requirement)

If the *client* chose `msgSalt` (hence `idM`), a malicious author could pick `idM`
adaptively so that `T_M` collides with some honest member's tag for that `idM`, or
pick structure that helps them later equivocate. Worse, a client-chosen salt
reintroduces a grinding surface. By having the **server mint a fresh random
`msgSalt` after** receiving the send proof, `idM` is unpredictable to the author at
proving time *for the binding check*, which we accommodate as follows:

There are two clean ways to bind `T_M` to `idM` at send time; the design picks (B):

- **(A) Server salt known before proving.** Server issues `msgSalt` as a
  short-lived challenge *before* the client proves; client includes `T_M` and proves
  `T_M = Poseidon(TAG_DOMAIN, s, Poseidon(roomId, msgSalt))`. Costs a round trip.
- **(B) Two-layer tag (chosen).** Client commits at send time to a *secret-only*
  base tag `B = Poseidon(TAG_DOMAIN, s, roomId)` and proves it is bound to its leaf
  `rc`. The server later derives the per-message public tag as
  `T_M = Poseidon(B, msgSalt)` with server-minted `msgSalt`. **Problem:** `B` is
  stable per `(s, room)` and is itself a perfect linker. So (B) as stated leaks.
  We therefore use **(B′)**.

- **(B′) Per-message tag, salt folded into the proof via a commitment (chosen).**
  Keep `T_M = Poseidon(TAG_DOMAIN, s, idM)` with `idM = Poseidon(roomId, msgSalt)`,
  and make `msgSalt` server-assigned by splitting it:
  `msgSalt = Poseidon(clientNonce, serverNonce)`. The client picks a hidden
  `clientNonce`, proves `T_M = Poseidon(TAG_DOMAIN, s, Poseidon(roomId, Poseidon(clientNonce, serverNonce)))`
  where `serverNonce` is delivered as a pre-send challenge (one cheap round trip,
  reusing the existing WS channel), and `clientNonce` stays private. This makes
  `idM` jointly random (neither party controls it), unpredictable, fresh per
  message, and still fully bound inside the send proof. Unlinkability holds because
  `idM` is independent per message; author-pinning holds because the server's
  contribution prevents the author from precomputing collisions.

> For the **circuit spec in §10** we present the simplest sound variant — option
> (A), server-salt-known-before-proving — because it yields the cleanest circuit
> (`idM` is a public input). (B′) is the recommended *protocol* hardening and only
> changes how `idM` is formed from nonces; the in-circuit constraint
> `T_M == Poseidon(TAG_DOMAIN, s, idM)` is identical. The prototyper should
> implement (A) first and layer (B′)'s nonce-split on top if grinding is a concern.

---

## 3. The two ZK statements

This scheme needs **two** circuits. The first is a *prerequisite* (it mints the
binding); the second is the actual moderation proof.

### 3.1 Augmented send proof (`SendWithTag`) — the prerequisite

When posting `M`, in addition to (or fused with) the existing RLN proof, the
poster proves:

> **Statement S.** "I know an identity secret `s` and a Merkle path such that
> `rc = Poseidon(Poseidon(s), uml)` is a leaf of the group root `R`, and the
> published tag `T_M` equals `Poseidon(TAG_DOMAIN, s, idM)` for the public
> per-message identifier `idM`."

- **Public:** `R`, `idM`, `T_M`, `uml` (userMessageLimit).
- **Private:** `s`, Merkle path (`pathElements`, `pathIndices`).

This binds `T_M` to the *same* `s` that owns a real leaf. It can be implemented as
a **separate proof** posted alongside the RLN proof, or **fused into the RLN
circuit** (cheaper; the RLN circuit already opens the tree at `rc` from `s`, so we
only add the two Poseidon constraints for `T_M` and one public output). §10 gives
the standalone version; fusing is a straightforward optimization once validated.

> Without Statement S, `T_M` is just a number the author printed; in the
> moderation round they could disown it. With Statement S, `T_M` is provably the
> output of the same secret that holds a seat in the tree.

### 3.2 Non-authorship proof (`NonAuthorship`) — the moderation proof

To answer a challenge on `M` (with public `idM`, `T_M`), a member proves:

> **Statement N.** "I know an identity secret `s` and a Merkle path such that
> `rc = Poseidon(Poseidon(s), uml)` is a leaf of the *current* group root `R`,
> and `Poseidon(TAG_DOMAIN, s, idM) ≠ T_M`. I additionally output a fresh
> challenge nullifier `cn = Poseidon(s, challengeId)` so the server can record
> *which seat* answered without learning `s` and can detect double/short answers."

- **Public:** `R` (current root), `idM`, `T_M`, `uml`, `challengeId`, and outputs
  `cn` (challenge nullifier).
- **Private:** `s`, Merkle path.
- **Asserted in-circuit:**
  1. Merkle inclusion of `rc = Poseidon(Poseidon(s), uml)` under `R`.
  2. `myTag := Poseidon(TAG_DOMAIN, s, idM)` and `myTag ≠ T_M` (an explicit
     non-equality gadget — see §10.4).
  3. `cn = Poseidon(s, challengeId)` (binds the answer to a seat for accounting,
     unlinkable across challenges because `challengeId` differs).

The verifier checks the SNARK, checks `R` matches the live root, checks `cn` is
fresh for this `challengeId` (one answer per seat), and marks that seat *cleared*.

> **The author cannot satisfy (2):** for the true author, `myTag = T_M` by
> Statement S, so the `myTag ≠ T_M` constraint is unsatisfiable; they cannot
> produce a proof at all. Every non-author *can* satisfy it (their `myTag ≠ T_M`
> with overwhelming probability — see §4). This is the entire mechanism.

---

## 4. Soundness

We argue the four properties the scheme must have. Let `H = Poseidon` with domain
separation; we model `H` as a random oracle / PRF (the standard heuristic in
RLN/Semaphore; everything below is in that model).

### 4.1 The author cannot prove non-authorship (completeness of exclusion)

By Statement S, the published `T_M = H(TAG_DOMAIN, s*, idM)` where `s*` is the
author's secret and `s*`'s rate commitment is a leaf of `R`. In `NonAuthorship`,
the author would have to open the tree at *some* leaf `rc' = H(H(s'), uml)` and
prove `H(TAG_DOMAIN, s', idM) ≠ T_M`.

- If they use their *own* `s' = s*`, the inner value equals `T_M`, so the
  `≠` constraint is unsatisfiable → no proof.
- If they try to use a *different* `s'` whose `rc'` is also in the tree (i.e. a
  leaf they do **not** own), they must know that `s'` — but `rc'` is a one-way
  commitment to someone else's secret, which they do not know. They cannot open the
  tree at a leaf whose preimage they lack. (This is exactly the membership
  soundness Semaphore/RLN already rely on.)

So the author is structurally unable to clear the challenge. ∎

### 4.2 A non-author can always prove non-authorship (completeness of innocence)

An honest member with secret `s ≠ s*` opens the tree at their own leaf and must
show `H(TAG_DOMAIN, s, idM) ≠ T_M`. This fails only if
`H(TAG_DOMAIN, s, idM) = H(TAG_DOMAIN, s*, idM)` with `s ≠ s*` — a Poseidon
collision on the third coordinate fixed. Under collision resistance this has
probability ≈ `2^{-128}` (BN254, ~254-bit field, Poseidon). So every honest
non-author clears the challenge except with negligible probability. ∎

### 4.3 No honest member can be falsely accused (soundness of the accusation)

"Falsely accused" = an honest non-author is *unable* to produce a valid
non-authorship proof. By §4.2 this happens only on a Poseidon collision
(`H(s, idM) = H(s*, idM)`, `s ≠ s*`), i.e. with negligible probability. Note the
collision is per-`idM`: even if (astronomically) it happened for one message, the
member is innocent for every other message because `idM` differs. There is **no**
adversarial way to *induce* a false accusation: `idM` is jointly/server-randomized
(§2.3), so an author cannot grind an `idM` that collides an honest member's tag
with `T_M`. ∎

### 4.4 A member cannot lie about their secret (binding to the group)

The non-equality is over `H(TAG_DOMAIN, s, idM)` where `s` is the *same* private
input that must satisfy Merkle inclusion `H(H(s), uml) ∈ R`. A member cannot:

- **Use a secret not in the tree:** inclusion fails (root mismatch).
- **Use someone else's leaf:** they lack that leaf's `s` preimage (one-wayness of
  `H`), so they cannot satisfy inclusion.
- **Use a different `s` for the tag than for the leaf:** impossible — there is a
  *single* `s` wire feeding both the leaf derivation and the tag derivation in the
  circuit (§10.3). The constraint system forces consistency.
- **Forge a different `T_M` reading:** `T_M` is a *public input* fixed by the
  challenge; the circuit recomputes `H(TAG_DOMAIN, s, idM)` from the member's own
  `s` and compares to that fixed `T_M`. There is no client-chosen freedom.

Hence the only way to clear the challenge is to genuinely *not* be the author. ∎

> **Residual assumption made explicit:** soundness of *exclusion* depends on
> Statement S having been enforced at send time for `M`. If a message predates the
> feature (no `T_M`), or `T_M` was minted without Statement S, that message is
> simply **not moderatable** by this scheme (the server has no bound target). This
> is a hard boundary, recorded in §9 and §11.

---

## 5. Protocol & exclusion semantics

### 5.1 Lifecycle of a moderation challenge

1. **Flag.** A flagged message `M` (with public `idM`, `T_M`) is selected for
   moderation by whatever upstream policy decides (admin action, threshold of
   reports — out of scope; see §11a). The server opens a **Challenge** record:
   `{ challengeId, roomId, messageId, idM, T_M, openedAt, rootSnapshot R }`.
2. **Outstanding obligation.** Every *currently-seated* member of the room now has
   an *outstanding non-authorship obligation* for `challengeId`. The gate for
   continued posting becomes: **to send a new message you must have cleared all
   open challenges that were open when you last had standing** (see §5.3 for the
   churn-friendly batched form).
3. **Clear.** A member submits a `NonAuthorship` proof for `challengeId`. The
   server verifies it, checks the root, checks `cn = Poseidon(s, challengeId)` is
   fresh (rejects a second answer from the same seat — prevents one member clearing
   on behalf of another by replay, and prevents one seat answering twice to muddy
   accounting), and marks that seat **cleared** for this challenge.
4. **Resolve.** The challenge resolves when either:
   - **all seats cleared** → no author present (author already left / was the
     posting seat that is now gone) → challenge closes with "author not present",
     OR
   - a **deadline** passes with exactly the structure "every seat cleared *except*
     one (or a small set) that never produced a valid proof." The uncleared seat is
     the author **by exclusion**. The server does **not** learn *who* they are — it
     only knows *which leaf/`cn`-space never answered* (see §5.2 on identifying the
     leaf without identity).

### 5.2 How the uncleared seat is acted on without deanonymizing

The challenge cannot directly name the author's leaf, because a non-answer produces
no `cn`. Two resolution strategies:

- **(R1) Affirmative roll-call (recommended).** Require *every* seat to either
  clear (`NonAuthorship`) or — exactly once per challenge — produce a
  **seat-presence proof**: `Poseidon(s, challengeId)` opening the tree at its leaf
  *without* the `≠` constraint. The author **can** produce a seat-presence proof
  (they own a leaf) but **cannot** produce the `NonAuthorship` proof. So the server
  collects, for each `cn`, a bit "cleared (non-author) vs only-present (author)."
  The author's leaf is the one `cn` that appears with *presence but never
  non-authorship*. The server now knows the **leaf** (it can map `cn`→leaf only if
  it stores `cn` per leaf; better: the presence proof can also output `rc` so the
  server learns the *rate commitment* of the uncleared seat) — and `rc` is exactly
  the handle `banMembershipByLeaf` consumes. **No identity is revealed**; only the
  pseudonymous `rc` (already public as a tree leaf) is implicated.
- **(R2) Pure exclusion / standing-only.** Don't try to name the leaf at all.
  Simply enforce: *a seat that has not cleared an open challenge cannot post.* The
  author self-excludes by being unable to clear. This needs no roll-call and leaks
  strictly less, but it cannot *remove* the author's leaf from the tree — it only
  *mutes* them until the message ages out or the challenge is closed. For ephemeral
  rooms (§11b) R2 is likely sufficient and is the privacy-maximal choice.

> **Trade-off.** R1 produces an actionable `rc` (enabling true removal via the
> existing ban path) at the cost of requiring a presence proof from everyone and
> revealing *which already-public leaf* is the author. R2 reveals nothing beyond
> "this seat is muted" but cannot prune. The product owner should pick based on
> whether *removal* or *muting* is the goal (§11a).

### 5.3 Tie-in to existing membership / revocation

The action taken on the identified author maps **directly** onto existing code:

- **R1 → removal.** The presence proof outputs the author's `rateCommitment`
  `rc*`. The moderation subsystem calls the *existing*
  `banMembershipByLeaf(tx, { roomId, rateCommitment: rc*, reason: ADMIN /* or a new MODERATION reason */ })`.
  That already: resolves the leaf, sets `Membership.status = BANNED`, **prunes all
  the membership's leaves** (removing the author from the tree), and writes a `Ban`
  row. The author is gone exactly as a rate-limit-collision spammer is gone today.
  A new `BanReason.MODERATION` enum value would be added (the only schema change
  besides the envelope field).
- **R2 → muting.** No ban. The challenge simply remains "unresolved for one seat,"
  and the posting gate (§5.1.2) keeps that seat unable to send. State lives in the
  new `Challenge` / `ChallengeClearance` tables (§9), not in `Membership`.

`Membership.status`, leaf pruning, and the `Ban` table are **reused unchanged**;
the scheme adds *challenge state*, not a parallel revocation mechanism.

### 5.4 "Once per moderated message"

Each member proves non-authorship **once per challenge** (`cn` freshness enforces
exactly-once). A returning member with many open challenges faces the **churn
problem** (§6), solved by batching.

---

## 6. The churn problem and the BATCHED non-authorship proof

### 6.1 Problem

ZK proofs are not free (Groth16 prove time is seconds on a phone for a depth-20
membership circuit). A member who was away while `k` messages were moderated would,
naively, owe `k` separate `NonAuthorship` proofs to regain standing. For `k` in the
tens-to-hundreds this is prohibitive on a phone and creates a *griefing* lever
(§8): an attacker who can cheaply flag many messages forces every returning member
to pay `O(k)` proofs.

### 6.2 Goal

**One** proof of innocence over a *set* `S = {M_1, …, M_k}` of moderated messages,
with prover cost growing **sub-linearly** in `k` (ideally `O(log k)` or
`O(k)` *hashes* but only **one** SNARK, vs. `k` SNARKs).

### 6.3 Construction: set non-membership of the member's tag

The key reframing: the set of moderated messages is characterized by the set of
their **author tags** `{T_{M_1}, …, T_{M_k}}` *together with* their identifiers
`{idM_1, …, idM_k}`. A member is innocent of the whole batch iff, for **every**
`i`, `H(TAG_DOMAIN, s, idM_i) ≠ T_{M_i}`.

Because each `T_{M_i}` is tied to its own `idM_i`, we cannot use a single fixed
target. We make the batch homogeneous by re-keying each entry to a **batch-uniform
witness tag**. Define, per moderated message, the public pair
`e_i = Poseidon(idM_i, T_{M_i})`. The author of `M_i` is the unique party for whom
`Poseidon(idM_i, H(TAG_DOMAIN, s, idM_i)) = e_i`. So define the member's
**derived tag for entry `i`**: `d_i(s) = Poseidon(idM_i, H(TAG_DOMAIN, s, idM_i))`.
Innocence of the batch ⇔ `d_i(s) ≠ e_i` for all `i`.

Two batched shapes, with different cost/`k` curves:

- **(BATCH-A) Linear-in-`k` hashing, single SNARK (simple, recommended first).**
  The circuit takes `s`, the Merkle path (proved once), and the public list
  `{(idM_i, e_i)}_{i=1..k}`. It computes `d_i(s)` for each `i` and asserts
  `d_i(s) ≠ e_i` (k non-equality gadgets). Cost: **one** membership opening
  (~depth-20 Poseidon path, the dominant fixed cost) **plus** `k × (2 Poseidon +
  1 non-equality)` ≈ a few hundred constraints per entry. This is **one** proof
  instead of `k`, and the per-entry marginal cost is tiny next to a full
  membership circuit. Prover cost ≈ `C_member + k·c` with `c ≪ C_member`. For
  `k` up to a few thousand this is a single fast proof. This already defeats the
  churn/griefing lever (one phone proof regardless of `k`).

- **(BATCH-B) Logarithmic-in-`k` via a Merkle accumulator of moderated entries
  (for very large `k`).** Maintain a Merkle tree `Mod` over the moderated entries
  `e_i` (root `R_mod`, published by the server). To prove innocence of the *whole*
  set, the member proves: *"for my `s`, the value `d_? = Poseidon(idM, H(...))`
  computed for any leaf I open does **not** equal that leaf's `e`."* This naively
  still touches all leaves. To get true sub-linearity, restructure as **set
  non-membership of the member's derived-tag set in the moderated-tag set**:
  - Server publishes a **sorted** Merkle tree of `{e_i}` (root `R_mod`).
  - The member computes their *own* candidate value for each *distinct* `idM`
    present; but since each `e_i` has a distinct `idM_i`, the member's only risk per
    entry is that single entry. The clean sub-linear form is a **batched
    non-membership argument**: prove that the member's tag-set
    `{d_i(s)}` and the moderated set `{e_i}` are **disjoint** using a single
    permutation/lookup argument (a log-derivative "lookup" / grand-product
    argument à la plookup/LogUp) that the prover satisfies with `O(k)` *witness*
    but a SNARK whose *recursion depth / verification* is `O(log k)`. In a Groth16
    setting this is awkward; in a **Plonkish/Halo2** setting a LogUp "these two
    multisets are disjoint" argument is natural and gives prover work `O(k)`
    *field ops* with **one** proof and small verifier cost. (See §10.5.)

> **Recommendation.** Implement **BATCH-A** first: it is one Groth16 proof, reuses
> the exact membership gadget, and already makes prover *SNARK count* `O(1)` in
> `k` — which is the property that defeats churn and griefing. Only move to
> **BATCH-B** (a Plonkish LogUp disjointness argument) if real `k` reaches the tens
> of thousands, where even `k` in-circuit Poseidons in one proof becomes heavy.

### 6.4 Cost table (order-of-magnitude, depth-20, Poseidon/BN254)

| Variant | SNARKs | Dominant constraint cost | Notes |
| --- | --- | --- | --- |
| Naive (per message) | `k` | `k · C_member` | infeasible on phone for large `k` |
| BATCH-A | 1 | `C_member + k·c`, `c ≈ 2 Poseidon + neq` | linear *hashing*, constant *proofs*; good to `k ~ few k` |
| BATCH-B (LogUp/Plonkish) | 1 | `C_member + O(k)` field ops, verifier `O(log k)` | for very large `k`; needs Plonkish stack, not Groth16/rlnjs |

`C_member` (one depth-20 Poseidon Merkle opening + leaf derivation) is the fixed
floor and dominates for small `k`. The win of BATCH-A is **collapsing `k` proofs
into one** while keeping the expensive membership part single.

### 6.5 Batch hygiene

- Batches are **append-only per epoch window**: the server publishes the current
  open-challenge set (its `{(idM_i, e_i)}` and `R_mod`) so a returning member fetches
  one list and produces one proof.
- A member who already cleared some challenges individually need only batch over the
  *still-open* subset; clearances are tracked per `cn` per `challengeId`.
- The proof is bound to the **current root `R`** and the **current moderated-set
  digest** (`Poseidon`-fold of `{e_i}` or `R_mod`) as public inputs, so a member
  cannot replay an old batch proof that omits newly-added entries.

---

## 7. Privacy analysis

The scheme must leak **nothing beyond** the single bit *"this member is / is-not the
author of `M`"* (and, under R1, the already-public `rc` of the implicated seat).

- **Tags leak no linkage.** `T_M = H(TAG_DOMAIN, s, idM)` with independent per-message
  `idM`; outputs are pseudorandom and unlinkable across messages (§2). The envelope
  gains one field that is, to any observer without `s`, a fresh random element.
- **Non-authorship proofs are zero-knowledge.** Statement N reveals only the public
  inputs (`R, idM, T_M, uml, challengeId`) and outputs (`cn`, and under R1 a presence
  bit / `rc`). `cn = H(s, challengeId)` is unlinkable across challenges (different
  `challengeId`) and across rooms; it is a per-challenge pseudonym, exactly like the
  existing per-epoch RLN nullifier is a per-epoch pseudonym. The proof reveals nothing
  about `s` beyond membership and the single non-equality bit.
- **The author learns nothing extra either.** They simply cannot produce a proof.
  Their failure is observable only as *absence of a clearance*, not as a positive
  signal.
- **What R1 does reveal:** the *rate commitment* `rc*` of the author's seat — but
  `rc*` is **already public** (it is a tree leaf) and is not linked to any real-world
  identity (Discreetly's whole model). R1 reveals *which already-anonymous seat*
  authored `M`, i.e. it links `M` to a pseudonymous seat. That is strictly more than
  R2 (which links nothing) and is the price of *removal*. The product owner must
  decide if linking a flagged message to an anonymous-but-now-bannable seat is
  acceptable (§11a).

### 7.1 Griefing

- **Mass-moderation to force churn.** An attacker who can cause many messages to be
  flagged forces members to prove non-authorship of all of them. **BATCH-A neutralizes
  this:** one proof regardless of `k`. The remaining lever is the *server's* cost to
  verify and the *list distribution* cost, both `O(k)` but server-side and cheap.
  Mitigation: rate-limit who can open challenges, and/or require challenges to be
  opened only by admin/threshold (§11a) — the same gate that decides *whether content
  bans exist at all*.
- **Forcing the innocent offline.** A member who never returns never clears and is
  muted/removed under R1/R2 even though innocent. Mitigation: challenges should have a
  **grace window** and should not auto-ban on R1 until a deadline; R2 (muting) is
  reversible the moment they return and clear. This is a *policy* knob, recorded as an
  open question.

### 7.2 Collusion

- **Members colluding to shield the author.** Collusion cannot *manufacture* a valid
  non-authorship proof for the author: no member can satisfy `≠` for the author's seat
  (they'd need the author's `s` and the author's `s` makes the tag equal `T_M`). The
  author cannot delegate clearing to a friend, because the friend can only clear *their
  own* seat (`cn` is seat-bound). Collusion can at most have everyone *refuse* to
  answer (a liveness/availability problem, not a soundness one) — under R1 that just
  fails to resolve; under R2 everyone who refuses is muted, including the colluders.
- **Server collusion.** The server already sees all tags and roots; it cannot derive
  `s` from `T_M`/`cn` (one-wayness). It *can* choose `idM`/`challengeId`; §2.3 prevents
  it from grinding `idM` to frame a member (joint randomness), and `challengeId` only
  affects which pseudonym a member shows.

### 7.3 Replay

- **Proof replay across challenges/roots.** `NonAuthorship` binds `R`, `idM`, `T_M`,
  `challengeId` as public inputs and outputs a `challengeId`-bound `cn`. A proof for one
  challenge is invalid for another (different public inputs) and is single-use per seat
  (`cn` freshness). Batch proofs additionally bind the moderated-set digest so they
  can't be replayed after the set grows.
- **Tag replay (copying someone's `T_M`).** A non-author copying the author's `T_M`
  into *their own* message is harmless: it would only make *that* message moderatable
  to the *author's* seat, not theirs (Statement S binds `T_M` to `s` at send time, so a
  copier can't satisfy Statement S for a `T_M` they didn't derive). The send circuit
  rejects a `T_M` not equal to `H(TAG_DOMAIN, s, idM)` for the sender's own `s`.

---

## 8. Threat model summary

| Adversary capability | Outcome under this scheme |
| --- | --- |
| Author tries to clear their own challenge | **Impossible** (§4.1): `≠` constraint unsatisfiable for their `s`. |
| Author opens tree at someone else's leaf | **Impossible**: lacks that leaf's `s` preimage (§4.1/§4.4). |
| Honest non-author challenged | **Always clears** except Poseidon-collision-negligible (§4.2). |
| Author grinds `idM` to frame a member | **Prevented**: `idM` jointly/server-randomized (§2.3, §4.3). |
| Member lies about secret in proof | **Prevented**: single `s` wire feeds leaf and tag (§4.4). |
| Mass-flag to force churn | **Neutralized** by BATCH-A (one proof, any `k`) + challenge-open gating (§6, §7.1). |
| Members collude to shield author | **Cannot forge** a clearance for the author; at worst a liveness stall (§7.2). |
| Proof / tag replay | **Bound** by `R`, `idM`, `T_M`, `challengeId`, set-digest public inputs; `cn` single-use (§7.3). |
| Pre-feature messages (no `T_M`) | **Not moderatable** by this scheme (hard boundary, §4 residual, §9, §11). |
| Server tries to deanonymize via proofs | Learns only membership + 1 non-equality bit (+ public `rc` under R1) (§7). |

---

## 9. Integration sketch (KEPT OFF)

> **Everything in this section is hypothetical and behind a hard-disabled flag.
> None of it exists in the codebase.** It is recorded so a prototyper knows the
> *shape* of an integration without being tempted to wire it into the live path.

### 9.1 Envelope addition (the per-message tag)

The only change to the message envelope is **one optional public field**:

```jsonc
// Message envelope (current → +tag). The tag field is INERT unless the
// moderation feature flag is enabled; the send path must accept its ABSENCE.
{
  "epoch":        "<bigint>",
  "rlnNullifier": "<string>",      // unchanged (per-epoch)
  "content":      "<string>",
  "proof":        { /* RLN proof */ },
  "sessionColor": "<string?>",
  // --- NEW, feature-flagged, NOT enabled ---
  "authorTag":    "<field element T_M | null>",   // null unless flag on
  "msgSalt":      "<field element | null>"          // server-assigned (§2.3)
}
```

Prisma (`packages/db/prisma/schema.prisma`), *only if/when the feature is
approved* — shown for completeness, **do not migrate**:

```prisma
model Message {
  // ...existing fields...
  authorTag String?   // T_M, null for pre-feature / flag-off messages
  msgSalt   String?   // server-assigned salt forming idM
}

// NEW tables (challenge state lives here, NOT in Membership):
model ModerationChallenge {
  id          String   @id @default(cuid())
  roomId      String
  messageId   String
  idM         String   // public per-message identifier
  authorTag   String   // T_M
  rootSnapshot String  // R at open time
  openedAt    DateTime @default(now())
  deadline    DateTime?
  status      String   // OPEN | RESOLVED_NO_AUTHOR | RESOLVED_EXCLUDED | EXPIRED
}

model ChallengeClearance {
  id           String   @id @default(cuid())
  challengeId  String
  cn           String   // Poseidon(s, challengeId) — seat pseudonym
  kind         String   // NON_AUTHORSHIP | PRESENCE   (R1)
  createdAt    DateTime @default(now())
  @@unique([challengeId, cn])  // exactly-once per seat
}
```

Plus one enum value `BanReason.MODERATION` (R1 removal path).

### 9.2 Where challenge/moderation state and verification would live

- **New circuits** (vendored like the RLN artifacts in `packages/circuits`):
  `nonauthorship.wasm/zkey/vkey` and (fused or standalone) the augmented send tag.
- **New verify module** `services/api/src/moderation/verify-nonauthorship.ts`,
  mirroring `messaging/verify-message.ts` (root check + SNARK verify + `cn`
  freshness). **Never** imported by `messaging/pipeline.ts` in the live build.
- **New router** `services/api/src/moderation/*.router.ts`, mounted **only** when
  `MODERATION_NONAUTH_ENABLED === 'true'` (default false; absent from `.env.example`).
- The **send path augmentation** (Statement S) would be an *additive* check in
  `verifyMessage`: if `flag on` and `authorTag` present, verify the tag-binding
  sub-proof / fused output; if `flag off`, ignore the field entirely. The default
  (flag off) path is **byte-identical to today**.

### 9.3 Hard "off" guarantees the prototype must honor

- The flag defaults **false**; with it false, no new column is read, no new table is
  queried, no new circuit is loaded, and the envelope's `authorTag`/`msgSalt` are
  ignored. The live send/verify path is untouched.
- No new dependency is added to the production `messaging/` module graph.
- The prototype lives in a throwaway branch; this design doc is the only artifact
  that lands in `claude-workspace/`.

---

## 10. CIRCUIT SPEC (for the prototyper)

> Target: Circom 2 + Groth16 (to match the deployed rlnjs/snarkjs stack and the
> circomlib `Poseidon` already vendored). BN254 scalar field. Merkle depth **20**
> (must equal `MERKLE_TREE_DEPTH`). `TAG_DOMAIN` = a fixed field constant =
> `keccak256("discreetly/nonauth/v1") >> 8` (computed once, hardcoded as a circuit
> constant). All Merkle openings use the **same** Poseidon(2) hash and leaf
> ordering as `@semaphore-protocol/group` (left/right by `pathIndices` bit), to
> match `merkle.ts`.

### 10.1 Shared sub-gadgets

```
LeafFromSecret(s, uml):                         // = rate commitment (tree leaf)
    idc = Poseidon(s)                            // 1 Poseidon(1)
    rc  = Poseidon(idc, uml)                     // 1 Poseidon(2)
    return rc

TagFromSecret(s, idM):                          // = author tag
    return Poseidon(TAG_DOMAIN, s, idM)          // 1 Poseidon(3)

MerkleInclusion(rc, pathElements[20], pathIndices[20]) -> root
    // standard depth-20 Poseidon(2) Merkle path; identical to RLN circuit's tree

IsZero(x) -> b        // circomlib IsZero: b=1 iff x==0
NonEqual(a, b):       // assert a != b
    diff = a - b
    inv  = diff^{-1}  // witness; circuit asserts diff * inv == 1  → forces diff != 0
```

`NonEqual` is the **non-equality gadget** (§10.4): provide `inv` as a witness and
constrain `diff * inv === 1`. This is satisfiable **iff** `diff ≠ 0`. It is the
crux that makes the author unable to prove (their `diff = 0` has no inverse).

### 10.2 Circuit `NonAuthorship` (single message)

**Public inputs**
- `root`            — current group Merkle root `R`
- `idM`             — public per-message identifier `Poseidon(roomId, msgSalt)`
- `authorTag`       — `T_M` (the challenged message's published tag)
- `userMessageLimit`— `uml` (room constant; part of the leaf)
- `challengeId`     — public challenge identifier

**Public outputs**
- `cn`              — challenge nullifier `Poseidon(s, challengeId)` (seat pseudonym)

**Private inputs**
- `identitySecret`  — `s`
- `pathElements[20]`, `pathIndices[20]` — Merkle path of the member's leaf
- `tagInv`          — witness inverse of `(TagFromSecret(s,idM) - authorTag)`

**Constraints**
1. `rc   = LeafFromSecret(identitySecret, userMessageLimit)`
2. `rRec = MerkleInclusion(rc, pathElements, pathIndices)`;  assert `rRec === root`
3. `myTag = TagFromSecret(identitySecret, idM)`
4. `NonEqual(myTag, authorTag)` via `(myTag - authorTag) * tagInv === 1`
5. `cn === Poseidon(identitySecret, challengeId)`   // bind seat, output `cn`

Approx. cost: ~depth-20 membership (dominant) + 4 extra Poseidons + 1 inverse.
Comparable to one RLN proof.

### 10.3 Circuit `SeatPresence` (R1 roll-call, optional)

Identical to `NonAuthorship` **minus** constraints 3–4, **plus** it outputs `rc`
(the rate commitment) so the server can act via `banMembershipByLeaf`:

**Public inputs:** `root`, `userMessageLimit`, `challengeId`.
**Public outputs:** `cn = Poseidon(s, challengeId)`, `rc` (rate commitment).
**Private:** `identitySecret`, Merkle path.
**Constraints:** (1) `rc = LeafFromSecret(s, uml)`, (2) inclusion `=== root`,
(3) `cn = Poseidon(s, challengeId)`, output `rc`.

> Note: every honest member produces **both** a `NonAuthorship` and a
> `SeatPresence` proof; the author can produce only `SeatPresence`. The author is
> the `cn` with presence-but-no-non-authorship; its `rc` feeds the existing ban.
> If R2 (muting only) is chosen, `SeatPresence` is omitted entirely and no `rc` is
> ever revealed.

### 10.4 The non-equality gadget (why it is sound)

For field elements, `a ≠ b` is provable by exhibiting `inv = (a-b)^{-1}` and
asserting `(a-b)·inv = 1`. If `a = b` then `a-b = 0`, which has **no** inverse, so
no witness `inv` satisfies the constraint — the prover is stuck. This is precisely
what stops the author: their `myTag = authorTag` ⇒ `diff = 0` ⇒ unprovable. The
gadget is complete for `a ≠ b` (the inverse exists in a field) and sound for `a = b`
(no inverse exists). Use circomlib's `IsZero`/inverse pattern; do **not** use a
range/comparison gadget (wrong tool, and leaks ordering).

### 10.5 Batched circuit `NonAuthorshipBatch` (BATCH-A)

**Public inputs**
- `root`, `userMessageLimit`, `challengeBatchId`
- `setDigest` — `Poseidon`-fold (or Merkle root `R_mod`) over `{(idM_i, e_i)}`,
  binding the exact set the proof covers (replay-safety, §6.5)
- the list `{(idM_i, e_i)}_{i=1..k}` (or committed via `setDigest` + supplied as
  a non-hashed advice array the circuit re-folds to check against `setDigest`)

where `e_i = Poseidon(idM_i, authorTag_i)`.

**Public output**
- `cn = Poseidon(s, challengeBatchId)`

**Private inputs:** `identitySecret`, one Merkle path, and `k` witness inverses
`invs[i]`.

**Constraints**
1. Membership of `s`'s leaf under `root` (**once**, dominant cost).
2. Re-fold `{(idM_i, e_i)}` and assert it equals `setDigest` (binds the set).
3. For each `i ∈ [1..k]`:
   `myTag_i = Poseidon(TAG_DOMAIN, s, idM_i)`;
   `d_i = Poseidon(idM_i, myTag_i)`;
   `NonEqual(d_i, e_i)` via `(d_i - e_i)·invs[i] === 1`.
4. `cn = Poseidon(s, challengeBatchId)`.

Cost: `C_member + k·(2 Poseidon + 1 inverse)` in **one** proof. Compile with a
fixed max `k` (e.g. 256/1024); pad unused slots with a sentinel pair that is
trivially non-equal (e.g. `(idM=0, e=1)` with `d=Poseidon(0, Poseidon(DOM,s,0))`,
ensuring `d ≠ 1`), or use a per-slot `enabled` flag that conditionally relaxes the
`NonEqual` (multiply the constraint by `enabled`). Prefer the `enabled`-flag form:
`enabled_i · ((d_i - e_i)·invs[i] - 1) === 0`, so disabled slots are free.

### 10.6 BATCH-B note (very large `k`, out of Groth16 scope)

For `k` in the tens of thousands, replace the `k` in-circuit non-equalities with a
**LogUp / grand-product disjointness argument** in a Plonkish system (Halo2 / plonky2):
prove the multiset `{d_i(s)}` and `{e_i}` are **disjoint** with prover work `O(k)`
field ops and a single proof of small verifier cost. This requires a different
proving stack than the vendored rlnjs/Groth16 and is **not** recommended unless `k`
demonstrably explodes. Recorded for completeness only.

### 10.7 Augmented send-tag constraints (Statement S, for reference)

If/when the send proof is augmented (fused into the RLN circuit), add to the RLN
circuit — which already derives `rc` from `s` and opens the tree — exactly:
- public inputs `idM`, `authorTag`;
- constraint `authorTag === Poseidon(TAG_DOMAIN, identitySecret, idM)`.
That is **two** extra Poseidon constraints and one public-input equality on top of
the existing RLN circuit. (Standalone alternative: a tiny separate circuit proving
membership + the tag equality, posted next to the RLN proof.)

---

## 11. OPEN PRODUCT QUESTIONS (record prominently — answer before any prototype)

These are **gating** questions. Until they are answered, this scheme should not be
prototyped beyond paper, because the answers may make it unnecessary or unwanted.

### 11a. Does Discreetly even want content bans / message-level moderation?

Discreetly's entire premise is **anonymous** speech with RLN as the *only* native
sanction (rate-limit spam → Shamir-recover → ban). There is currently **no
content-based moderation** anywhere in the code; the only `BanReason`s are
`RATE_LIMIT_COLLISION` and `ADMIN`. Introducing *content* bans is a **product and
values decision**, not just an engineering one:

- Who is allowed to **open a challenge** on a message? (admin only? a report
  threshold? room owner?) This gate is also the anti-griefing control (§7.1).
- Is the goal **removal** (R1 — links a flagged message to an anonymous seat and
  prunes it) or **muting** (R2 — reveals nothing, just suspends until resolved)?
  These have materially different privacy footprints (§5.2, §7).
- Does adding *any* mechanism that singles out "the author of this specific
  message" — even by exclusion — conflict with the app's promise? The scheme leaks
  only one bit, but the *existence* of a per-message author tag is itself a
  philosophical shift from "no stable per-message author tag" (today) to "a bound,
  per-message, unlinkable tag exists." Unlinkable ≠ nonexistent; the product owner
  should decide if that shift is acceptable.

**If the answer is "no content bans," this whole scheme is moot.**

### 11b. If room history is ephemeral, does the offending content age out — making this feature unnecessary?

Discreetly already has `RoomPersistence.EPHEMERAL` rooms that **store no `Message`
rows at all** — they are pure transport relays (verify → transient collision check
→ fan out over Redis → forget; `message.list` returns `[]`). For such rooms:

- **There is no `M` to moderate after the fact.** The message exists only in transit;
  there is no stored target to flag, no `idM`/`T_M` to persist, and no later
  challenge to answer. The non-authorship scheme has **nothing to bind to**.
  → For EPHEMERAL rooms, this feature is **structurally inapplicable**; the content
  *already* ages out instantly. Real-time-only abuse is a *different* problem
  (better addressed by rate-limit / live filtering), not by retroactive
  non-authorship challenges.

- For **PERSISTENT** rooms, if the product adopts a **retention window** (e.g. delete
  `Message` rows older than N weeks), then any offending message **ages out** on its
  own. The non-authorship machinery (a tag on every message, a second circuit, a
  challenge subsystem, churn-batching) buys you the ability to *act on content that
  will be deleted anyway in N weeks*. The cost/benefit is poor unless:
  - the retention window is long (months+), AND
  - the harm of the content during that window is high enough to justify per-message
    tags + per-challenge proofs from every member, AND
  - **removal** (not just aging-out) of the *author* (not just the message) is the
    actual goal — i.e. you want to ban the person, not wait out the post.

  If the real goal is "the post disappears," **retention/TTL is far cheaper** than
  this entire scheme and leaks nothing. If the real goal is "the *author* is removed
  from the room," then non-authorship moderation (R1) is one of the few ways to do
  that *without deanonymizing* — but it should be weighed against simply not having
  content bans at all (11a).

> **Net analysis.** The scheme is only worth building if (i) the product *wants*
> content-driven author removal, (ii) on *persistent* rooms with a *long* retention
> window, where (iii) waiting for the content to age out is unacceptable, and (iv)
> the privacy cost of a bound-but-unlinkable per-message tag is deemed acceptable.
> If any of those is false — and for ephemeral rooms it is **always** false — the
> feature should not be built. This is the single most important takeaway for the
> product owner.

### 11c. Secondary open questions

- **Deadline / grace policy:** how long does a returning member have to clear before
  exclusion bites? (Anti-griefing vs. responsiveness; §7.1.)
- **Salt protocol:** option (A) (pre-send server salt, simplest circuit) vs. (B′)
  (nonce-split, grinding-hardened) — pick based on threat appetite (§2.3).
- **Fused vs. standalone send-tag proof:** fusing into the RLN circuit is cheaper but
  changes the deployed RLN artifact (re-trusted-setup); standalone keeps RLN
  untouched at the cost of a second proof per send (§3.1, §10.7).
- **Removal vs. muting (R1 vs. R2):** the central privacy/teeth trade-off (§5.2).

---

## 12. Summary of what this scheme requires (and why it stays OFF)

- A **new per-message tag** `T_M = Poseidon(TAG_DOMAIN, s, idM)` in the envelope,
  with `idM` server-randomized — author-binding, deterministic-given-`idM`,
  unlinkable across messages.
- An **augmented send proof** (Statement S) binding `T_M` to the same `s` that owns
  a tree leaf — *this is a prerequisite, not optional*; without it the author can
  disown the tag and the scheme is unsound.
- A **non-authorship circuit** (Statement N) proving membership + `Poseidon(s,idM) ≠
  T_M`, with a non-equality (inverse) gadget that is *unsatisfiable for the author*.
- **Exclusion semantics** that reuse the existing `banMembershipByLeaf` revocation
  (R1 removal) or a new challenge-clearance gate (R2 muting).
- A **batched circuit** (BATCH-A) collapsing `k` moderated messages into **one**
  proof, defeating the churn/griefing lever; BATCH-B (Plonkish LogUp) only if `k`
  explodes.
- A threat/privacy analysis showing the scheme leaks **only** the bit "is/is-not the
  author of `M`" (plus the already-public `rc` under R1).

It stays **off** because (a) the product may not want content bans at all, and
(b) for ephemeral rooms it is structurally inapplicable and for persistent rooms a
retention/TTL window may make it unnecessary. **Do not wire any of this into the
live app.**
