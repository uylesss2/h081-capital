// A read-only on-chain check of a disclose proof: ONE simulated transaction
//   [compute-unit limit, buffer_open(seed, len), buffer_write(0, payload), verify_disclosure]
// with sigVerify off and the blockhash replaced, so nothing is signed or sent and the fee payer can be any funded,
// system-owned account (its key is never needed). SolanaPool.verifyDisclosure stages the buffer with three SENT
// transactions even in 'simulate' mode; this does not (docs/SOLVENCY-SPEC.md 3.3).
import { ComputeBudgetProgram, type Connection, type PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { randomSeed } from './buffer.js';
import { bufferPda } from './pda.js';
import { POOL_ERROR, bufferOpenIx, bufferWriteIx, verifyDisclosureIx } from './program.js';

/** Largest serialized transaction the cluster accepts. */
export const PACKET_DATA_SIZE = 1232;
/** CU limit for the simulated check: verify_disclosure measured ~92k (solana/compute-units.json) plus the buffer. */
export const DISCLOSE_SIM_CU_LIMIT = 300_000;

export interface DisclosureSimulation {
  /** true: the deployed verify_disclosure accepted the proof (known root + Groth16) */
  ok: boolean;
  /** compute units the simulation consumed */
  computeUnits: number;
  /** serialized size of the one transaction (signature placeholder included) */
  txBytes: number;
  /** false: the transaction would not fit in a packet; nothing was simulated */
  fits: boolean;
  /** the program error name or the RPC error, when not ok */
  error?: string;
  logs: string[];
}

const ERROR_NAME: Record<number, string> = Object.fromEntries(Object.entries(POOL_ERROR).map(([k, v]) => [v, k]));

/** The one transaction, unsigned, compiled against `blockhash`. */
export function disclosureCheckTx(programId: PublicKey, feePayer: PublicKey, payload: Uint8Array, blockhash: string, seed = randomSeed()): VersionedTransaction {
  const msg = new TransactionMessage({
    payerKey: feePayer, recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: DISCLOSE_SIM_CU_LIMIT }),
      bufferOpenIx(programId, feePayer, seed, payload.length),
      bufferWriteIx(programId, feePayer, seed, 0, payload),
      verifyDisclosureIx(programId, bufferPda(programId, feePayer, seed)),
    ],
  }).compileToV0Message();
  return new VersionedTransaction(msg);
}

/**
 * Simulates verify_disclosure over `payload` (encodeProof || encodeDiscloseArgs, 448 bytes) in one transaction. Read
 * only: sigVerify false, replaceRecentBlockhash true. `feePayer` pays the (simulated) buffer rent and fee, so it must
 * hold some SOL; its key is not needed.
 */
export async function simulateDisclosureCheck(connection: Connection, programId: PublicKey, feePayer: PublicKey, payload: Uint8Array): Promise<DisclosureSimulation> {
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const tx = disclosureCheckTx(programId, feePayer, payload, blockhash);
  const txBytes = tx.serialize().length;
  if (txBytes > PACKET_DATA_SIZE) return { ok: false, computeUnits: 0, txBytes, fits: false, error: `the check is ${txBytes} bytes, over the ${PACKET_DATA_SIZE}-byte packet limit`, logs: [] };
  const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' });
  const logs = sim.value.logs ?? [];
  const computeUnits = sim.value.unitsConsumed ?? -1;
  if (!sim.value.err) return { ok: true, computeUnits, txBytes, fits: true, logs };
  const m = /custom program error: 0x([0-9a-f]+)/i.exec(logs.join('\n')) ?? /"Custom":(\d+)/.exec(JSON.stringify(sim.value.err));
  const code = m ? (m[0].startsWith('custom') ? parseInt(m[1], 16) : parseInt(m[1], 10)) : undefined;
  return { ok: false, computeUnits, txBytes, fits: true, error: code !== undefined ? (ERROR_NAME[code] ?? `custom error ${code}`) : JSON.stringify(sim.value.err), logs };
}
