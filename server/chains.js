export const CHAINS = {
  solana: {
    id: 'solana',
    name: 'Solana',
    type: 'solana',
    alchemySlug: 'solana-mainnet',
    envVar: 'SOLANA_RPC_URL',
    native: { symbol: 'SOL', decimals: 9 },
    explorerTx: (sig) => `https://solscan.io/tx/${sig}`,
    explorerAddr: (a) => `https://solscan.io/account/${a}`,
    tokens: {
      USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCE8BjAdJz',
    },
  },
  robinhood: {
    id: 'robinhood',
    name: 'Robinhood Chain',
    type: 'evm',
    chainId: 4663,
    alchemySlug: 'robinhood-mainnet',
    envVar: 'ROBINHOOD_RPC_URL',
    native: { symbol: 'ETH', decimals: 18 },
    explorerTx: (h) => `https://robinhoodchain.blockscout.com/tx/${h}`,
    explorerAddr: (a) => `https://robinhoodchain.blockscout.com/address/${a}`,
    tokens: {},
  },
  base: {
    id: 'base',
    name: 'Base',
    type: 'evm',
    chainId: 8453,
    alchemySlug: 'base-mainnet',
    envVar: 'BASE_RPC_URL',
    native: { symbol: 'ETH', decimals: 18 },
    explorerTx: (h) => `https://basescan.org/tx/${h}`,
    explorerAddr: (a) => `https://basescan.org/address/${a}`,
    tokens: {
      USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      WETH: '0x4200000000000000000000000000000000000006',
    },
  },
  bnb: {
    id: 'bnb',
    name: 'BNB Smart Chain',
    type: 'evm',
    chainId: 56,
    alchemySlug: 'bnb-mainnet',
    envVar: 'BNB_RPC_URL',
    native: { symbol: 'BNB', decimals: 18 },
    explorerTx: (h) => `https://bscscan.com/tx/${h}`,
    explorerAddr: (a) => `https://bscscan.com/address/${a}`,
    tokens: {
      USDT: '0x55d398326f99059fF775485246999027B3197955',
      USDC: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
      WBNB: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    },
  },
};

// Resolve the RPC URL for a chain. Precedence: request override > env URL > Alchemy key.
export function resolveRpcUrl(chain, overrides = {}) {
  const fromReq = overrides.rpcUrls?.[chain.id];
  if (fromReq) return fromReq;
  if (process.env[chain.envVar]) return process.env[chain.envVar];
  const key = overrides.alchemyKey || process.env.ALCHEMY_API_KEY;
  if (key) return `https://${chain.alchemySlug}.g.alchemy.com/v2/${key}`;
  return null;
}

// Public description for the frontend (no URLs/keys).
export function publicChainList() {
  return Object.values(CHAINS).map((c) => ({
    id: c.id,
    name: c.name,
    type: c.type,
    native: c.native,
    tokens: c.tokens,
    configured: Boolean(process.env[c.envVar] || process.env.ALCHEMY_API_KEY),
  }));
}
