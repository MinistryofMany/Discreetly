pragma circom 2.1.0;

// EXPLORATORY PROTOTYPE - NOT wired into Discreetly.
// Batched non-authorship circuit, BATCH-A (DESIGN.md sec 10.5).
//
// One membership opening + K per-entry non-equalities, collapsing K moderated
// messages into ONE proof. Per entry:
//   myTag_i = Poseidon(TAG_DOMAIN, s, idM_i)
//   d_i     = Poseidon(idM_i, myTag_i)
//   assert  enabled_i * ((d_i - e_i) * invs_i - 1) === 0   (disabled slots free)
// where e_i = Poseidon(idM_i, authorTag_i) is the public batch entry.
//
// The author of ANY enabled entry j has d_j == e_j -> (d_j - e_j) = 0, so no
// invs_j makes the bracket vanish while enabled_j = 1 -> unsatisfiable.

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/switcher.circom";

template MerkleInclusion(DEPTH) {
    signal input leaf;
    signal input pathElements[DEPTH];
    signal input pathIndices[DEPTH];
    signal output root;

    component hashers[DEPTH];
    component switchers[DEPTH];
    signal cur[DEPTH + 1];
    cur[0] <== leaf;

    for (var i = 0; i < DEPTH; i++) {
        pathIndices[i] * (pathIndices[i] - 1) === 0;
        switchers[i] = Switcher();
        switchers[i].sel <== pathIndices[i];
        switchers[i].L <== cur[i];
        switchers[i].R <== pathElements[i];
        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== switchers[i].outL;
        hashers[i].inputs[1] <== switchers[i].outR;
        cur[i + 1] <== hashers[i].out;
    }
    root <== cur[DEPTH];
}

template NonAuthorshipBatch(DEPTH, K, TAG_DOMAIN) {
    // Public
    signal input root;
    signal input userMessageLimit;
    signal input challengeBatchId;
    signal input setDigest;        // Poseidon-fold over {(idM_i, e_i)} (replay-safety)
    signal input idM[K];           // public per-entry identifiers
    signal input e[K];             // public per-entry batch entries e_i

    // Private
    signal input identitySecret;
    signal input pathElements[DEPTH];
    signal input pathIndices[DEPTH];
    signal input invs[K];          // witness inverses (d_i - e_i)^-1 for enabled slots
    signal input enabled[K];       // 1 = real entry, 0 = padding slot

    // Public output
    signal output cn;              // Poseidon(s, challengeBatchId)

    // 1. leaf + membership (once)
    component idc = Poseidon(1);
    idc.inputs[0] <== identitySecret;
    component rcH = Poseidon(2);
    rcH.inputs[0] <== idc.out;
    rcH.inputs[1] <== userMessageLimit;

    component incl = MerkleInclusion(DEPTH);
    incl.leaf <== rcH.out;
    for (var i = 0; i < DEPTH; i++) {
        incl.pathElements[i] <== pathElements[i];
        incl.pathIndices[i] <== pathIndices[i];
    }
    incl.root === root;

    // 2. re-fold {(idM_i, e_i)} and bind to setDigest.
    //    fold_0 = 0; fold_{i+1} = Poseidon(fold_i, idM_i, e_i); setDigest == fold_K.
    component fold[K];
    signal acc[K + 1];
    acc[0] <== 0;
    for (var i = 0; i < K; i++) {
        fold[i] = Poseidon(3);
        fold[i].inputs[0] <== acc[i];
        fold[i].inputs[1] <== idM[i];
        fold[i].inputs[2] <== e[i];
        acc[i + 1] <== fold[i].out;
    }
    setDigest === acc[K];

    // 3. per-entry non-equality (enabled-gated)
    component tag[K];
    component dH[K];
    signal diff[K];
    signal bracket[K];
    for (var i = 0; i < K; i++) {
        enabled[i] * (enabled[i] - 1) === 0;

        tag[i] = Poseidon(3);
        tag[i].inputs[0] <== TAG_DOMAIN;
        tag[i].inputs[1] <== identitySecret;
        tag[i].inputs[2] <== idM[i];

        dH[i] = Poseidon(2);
        dH[i].inputs[0] <== idM[i];
        dH[i].inputs[1] <== tag[i].out;

        diff[i] <== dH[i].out - e[i];
        // bracket_i = diff_i * invs_i - 1 ; enabled_i * bracket_i === 0
        bracket[i] <== diff[i] * invs[i] - 1;
        enabled[i] * bracket[i] === 0;
    }

    // 4. cn
    component cnH = Poseidon(2);
    cnH.inputs[0] <== identitySecret;
    cnH.inputs[1] <== challengeBatchId;
    cn <== cnH.out;
}

component main {public [root, userMessageLimit, challengeBatchId, setDigest, idM, e]} =
    NonAuthorshipBatch(20, 4, 422115546466166259619571466461604094994863187710345308661988695711865692286);
