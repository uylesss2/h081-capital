// Test stub of dimension-adapters/helpers/token: records every getSolanaReceived call instead of
// querying Allium, and credits a fixed 1 USDG so the adapter's bookkeeping can be checked.
export const USDG_STUB = '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH';
export const STUB_AMOUNT = '1000000';
export const calls: any[] = [];

export async function getSolanaReceived(args: any) {
  calls.push(args);
  args.balances.add(USDG_STUB, STUB_AMOUNT);
}
