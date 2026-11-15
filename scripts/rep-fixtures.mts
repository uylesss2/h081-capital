// Writes the rep_registry suite's stream_loan fixture accounts (test/solana/rep-fixtures.ts) for --account-dir, and
// the clock they were made for (meta.json), into solana/test-ledger/rep-accounts/. Localnet only.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fixtureAccounts } from '../test/solana/rep-fixtures.js';

const dir = resolve(import.meta.dirname, '..', 'solana', 'test-ledger', 'rep-accounts');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const now = BigInt(Math.floor(Date.now() / 1000));
const accts = await fixtureAccounts(now);
for (const a of accts) writeFileSync(join(dir, `${a.pubkey}.json`), JSON.stringify(a));
writeFileSync(join(dir, '..', 'rep-meta.json'), JSON.stringify({ now: now.toString() }));
console.log(`wrote ${accts.length} fixture accounts to ${dir}`);
