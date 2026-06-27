pragma circom 2.1.0;

// EXPLORATORY PROTOTYPE - NOT wired into Discreetly.
// Single-message non-authorship circuit (DESIGN.md sec 10.2).
//
// Statement N: "I know an identity secret `s` and a Merkle path such that
// rc = Poseidon(Poseidon(s), uml) is a leaf of the current group root R,
// and Poseidon(TAG_DOMAIN, s, idM) != T_M. I also output a fresh challenge
// nullifier cn = Poseidon(s, challengeId)."
//
// The author (whose published T_M == Poseidon(TAG_DOMAIN, s, idM)) CANNOT
// satisfy constraint 4: their diff = myTag - authorTag = 0 has no inverse,
// so witness generation fails. Every non-author CAN (diff != 0).

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/switcher.circom";

// --- Merkle inclusion (depth-D, Poseidon(2), Semaphore/@zk-kit IMT ordering) ---
// At each level, pathIndices[i] == 0 means the running hash is the LEFT input,
// pathElements[i] the RIGHT; == 1 swaps them. This matches @semaphore-protocol/group
// v3 (poseidon2 arity-2 incremental Merkle tree).
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
        // pathIndices must be boolean.
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

// --- rate commitment (tree leaf): Poseidon(Poseidon(s), uml) ---
template LeafFromSecret() {
    signal input s;
    signal input uml;
    signal output rc;

    component idc = Poseidon(1);
    idc.inputs[0] <== s;

    component rcH = Poseidon(2);
    rcH.inputs[0] <== idc.out;
    rcH.inputs[1] <== uml;

    rc <== rcH.out;
}

// --- author tag: Poseidon(TAG_DOMAIN, s, idM) ---
template TagFromSecret(TAG_DOMAIN) {
    signal input s;
    signal input idM;
    signal output tag;

    component h = Poseidon(3);
    h.inputs[0] <== TAG_DOMAIN;
    h.inputs[1] <== s;
    h.inputs[2] <== idM;

    tag <== h.out;
}

// --- non-equality gadget (DESIGN.md sec 10.4) ---
// Asserts a != b by exhibiting inv = (a-b)^-1 and constraining (a-b)*inv === 1.
// Satisfiable iff a != b. For a == b, diff = 0 has no inverse -> unsatisfiable.
template AssertNotEqual() {
    signal input a;
    signal input b;
    signal input inv;       // witness: (a-b)^-1

    signal diff;
    diff <== a - b;
    diff * inv === 1;
}

template NonAuthorship(DEPTH, TAG_DOMAIN) {
    // Public
    signal input root;
    signal input idM;
    signal input authorTag;        // T_M
    signal input userMessageLimit; // uml
    signal input challengeId;

    // Private
    signal input identitySecret;   // s
    signal input pathElements[DEPTH];
    signal input pathIndices[DEPTH];
    signal input tagInv;           // witness: (myTag - authorTag)^-1

    // Public output
    signal output cn;              // Poseidon(s, challengeId)

    // 1+2. leaf derivation + Merkle inclusion === root
    component leaf = LeafFromSecret();
    leaf.s <== identitySecret;
    leaf.uml <== userMessageLimit;

    component incl = MerkleInclusion(DEPTH);
    incl.leaf <== leaf.rc;
    for (var i = 0; i < DEPTH; i++) {
        incl.pathElements[i] <== pathElements[i];
        incl.pathIndices[i] <== pathIndices[i];
    }
    incl.root === root;

    // 3. my tag
    component tag = TagFromSecret(TAG_DOMAIN);
    tag.s <== identitySecret;
    tag.idM <== idM;

    // 4. myTag != authorTag  (UNSATISFIABLE for the true author)
    component neq = AssertNotEqual();
    neq.a <== tag.tag;
    neq.b <== authorTag;
    neq.inv <== tagInv;

    // 5. challenge nullifier cn = Poseidon(s, challengeId)
    component cnH = Poseidon(2);
    cnH.inputs[0] <== identitySecret;
    cnH.inputs[1] <== challengeId;
    cn <== cnH.out;
}

// TAG_DOMAIN = keccak256("discreetly/nonauth/v1") >> 8, reduced mod BN254.
// Computed once in JS (see test/lib.mjs TAG_DOMAIN) and pinned here.
component main {public [root, idM, authorTag, userMessageLimit, challengeId]} =
    NonAuthorship(20, 422115546466166259619571466461604094994863187710345308661988695711865692286);
