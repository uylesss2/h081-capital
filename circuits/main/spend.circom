pragma circom 2.1.0;

include "lib/hashes.circom";
include "lib/merkle.circom";
include "lib/range.circom";
include "circomlib/circuits/comparators.circom";

// Spend from an allowance. The policy lives inside the note, so a payment
// that breaks it has no valid proof. Two callers can spend an allowance:
//   - the agent (pk == agentPk): every policy rule is enforced;
//   - the owner (pk == ownerPk in the policy): no rules apply, which is how
//     an owner reclaims or revokes an allowance.
// The payout is either shielded (a note to recipientPk; chain sees only a
// commitment) or public (amount and address visible; payer still hidden).
template Spend(levels, recipientLevels) {
    // public
    signal input root;
    signal input nullifier;
    signal input newAllowanceCommitment;
    signal input payCommitment;
    signal input publicAmount;
    signal input publicRecipient;
    signal input publicAsset;
    signal input fee;
    signal input now;
    signal input receipt;
    signal input extDataHash;

    // allowance note being spent
    signal input asset;
    signal input remaining;
    signal input agentPk;
    signal input windowId;
    signal input windowSpent;
    signal input rho;
    // its policy
    signal input lifetimeCap;
    signal input windowCap;
    signal input windowLen;
    signal input maxPerTx;
    signal input expiry;
    signal input recipientRoot;
    signal input ownerPk;
    signal input streamRate;
    signal input streamStart;
    // spender and membership
    signal input sk;
    signal input pathIndices[levels];
    signal input pathElements[levels];
    // the payment
    signal input amount;
    signal input isPublic;
    signal input recipientPk;
    signal input payBlinding;
    signal input recipientPathIndices[recipientLevels];
    signal input recipientPathElements[recipientLevels];

    isPublic * (1 - isPublic) === 0;

    // --- who is spending ---
    component pk = PublicKey();
    pk.sk <== sk;
    component isOwner = IsEqual();
    isOwner.in[0] <== pk.pk;
    isOwner.in[1] <== ownerPk;
    component isAgent = IsEqual();
    isAgent.in[0] <== pk.pk;
    isAgent.in[1] <== agentPk;
    (1 - isOwner.out) * (1 - isAgent.out) === 0;
    // Rules are enforced unless the owner is spending.
    signal enforce <== 1 - isOwner.out;

    // --- the note exists ---
    component policy = PolicyHash();
    policy.lifetimeCap <== lifetimeCap;
    policy.windowCap <== windowCap;
    policy.windowLen <== windowLen;
    policy.maxPerTx <== maxPerTx;
    policy.expiry <== expiry;
    policy.recipientRoot <== recipientRoot;
    policy.ownerPk <== ownerPk;
    policy.streamRate <== streamRate;
    policy.streamStart <== streamStart;

    component note = AllowanceCommitment();
    note.asset <== asset;
    note.remaining <== remaining;
    note.agentPk <== agentPk;
    note.policyHash <== policy.out;
    note.windowId <== windowId;
    note.windowSpent <== windowSpent;
    note.rho <== rho;

    component tree = MerkleCheck(levels);
    tree.enabled <== 1;
    tree.root <== root;
    tree.leaf <== note.out;
    for (var i = 0; i < levels; i++) {
        tree.pathElements[i] <== pathElements[i];
        tree.pathIndices[i] <== pathIndices[i];
    }

    component nf = AllowanceNullifier();
    nf.rho <== rho;
    nf.commitment <== note.out;
    nf.out === nullifier;

    // --- ranges ---
    component rAmount = Range(AMOUNT_BITS());
    rAmount.in <== amount;
    component rRemaining = Range(AMOUNT_BITS());
    rRemaining.in <== remaining;
    component rFee = Range(AMOUNT_BITS());
    rFee.in <== fee;
    component rSpent = Range(AMOUNT_BITS());
    rSpent.in <== windowSpent;
    component rCap = Range(AMOUNT_BITS());
    rCap.in <== windowCap;
    component rMax = Range(AMOUNT_BITS());
    rMax.in <== maxPerTx;
    component rNow = Range(TIME_BITS());
    rNow.in <== now;
    component rLen = Range(TIME_BITS());
    rLen.in <== windowLen;
    component rExp = Range(TIME_BITS());
    rExp.in <== expiry;

    // --- lifetime budget: amount <= remaining, always ---
    component okRemaining = Leq(AMOUNT_BITS());
    okRemaining.a <== amount;
    okRemaining.b <== remaining;
    okRemaining.out === 1;

    // --- spending window: newWindowId = floor(now / windowLen) ---
    signal newWindowId;
    signal rem;
    newWindowId <-- now \ windowLen;
    rem <-- now % windowLen;
    now === newWindowId * windowLen + rem;
    component rWid = Range(TIME_BITS());
    rWid.in <== newWindowId;
    component rRem = Range(TIME_BITS());
    rRem.in <== rem;
    component remOk = Lt(TIME_BITS());
    remOk.a <== rem;
    remOk.b <== windowLen;
    remOk.out === 1;

    component sameWindow = IsEqual();
    sameWindow.in[0] <== newWindowId;
    sameWindow.in[1] <== windowId;
    signal carried <== sameWindow.out * windowSpent;
    signal counted <== amount * enforce;
    signal newWindowSpent <== carried + counted;

    // --- per-window cap (0 = unlimited) ---
    component hasCap = NonZero();
    hasCap.in <== windowCap;
    signal capEnforced <== hasCap.out * enforce;
    component okCap = LeqWhen(AMOUNT_BITS());
    okCap.a <== newWindowSpent;
    okCap.b <== windowCap;
    okCap.when <== capEnforced;

    // --- per-transaction cap (0 = unlimited) ---
    component hasMax = NonZero();
    hasMax.in <== maxPerTx;
    signal maxEnforced <== hasMax.out * enforce;
    component okMax = LeqWhen(AMOUNT_BITS());
    okMax.a <== amount;
    okMax.b <== maxPerTx;
    okMax.when <== maxEnforced;

    // --- expiry (0 = never): now < expiry ---
    component hasExpiry = NonZero();
    hasExpiry.in <== expiry;
    signal expEnforced <== hasExpiry.out * enforce;
    component okExp = Lt(TIME_BITS());
    okExp.a <== now;
    okExp.b <== expiry;
    (1 - okExp.out) * expEnforced === 0;

    // --- streaming release (streamRate 0 = none): spentSoFar + amount <= rate * (now - start) ---
    component rRate = Range(TIME_BITS());
    rRate.in <== streamRate;
    component rStart = Range(TIME_BITS());
    rStart.in <== streamStart;
    component hasStream = NonZero();
    hasStream.in <== streamRate;
    signal streamEnforced <== hasStream.out * enforce;
    // elapsed must be non-negative when enforced; a start in the future makes it unprovable
    component startOk = Leq(TIME_BITS());
    startOk.a <== streamStart;
    startOk.b <== now;
    (1 - startOk.out) * streamEnforced === 0;
    signal elapsed <== now - streamStart;
    signal allotted <== streamRate * elapsed;
    signal spentSoFar <== lifetimeCap - remaining;
    component rLifetime = Range(AMOUNT_BITS());
    rLifetime.in <== lifetimeCap;
    component capOk = Leq(AMOUNT_BITS());
    capOk.a <== remaining;
    capOk.b <== lifetimeCap;
    capOk.out === 1;
    component streamOk = LeqWhen(130);
    streamOk.a <== spentSoFar + amount;
    streamOk.b <== allotted;
    streamOk.when <== streamEnforced;

    // --- recipient ---
    component addrKey = AddressKey();
    addrKey.addr <== publicRecipient;
    signal recipientKey <== recipientPk + isPublic * (addrKey.out - recipientPk);

    // allow-list (recipientRoot 0 = any recipient)
    component hasList = NonZero();
    hasList.in <== recipientRoot;
    signal listEnforced <== hasList.out * enforce;
    component listTree = MerkleCheck(recipientLevels);
    listTree.enabled <== listEnforced;
    listTree.root <== recipientRoot;
    listTree.leaf <== recipientKey;
    for (var i = 0; i < recipientLevels; i++) {
        listTree.pathElements[i] <== recipientPathElements[i];
        listTree.pathIndices[i] <== recipientPathIndices[i];
    }

    // --- public leg ---
    publicAmount === amount * isPublic;
    publicAsset === asset * isPublic;
    publicRecipient * (1 - isPublic) === 0;
    fee * (1 - isPublic) === 0;
    component feeOk = Leq(AMOUNT_BITS());
    feeOk.a <== fee;
    feeOk.b <== amount;
    feeOk.out === 1;

    // --- shielded payout note ---
    component pay = NoteCommitment();
    pay.asset <== asset;
    pay.amount <== amount;
    pay.pk <== recipientPk;
    pay.blinding <== payBlinding;
    (payCommitment - pay.out) * (1 - isPublic) === 0;
    payCommitment * isPublic === 0;

    // --- successor allowance ---
    component nextRho = NextRho();
    nextRho.rho <== rho;
    component next = AllowanceCommitment();
    next.asset <== asset;
    next.remaining <== remaining - amount;
    next.agentPk <== agentPk;
    next.policyHash <== policy.out;
    next.windowId <== newWindowId;
    next.windowSpent <== newWindowSpent;
    next.rho <== nextRho.out;
    next.out === newAllowanceCommitment;

    // --- receipt ---
    component rcpt = ReceiptCommitment();
    rcpt.asset <== asset;
    rcpt.amount <== amount;
    rcpt.recipientKey <== recipientKey;
    rcpt.windowId <== newWindowId;
    rcpt.nullifier <== nullifier;
    rcpt.out === receipt;

    signal extDataSquare <== extDataHash * extDataHash;
}

component main { public [root, nullifier, newAllowanceCommitment, payCommitment, publicAmount, publicRecipient, publicAsset, fee, now, receipt, extDataHash] } = Spend(20, 8);
