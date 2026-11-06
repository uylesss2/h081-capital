// Records real relay payloads (a withdrawal and a public spend, with Groth16 proofs) for test/relayer/proof-verify.test.ts:
//   npx tsx test/relayer/fixtures/make-relay-fixtures.mts <build/circuits with the zkeys>
// writes relay-payloads.json next to this file. Proving needs the circuits' zkeys and wasm (npm run circuits:setup);
// the test only needs the verifying keys, copied into fixtures/circuits/<name>/<name>.vkey.json from the same build
// (the fixtures were last made from the ceremony build: docs/ceremony/<name>/<name>.vkey.json, the keys the mainnet
// program embeds). Re-run both steps together whenever the circuits change. The keys in the file are throwaway test keys.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { type Allowance, type Note, allowanceCommitment, initCrypto, noteCommitment, randomField, randomKeys } from '../../../src/crypto.js';
import { noteMemo, randomViewingKey } from '../../../src/encryption.js';
import { LEVELS, dummyNoteInput, spendInput, transactInput } from '../../../src/inputs.js';
import { MerkleTree } from '../../../src/merkle.js';
import { Prover } from '../../../src/prover.js';
import { concatBytes, encodeProof, fieldOf } from '../../../src/solana/field.js';
import { type SpendArgs, encodeSpendArgs, encodeSpendExt, encodeTransactArgs, encodeTransactExt, extDataHash } from '../../../src/solana/ops.js';
import { toB64 } from '../../../src/solana/relay.js';
import { solAllowanceMemo } from '../../../src/solana/wallet.js';

const circuitsDir = process.argv[2];
if (!circuitsDir) throw new Error('usage: make-relay-fixtures.mts <build/circuits>');
const prover = new Prover(circuitsDir);
await initCrypto();

const payer = Keypair.generate();
const treasury = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const recipientOwner = Keypair.generate().publicKey;
const feeAta = getAssociatedTokenAddressSync(mint, treasury, true, TOKEN_PROGRAM_ID);
const recipientAta = getAssociatedTokenAddressSync(mint, recipientOwner, true, TOKEN_PROGRAM_ID);
const asset = fieldOf(mint);
const owner = randomKeys();
const agent = randomKeys();
const view = randomViewingKey();
const AMOUNT = 5_000_000n;
const FEE = 10_000n; // 20 bps of 5 USDG
const NOW = 1_800_000_000n;

// ---- withdrawal: a 6 USDG note, 5 USDG to the recipient, 0.01 fee, 0.99 change
const tree = new MerkleTree(LEVELS);
const funded: Note = { asset, amount: 6_000_000n, pk: owner.pk, blinding: randomField() };
const idx = tree.insert(noteCommitment(funded));
const outputs: [Note, Note] = [{ asset, amount: 990_000n, pk: owner.pk, blinding: randomField() }, { asset, amount: 0n, pk: owner.pk, blinding: randomField() }];
const tExt = encodeTransactExt({
  recipient: recipientAta, relayer: payer.publicKey, feeRecipient: feeAta, extAmount: -AMOUNT, fee: FEE,
  encryptedOutputs: [noteMemo(outputs[0], view.pub), noteMemo(outputs[1], view.pub)],
});
const tHash = extDataHash(tExt);
const t = transactInput({
  root: tree.root, asset, inputs: [{ note: funded, keys: owner, path: tree.path(idx) }, dummyNoteInput(asset, owner, tree)], outputs,
  publicAmount: -AMOUNT - FEE, extDataHash: tHash,
});
console.log('proving transact...');
const tProof = await prover.prove('transact', t.input);
const transact = concatBytes(
  encodeProof(tProof.proof),
  encodeTransactArgs({ root: tree.root, publicAmount: t.publicAmount, extDataHash: tHash, inputNullifiers: t.inputNullifier as [bigint, bigint], outputCommitments: t.outputCommitment as [bigint, bigint] }),
  tExt,
);

// ---- public spend: an agent pays 5 USDG of a 10 USDG allowance to the recipient's wallet, 0.01 fee
const allowance: Allowance = {
  asset, remaining: 10_000_000n, agentPk: agent.pk, windowId: 0n, windowSpent: 0n, rho: randomField(), pledgePaid: 0n,
  policy: { lifetimeCap: 10_000_000n, windowCap: 0n, windowLen: 86_400n, maxPerTx: 0n, expiry: 0n, recipientRoot: 0n, ownerPk: owner.pk, streamRate: 0n, streamStart: 0n, lender: 0n, pledgeBps: 0n },
};
const sTree = new MerkleTree(LEVELS);
const sIdx = sTree.insert(allowanceCommitment(allowance));
const base = { root: sTree.root, allowance, path: sTree.path(sIdx), spender: agent, amount: AMOUNT, now: NOW, fee: FEE, publicTo: fieldOf(recipientOwner) };
const draft = spendInput({ ...base, extDataHash: 0n });
const sExt = encodeSpendExt({
  relayer: payer.publicKey, feeRecipient: feeAta,
  encryptedAllowance: solAllowanceMemo(draft.next, { owner: view.pub, agent: randomViewingKey().pub }, undefined, { mint }),
  encryptedPayment: new Uint8Array(), encryptedLender: new Uint8Array(),
});
const sHash = extDataHash(sExt);
const s = spendInput({ ...base, extDataHash: sHash });
console.log('proving spend...');
const sProof = await prover.prove('spend', s.input);
const args: SpendArgs = {
  root: sTree.root, nullifier: s.nullifier, newAllowanceCommitment: s.newAllowanceCommitment, payCommitment: s.payCommitment, publicAmount: s.net,
  publicRecipient: recipientOwner, publicAsset: mint, fee: s.fee, timestamp: NOW, receipt: s.receipt, lenderAmount: s.lenderAmount,
  lenderAddr: s.input.lenderAddr as bigint, loanRef: s.input.loanRef as bigint, isLenderClaim: false, extDataHash: sHash,
};
const spend = concatBytes(encodeProof(sProof.proof), encodeSpendArgs(args), sExt);

const str = (x: bigint) => x.toString();
const out = {
  note: 'Real relay payloads (Groth16 proofs) for the relayer tests; made by make-relay-fixtures.mts. Throwaway keys.',
  payerSecretKey: Buffer.from(payer.secretKey).toString('base64'),
  treasury: treasury.toBase58(), mint: mint.toBase58(), recipientOwner: recipientOwner.toBase58(), amount: str(AMOUNT), fee: str(FEE),
  transact: { root: str(tree.root), nullifiers: t.inputNullifier.map(str), payload: toB64(transact), publicSignals: tProof.raw.publicSignals },
  spend: { root: str(sTree.root), nullifier: str(s.nullifier), timestamp: str(NOW), payload: toB64(spend), publicSignals: sProof.raw.publicSignals },
};
const file = join(dirname(fileURLToPath(import.meta.url)), 'relay-payloads.json');
writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
console.log(`wrote ${file}: transact ${transact.length} bytes, spend ${spend.length} bytes`);
console.log(`verified with the build's keys: transact ${await prover.verify('transact', tProof)}, spend ${await prover.verify('spend', sProof)}`);
console.log(`spend recipient field ${fieldOf(recipientOwner)} vs signal ${sProof.raw.publicSignals[5]}; asset ${asset} vs ${sProof.raw.publicSignals[6]}`);
void PublicKey;
