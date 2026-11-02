import { Dependencies, FetchOptions, SimpleAdapter } from "../adapters/types";
import { CHAIN } from "../helpers/chains";
import { getSolanaReceived } from "../helpers/token";
import { METRIC } from "../helpers/metrics";

/**
 * H081 Capital (https://h081.xyz): a private bank for AI agents on Solana. Live on Solana mainnet,
 * not audited yet.
 *
 * The protocol has two fee sources, both paid in USDG into the treasury's USDG token account:
 *  - relay fee: 0.20% of the public amount of every relayed withdrawal / spend (paid by the user's
 *    proof, transferred out of the bank vault by the stipend_pool program);
 *  - loan origination fee: 0.25% of the principal of every funded loan (stream_loan::fund, a
 *    compile-time constant, deducted from the lender's payout).
 * 100% of both goes to the protocol treasury (a Squads multisig vault), so revenue = fees.
 *
 * H081 token trading / creator fees are NOT protocol fees and are excluded: they never reach the
 * treasury, and transfers signed by or sent from the team's wallets are filtered out below.
 */

// Protocol treasury (Squads v4 vault) and its USDG associated token account (Token-2022)
const TREASURY = "EGvxic665gsar6K3YsnuUH4qPTnv1Rb2rMu2F3GpkZGq";
const TREASURY_USDG_ATA = "DxpmCZYAoDKpHmA5vWuopUrf3UVuGnPvditVrN9xDwDo";
// USDG (Token-2022, 6 decimals): the only fee asset today
const USDG = "2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH";

// Team wallets: transfers from them (top-ups, tests) or signed by them are not fees.
const DEPLOYER = "5WCpirBe1wHUk6PL2nU97pj87PtyaqH9S6UJUbd5z2W1";
const TEAM_WALLETS = [
  "2wjxKzH7fVGpjcA9KpjDBDHjSAhz7u8ZgMLnVPVGSkDP",
  "FZEMfMN7hhQcKPHRt2kb9ig5XArMvK5LqfSTXpQ1j4DZ",
  "5XJNtM7a9ocRL8f8vsyNVmQoekutCFJkGNXNQbkJP4bw",
];
const INTERNAL = [TREASURY, TREASURY_USDG_ATA, DEPLOYER, ...TEAM_WALLETS];

const LABEL_FEES = METRIC.PROTOCOL_FEES;

async function fetch(options: FetchOptions) {
  const received = options.createBalances();
  await getSolanaReceived({
    options,
    balances: received,
    targets: [TREASURY, TREASURY_USDG_ATA],
    mints: [USDG],
    blacklists: INTERNAL,
    blacklist_signers: INTERNAL,
  });

  const dailyFees = options.createBalances();
  dailyFees.addBalances(received, LABEL_FEES);

  return {
    dailyFees,
    dailyRevenue: dailyFees,
    dailyProtocolRevenue: dailyFees,
  };
}

const methodology = {
  Fees:
    "USDG received by the H081 protocol treasury: the 0.20% relay fee on relayed withdrawals and spends plus the 0.25% loan origination fee on funded loans. " +
    "Transfers from or signed by the team's wallets are excluded. H081 token trading and creator fees are not protocol fees and are not counted.",
  Revenue:
    "Same as Fees: 100% of the relay and origination fees go to the protocol treasury; there is no supply-side share.",
  ProtocolRevenue:
    "Same as Revenue: all fees are kept by the protocol treasury (a Squads multisig vault).",
};

const breakdownMethodology = {
  Fees: {
    [LABEL_FEES]: "0.20% relay fee on relayed withdrawals / spends and 0.25% loan origination fee, both paid in USDG to the treasury.",
  },
  Revenue: {
    [LABEL_FEES]: "100% of the relay and origination fees, kept by the protocol treasury.",
  },
  ProtocolRevenue: {
    [LABEL_FEES]: "100% of the relay and origination fees, kept by the protocol treasury.",
  },
};

const adapter: SimpleAdapter = {
  version: 2,
  pullHourly: true,
  fetch,
  chains: [CHAIN.SOLANA],
  start: "2026-10-31",
  dependencies: [Dependencies.ALLIUM],
  methodology,
  breakdownMethodology,
};

export default adapter;
