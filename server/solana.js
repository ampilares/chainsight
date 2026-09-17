// Solana scanner.
//
// Solana has no "all transfers of a mint in a time range" RPC, so we walk
// getSignaturesForAddress for an anchor account and inspect each transaction's
// balance deltas. The anchor is the wallet address when given; otherwise the mint
// itself (best effort: only instructions that reference the mint account, such
// as transferChecked, mints/burns and most DEX swaps, will appear there).

import { rpc, mapLimit } from './rpc.js';
import { formatUnits, parseUnits, makeAmountMatcher, isoFromUnix } from './util.js';

const isBase58 = (s) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s || '');

async function mintDecimals(url, mint) {
  const res = await rpc(url, 'getTokenSupply', [mint]);
  const d = res?.value?.decimals;
  if (d === undefined || d === null) throw new Error(`Could not read decimals for mint ${mint}`);
  return Number(d);
}

async function collectSignatures(url, anchor, fromTs, toTs, emit, signal) {
  const sigs = [];
  let before;
  let pages = 0;
  const MAX_PAGES = 40; // 40k signatures
  let truncated = false;
  while (true) {
    if (signal.aborted) break;
    const params = [anchor, { limit: 1000, commitment: 'confirmed', ...(before ? { before } : {}) }];
    const batch = await rpc(url, 'getSignaturesForAddress', params);
    pages++;
    if (!batch || batch.length === 0) break;
    let reachedStart = false;
    for (const s of batch) {
      if (s.blockTime === null || s.blockTime === undefined) continue;
      if (s.blockTime > toTs) continue;
      if (s.blockTime < fromTs) { reachedStart = true; break; }
      if (s.err) continue;
      sigs.push(s);
    }
    const oldest = batch[batch.length - 1];
    emit({ type: 'progress', message: `Signatures: ${sigs.length} in window so far (oldest seen ${oldest.blockTime ? isoFromUnix(oldest.blockTime) : 'n/a'})` });
    if (reachedStart || batch.length < 1000) break;
    before = oldest.signature;
    if (pages >= MAX_PAGES) { truncated = true; break; }
  }
  return { sigs, truncated };
}

function tokenDeltas(tx, mint) {
  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));
  const pre = new Map();
  for (const b of tx.meta.preTokenBalances || []) if (b.mint === mint) pre.set(b.accountIndex, b);
  const post = new Map();
  for (const b of tx.meta.postTokenBalances || []) if (b.mint === mint) post.set(b.accountIndex, b);
  const idxs = new Set([...pre.keys(), ...post.keys()]);
  const out = [];
  for (const i of idxs) {
    const p = pre.get(i);
    const q = post.get(i);
    const before = BigInt(p?.uiTokenAmount?.amount || '0');
    const after = BigInt(q?.uiTokenAmount?.amount || '0');
    out.push({ account: keys[i], owner: q?.owner || p?.owner || null, delta: after - before });
  }
  return out;
}

function nativeDeltas(tx) {
  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey));
  const fee = BigInt(tx.meta.fee || 0);
  return keys.map((account, i) => {
    let delta = BigInt(tx.meta.postBalances[i]) - BigInt(tx.meta.preBalances[i]);
    if (i === 0) delta += fee; // fee payer: exclude the fee from the transfer amount
    return { account, owner: account, delta };
  });
}

export async function searchSolana({ chain, url, token, amount, tolerance, fromTs, toTs, address, direction, limit, emit, signal }) {
  const native = token === 'native';
  if (!native && !isBase58(token)) throw new Error('Token must be "native" or a base58 mint address');
  if (address && !isBase58(address)) throw new Error('Address must be a base58 account');
  if (native && !address) throw new Error('Searching native SOL transfers requires a wallet address');

  const decimals = native ? chain.native.decimals : await mintDecimals(url, token);
  const symbol = native ? 'SOL' : Object.entries(chain.tokens).find(([, m]) => m === token)?.[0] || token.slice(0, 6) + '…';
  emit({ type: 'progress', message: `Token ${symbol} (${decimals} decimals)` });
  const targetRaw = amount ? parseUnits(amount, decimals) : null;
  const match = makeAmountMatcher(targetRaw, tolerance);

  const anchor = address || token;
  emit({ type: 'progress', message: `Walking signatures for ${anchor}${address ? '' : ' (mint anchor: best effort, plain SPL transfer instructions that omit the mint will not appear)'}` });
  const { sigs, truncated: sigTruncated } = await collectSignatures(url, anchor, fromTs, toTs, emit, signal);
  emit({ type: 'progress', message: `${sigs.length} confirmed signatures in window. Fetching transactions…` });

  let found = 0;
  let processed = 0;
  let truncated = sigTruncated;
  let reason = sigTruncated ? 'signature page limit' : undefined;
  const failed = [];

  const inspect = async (s, isRetry) => {
    if (signal.aborted || found >= limit) return;
    let tx;
    try {
      tx = await rpc(url, 'getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);
    } catch (err) {
      if (!isRetry) { failed.push(s); return; }
      emit({ type: 'progress', message: `getTransaction failed for ${s.signature.slice(0, 12)}…: ${err.message}` });
      return;
    }
    processed++;
    if (processed % 25 === 0) emit({ type: 'progress', message: `Inspected ${processed}/${sigs.length} transactions, ${found} matches` });
    if (!tx || !tx.meta || tx.meta.err) return;

    const deltas = native ? nativeDeltas(tx) : tokenDeltas(tx, token);
    let hits = [];
    if (address) {
      const mine = deltas.filter((d) => d.owner === address || d.account === address);
      if (mine.length === 0) return;
      const net = mine.reduce((acc, d) => acc + d.delta, 0n);
      const abs = net < 0n ? -net : net;
      if (net === 0n || !match(abs)) return;
      const dir = net > 0n ? 'in' : 'out';
      if (direction && direction !== 'any' && direction !== dir) return;
      const others = deltas.filter((d) => !(d.owner === address || d.account === address));
      const counter = others
        .filter((d) => (net > 0n ? d.delta < 0n : d.delta > 0n))
        .sort((a, b) => ((a.delta < 0n ? -a.delta : a.delta) > (b.delta < 0n ? -b.delta : b.delta) ? -1 : 1))[0];
      hits.push({ raw: abs, from: dir === 'out' ? address : counter?.owner || counter?.account || null, to: dir === 'in' ? address : counter?.owner || counter?.account || null, dir });
    } else {
      const negs = deltas.filter((d) => d.delta < 0n && match(-d.delta));
      const poss = deltas.filter((d) => d.delta > 0n && match(d.delta));
      if (negs.length === 0 && poss.length === 0) return;
      const n = negs[0];
      const p = poss[0];
      hits.push({ raw: n ? -n.delta : p.delta, from: n?.owner || n?.account || null, to: p?.owner || p?.account || null, dir: null });
    }

    for (const h of hits) {
      if (found >= limit) { truncated = true; reason = 'result limit'; return; }
      found++;
      emit({ type: 'result', row: {
        chain: chain.id,
        hash: s.signature,
        timestamp: s.blockTime ? isoFromUnix(s.blockTime) : null,
        block: String(s.slot),
        from: h.from,
        to: h.to,
        amountRaw: h.raw.toString(),
        amount: formatUnits(h.raw, decimals),
        symbol,
        token: native ? 'native' : token,
        direction: h.dir,
        explorer: chain.explorerTx(s.signature),
        source: 'getSignaturesForAddress + getTransaction',
      } });
    }
  };

  await mapLimit(sigs, 6, (s) => inspect(s, false));
  if (failed.length && !signal.aborted && found < limit) {
    emit({ type: 'progress', message: `Retrying ${failed.length} transaction(s) that hit rate limits…` });
    await new Promise((r) => setTimeout(r, 2000));
    await mapLimit(failed, 2, (s) => inspect(s, true));
  }
  const skipped = sigs.length - processed;
  if (skipped > 0) emit({ type: 'progress', message: `${skipped} transaction(s) could not be fetched and were skipped` });

  return { found, scanned: processed, truncated, reason };
}
