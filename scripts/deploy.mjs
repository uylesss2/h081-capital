// Deploys the Poseidon hasher, the four verifiers and the pool.
//   DEPLOYER_KEY=0x... BASE_SEPOLIA_RPC=https://... node scripts/deploy.mjs baseSepolia
// Writes deployments/<network>.json. Re-running redeploys everything; the
// pool has no admin so there is nothing to migrate, only a new address.
import { JsonRpcProvider, Wallet as EthersWallet } from 'ethers';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { deployPool } from '../build/sdk/src/client.js'; // npm run sdk:build first

const root = resolve(import.meta.dirname, '..');
const network = process.argv[2] ?? 'robinhoodTestnet';
const rpc = {
  robinhood: process.env.ROBINHOOD_RPC || 'https://rpc.mainnet.chain.robinhood.com',
  robinhoodTestnet: process.env.ROBINHOOD_TESTNET_RPC || 'https://rpc.testnet.chain.robinhood.com',
  baseSepolia: process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org',
  base: process.env.BASE_RPC || 'https://mainnet.base.org',
  localhost: 'http://127.0.0.1:8545',
}[network];
if (network === 'robinhood' && process.env.STIPEND_ALLOW_MAINNET !== '1') throw new Error('mainnet deploy needs STIPEND_ALLOW_MAINNET=1 and an explicit go');
if (!rpc) throw new Error(`unknown network ${network}`);
if (!process.env.DEPLOYER_KEY) throw new Error('DEPLOYER_KEY is required');

const provider = new JsonRpcProvider(rpc);
const signer = new EthersWallet(process.env.DEPLOYER_KEY, provider);
console.log(`deploying to ${network} from ${await signer.getAddress()}`);
const { addresses } = await deployPool(signer, 20);
mkdirSync(join(root, 'deployments'), { recursive: true });
const out = { network, chainId: Number((await provider.getNetwork()).chainId), levels: 20, deployedAt: new Date().toISOString(), ...addresses };
writeFileSync(join(root, 'deployments', `${network}.json`), JSON.stringify(out, null, 2));
console.log(out);
