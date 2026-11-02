/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: '0.8.28',
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'cancun',
    },
  },
  paths: {
    sources: './contracts',
    artifacts: './build/artifacts',
    cache: './build/cache',
  },
  networks: {
    hardhat: {
      allowUnlimitedContractSize: false,
      // Robinhood Chain forks need the hardfork spelled out or a fork can read state but not execute.
      chains: { 4663: { hardforkHistory: { cancun: 0 } } },
    },
    // Robinhood Chain: Arbitrum Orbit L2, chain id 4663, gas in ETH, Cancun EVM. Launch target.
    robinhood: {
      url: process.env.ROBINHOOD_RPC || 'https://rpc.mainnet.chain.robinhood.com',
      chainId: 4663,
      accounts: process.env.DEPLOYER_KEY ? [process.env.DEPLOYER_KEY] : [],
    },
    robinhoodTestnet: {
      url: process.env.ROBINHOOD_TESTNET_RPC || 'https://rpc.testnet.chain.robinhood.com',
      chainId: 46630,
      accounts: process.env.DEPLOYER_KEY ? [process.env.DEPLOYER_KEY] : [],
    },
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC || 'https://sepolia.base.org',
      accounts: process.env.DEPLOYER_KEY ? [process.env.DEPLOYER_KEY] : [],
    },
    base: {
      url: process.env.BASE_RPC || 'https://mainnet.base.org',
      accounts: process.env.DEPLOYER_KEY ? [process.env.DEPLOYER_KEY] : [],
    },
  },
};
