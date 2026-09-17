# chainsight

Find specific on-chain transactions by **token**, **amount** and **time window** across
Solana, Robinhood Chain, Base and BNB Smart Chain, using Alchemy RPC endpoints.

## Quick start

```bash
npm install
cp .env.example .env      # add your ALCHEMY_API_KEY
npm start                 # http://127.0.0.1:3000
```

You can also leave `.env` empty and paste the Alchemy key (or per-chain RPC URLs) into
the **Settings** panel in the UI. Those values stay in your browser's localStorage and
are sent only to this local server.

## Chains and endpoints

| Chain           | Alchemy slug        | Search method                                                                 |
| --------------- | ------------------- | ----------------------------------------------------------------------------- |
| Solana          | `solana-mainnet`    | `getSignaturesForAddress` + `getTransaction`, balance deltas per mint / SOL   |
| Robinhood Chain | `robinhood-mainnet` | `alchemy_getAssetTransfers`, falls back to `eth_getLogs`                      |
| Base            | `base-mainnet`      | `alchemy_getAssetTransfers`, falls back to `eth_getLogs`                      |
| BNB Smart Chain | `bnb-mainnet`       | `eth_getLogs` (Alchemy's Transfers API is not offered on BNB)                 |

Default URL is `https://<slug>.g.alchemy.com/v2/<ALCHEMY_API_KEY>`. Override any chain
with `SOLANA_RPC_URL`, `ROBINHOOD_RPC_URL`, `BASE_RPC_URL`, `BNB_RPC_URL`, or in the UI.

## How a search works

**EVM chains** (Base, BNB, Robinhood)

1. The time window is converted to a block range by binary-searching block timestamps.
2. `alchemy_getAssetTransfers` is queried for the token contract (or native coin) in that
   range, optionally filtered by wallet address / direction, and paginated.
3. If the RPC does not support that method, ERC-20 `Transfer` logs are fetched with
   `eth_getLogs` in adaptive block chunks. Native-coin transfers cannot be found this
   way, so on such RPCs choose a token or use an RPC with the Transfers API.
4. Amounts are compared in raw integer units using the token's `decimals()`, with an
   optional ± percentage tolerance.

**Solana**

1. Signatures are walked backwards for the wallet address you give (recommended). If you
   give no address, the token mint itself is used as the anchor. That is best effort:
   plain SPL `transfer` instructions do not reference the mint, but `transferChecked`,
   mints/burns and most DEX swaps do.
2. Each confirmed transaction in the window is fetched and the pre/post token balances
   (or lamport balances for SOL, net of the fee) are diffed for the mint.
3. The net change for the address is matched against the amount.

Native SOL searches require a wallet address.

## Limits and tips

- Windows are capped at 90 days per search. Robinhood Chain produces ~10 blocks per
  second, so prefer narrow windows there.
- Adding a wallet address makes every chain far faster and avoids truncation.
- Results are capped by *Max results*; the log tells you if a search was truncated.
- Free-tier Alchemy keys are rate limited; the client backs off and retries on 429s.
- Export the results table as CSV with the button above the table.

## API

`POST /api/search` streams NDJSON lines of `{type: "progress" | "result" | "done" | "error"}`.

```json
{
  "chain": "base",
  "token": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "amount": "1500",
  "tolerance": 0.5,
  "from": "2026-09-01T00:00:00Z",
  "to": "2026-09-02T00:00:00Z",
  "address": "0x…",
  "direction": "in",
  "limit": 500
}
```

`token` is `"native"` or a contract / mint address. `amount` blank means any amount.
