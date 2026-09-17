// EVM scanner: Base, BNB Smart Chain, Robinhood Chain (and any other EVM RPC).
//
// Strategy:
//   1. Map the time window to a block range via binary search on block timestamps.
//   2. Try Alchemy's Transfers API (alchemy_getAssetTransfers) which is indexed and fast.
//   3. If the RPC doesn't support it (e.g. BNB), fall back to eth_getLogs over the
//      ERC-20 Transfer topic in adaptive block chunks. Native-coin transfers have no
//      log, so the fallback only covers tokens.

import { rpc, RpcError, mapLimit } from './rpc.js';
import { hex, fromHex, formatUnits, parseUnits, makeAmountMatcher, isoFromUnix } from './util.js';

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const SEL_DECIMALS = '0x313ce567';
const SEL_SYMBOL = '0x95d89b41';

const isAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(a || '');
const padTopic = (addr) => '0x' + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const topicToAddr = (t) => '0x' + t.slice(-40);

async function getBlockHeader(url, numOrTag, cache) {
  const key = typeof numOrTag === 'bigint' ? numOrTag.toString() : numOrTag;
  if (cache.has(key)) return cache.get(key);
  const tag = typeof numOrTag === 'bigint' ? hex(numOrTag) : numOrTag;
  const b = await rpc(url, 'eth_getBlockByNumber', [tag, false]);
  if (!b) throw new Error(`Block ${tag} not found`);
  const out = { number: fromHex(b.number), timestamp: Number(fromHex(b.timestamp)) };
  cache.set(out.number.toString(), out);
  return out;
}

// First block whose timestamp >= ts. Returns latest+1 if ts is in the future.
async function firstBlockAtOrAfter(url, ts, latest, cache) {
  if (ts > latest.timestamp) return latest.number + 1n;
  let lo = 0n;
  let hi = latest.number;
  // Interpolation guess to shrink the range, then plain binary search.
  const genesisLike = await getBlockHeader(url, 1n, cache).catch(() => null);
  if (genesisLike && genesisLike.timestamp < ts) {
    const span = latest.number - genesisLike.number;
    const secs = latest.timestamp - genesisLike.timestamp;
    if (span > 0n && secs > 0) {
      const guess = genesisLike.number + (span * BigInt(Math.max(0, ts - genesisLike.timestamp))) / BigInt(secs);
      const slack = span / 64n + 1000n;
      lo = guess > slack ? guess - slack : 0n;
      hi = guess + slack < latest.number ? guess + slack : latest.number;
      const loB = await getBlockHeader(url, lo, cache);
      const hiB = await getBlockHeader(url, hi, cache);
      if (loB.timestamp >= ts) { lo = 0n; }
      if (hiB.timestamp < ts) { hi = latest.number; }
    }
  }
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const b = await getBlockHeader(url, mid, cache);
    if (b.timestamp >= ts) hi = mid;
    else lo = mid + 1n;
  }
  return lo;
}

export async function blockRangeForWindow(url, fromTs, toTs, cache, emit) {
  const latest = await getBlockHeader(url, 'latest', cache);
  emit({ type: 'progress', message: `Latest block ${latest.number} (${isoFromUnix(latest.timestamp)})` });
  const fromBlock = await firstBlockAtOrAfter(url, fromTs, latest, cache);
  const afterTo = await firstBlockAtOrAfter(url, toTs + 1, latest, cache);
  const toBlock = afterTo - 1n;
  return { fromBlock, toBlock, latest };
}

function decodeSymbol(data) {
  if (!data || data === '0x') return null;
  const h = data.slice(2);
  try {
    if (h.length === 64) {
      // bytes32
      return Buffer.from(h, 'hex').toString('utf8').replace(/\0+$/, '') || null;
    }
    const len = Number(BigInt('0x' + h.slice(64, 128)));
    return Buffer.from(h.slice(128, 128 + len * 2), 'hex').toString('utf8') || null;
  } catch {
    return null;
  }
}

export async function tokenMeta(url, chain, token) {
  if (token === 'native') return { decimals: chain.native.decimals, symbol: chain.native.symbol };
  const [d, s] = await Promise.all([
    rpc(url, 'eth_call', [{ to: token, data: SEL_DECIMALS }, 'latest']),
    rpc(url, 'eth_call', [{ to: token, data: SEL_SYMBOL }, 'latest']).catch(() => null),
  ]);
  if (!d || d === '0x') throw new Error(`No decimals() at ${token}. Is this an ERC-20 contract on this chain?`);
  return { decimals: Number(BigInt(d)), symbol: decodeSymbol(s) || token.slice(0, 10) };
}

function isUnsupported(err) {
  if (!(err instanceof RpcError)) return false;
  if (err.code === -32601 || err.code === -32600) return true;
  return /not (supported|available|found)|unsupported|does not exist|unknown method|invalid method/i.test(err.message || '');
}

async function scanAlchemyTransfers(ctx) {
  const { url, token, fromBlock, toBlock, address, direction, match, decimals, symbol, emit, limit, signal, chain } = ctx;
  const native = token === 'native';
  const base = {
    fromBlock: hex(fromBlock),
    toBlock: hex(toBlock),
    category: native ? ['external'] : ['erc20'],
    withMetadata: true,
    excludeZeroValue: false,
    maxCount: '0x3e8',
    order: 'asc',
  };
  if (!native) base.contractAddresses = [token];

  const passes = [];
  if (address && direction === 'in') passes.push({ toAddress: address });
  else if (address && direction === 'out') passes.push({ fromAddress: address });
  else if (address) passes.push({ fromAddress: address }, { toAddress: address });
  else passes.push({});

  const seen = new Set();
  let found = 0;
  let scanned = 0;
  let pages = 0;
  const MAX_PAGES = 200;

  for (const pass of passes) {
    let pageKey;
    do {
      if (signal.aborted) return { found, scanned, truncated: false };
      const params = { ...base, ...pass };
      if (pageKey) params.pageKey = pageKey;
      const res = await rpc(url, 'alchemy_getAssetTransfers', [params]);
      pages++;
      const transfers = res?.transfers || [];
      scanned += transfers.length;
      for (const t of transfers) {
        const id = t.uniqueId || `${t.hash}:${t.category}:${t.from}:${t.to}:${t.rawContract?.value}`;
        if (seen.has(id)) continue;
        seen.add(id);
        let raw;
        if (t.rawContract?.value) raw = BigInt(t.rawContract.value);
        else if (t.value !== null && t.value !== undefined) raw = parseUnits(String(t.value), decimals);
        else continue;
        if (!match(raw)) continue;
        found++;
        emit({
          type: 'result',
          row: {
            chain: chain.id,
            hash: t.hash,
            timestamp: t.metadata?.blockTimestamp || null,
            block: fromHex(t.blockNum).toString(),
            from: t.from,
            to: t.to,
            amountRaw: raw.toString(),
            amount: formatUnits(raw, decimals),
            symbol,
            token: native ? 'native' : token,
            explorer: chain.explorerTx(t.hash),
            source: 'alchemy_getAssetTransfers',
          },
        });
        if (found >= limit) return { found, scanned, truncated: true, reason: 'result limit' };
      }
      pageKey = res?.pageKey;
      emit({ type: 'progress', message: `Transfers API: scanned ${scanned} transfers, ${found} matches${pageKey ? ', more pages…' : ''}` });
      if (pages >= MAX_PAGES) return { found, scanned, truncated: true, reason: 'page limit' };
    } while (pageKey);
  }
  return { found, scanned, truncated: false };
}

async function scanLogs(ctx) {
  const { url, token, fromBlock, toBlock, address, direction, match, decimals, symbol, emit, limit, signal, chain, cache } = ctx;
  if (token === 'native') {
    throw new Error('This RPC does not support alchemy_getAssetTransfers, and native-coin transfers cannot be found via eth_getLogs. Use a token, or point this chain at an RPC with the Transfers API.');
  }
  const passes = [];
  if (address && direction === 'in') passes.push([TRANSFER_TOPIC, null, padTopic(address)]);
  else if (address && direction === 'out') passes.push([TRANSFER_TOPIC, padTopic(address), null]);
  else if (address) passes.push([TRANSFER_TOPIC, padTopic(address), null], [TRANSFER_TOPIC, null, padTopic(address)]);
  else passes.push([TRANSFER_TOPIC]);

  const seen = new Set();
  const matched = [];
  let scanned = 0;
  let step = 20000n;
  const MIN_STEP = 10n;
  const MAX_STEP = 500000n;
  const total = toBlock - fromBlock + 1n;
  let truncated = false;
  let reason;

  outer: for (const topics of passes) {
    let cur = fromBlock;
    let okStreak = 0;
    while (cur <= toBlock) {
      if (signal.aborted) break outer;
      const end = cur + step - 1n > toBlock ? toBlock : cur + step - 1n;
      let logs;
      try {
        // Few retries here: a failing chunk is usually too large, and shrinking beats waiting.
        logs = await rpc(url, 'eth_getLogs', [{ fromBlock: hex(cur), toBlock: hex(end), address: token, topics }], { retries: 1 });
      } catch (err) {
        const msg = err?.message || '';
        // Providers signal "too much data" in many ways (limit exceeded, 413/500, timeouts).
        // Shrink the chunk and retry until we hit the floor.
        if (step > MIN_STEP) {
          step = step / 2n < MIN_STEP ? MIN_STEP : step / 2n;
          okStreak = 0;
          emit({ type: 'progress', message: `eth_getLogs failed (${msg.slice(0, 80)}), reducing chunk to ${step} blocks` });
          continue;
        }
        throw new Error(`eth_getLogs failed even at ${MIN_STEP}-block chunks: ${msg}. This RPC appears to restrict eth_getLogs; use an Alchemy endpoint for ${chain.name}.`);
      }
      scanned += logs.length;
      for (const l of logs) {
        const id = `${l.transactionHash}:${l.logIndex}`;
        if (seen.has(id)) continue;
        seen.add(id);
        if (!l.topics || l.topics.length < 3) continue; // non-standard Transfer (e.g. ERC-721 without indexed value)
        const raw = BigInt(l.data === '0x' ? '0x0' : l.data);
        if (!match(raw)) continue;
        matched.push({ log: l, raw });
        if (matched.length >= limit) { truncated = true; reason = 'result limit'; break outer; }
      }
      const done = end - fromBlock + 1n;
      emit({ type: 'progress', message: `eth_getLogs: blocks ${cur}-${end} (${Number((done * 100n) / total)}%), ${scanned} transfers seen, ${matched.length} matches` });
      cur = end + 1n;
      okStreak++;
      if (okStreak >= 3 && step < MAX_STEP) { step = step * 2n; okStreak = 0; }
    }
  }

  // Resolve timestamps for matches only.
  const rows = await mapLimit(matched, 6, async ({ log, raw }) => {
    const blockNum = fromHex(log.blockNumber);
    const b = await getBlockHeader(url, blockNum, cache).catch(() => null);
    return {
      chain: chain.id,
      hash: log.transactionHash,
      timestamp: b ? isoFromUnix(b.timestamp) : null,
      block: blockNum.toString(),
      from: topicToAddr(log.topics[1]),
      to: topicToAddr(log.topics[2]),
      amountRaw: raw.toString(),
      amount: formatUnits(raw, decimals),
      symbol,
      token,
      explorer: chain.explorerTx(log.transactionHash),
      logIndex: Number(fromHex(log.logIndex)),
      source: 'eth_getLogs',
    };
  });
  rows.sort((a, b) => (BigInt(a.block) < BigInt(b.block) ? -1 : BigInt(a.block) > BigInt(b.block) ? 1 : (a.logIndex || 0) - (b.logIndex || 0)));
  for (const row of rows) emit({ type: 'result', row });
  return { found: rows.length, scanned, truncated, reason };
}

export async function searchEvm({ chain, url, token, amount, tolerance, fromTs, toTs, address, direction, limit, emit, signal }) {
  if (token !== 'native' && !isAddress(token)) throw new Error('Token must be "native" or a 0x contract address');
  if (address && !isAddress(address)) throw new Error('Address must be a 0x address');
  const cache = new Map();

  const meta = await tokenMeta(url, chain, token);
  emit({ type: 'progress', message: `Token ${meta.symbol} (${meta.decimals} decimals)` });
  const targetRaw = amount ? parseUnits(amount, meta.decimals) : null;
  const match = makeAmountMatcher(targetRaw, tolerance);

  const { fromBlock, toBlock } = await blockRangeForWindow(url, fromTs, toTs, cache, emit);
  if (toBlock < fromBlock) throw new Error('Time window contains no blocks yet');
  emit({ type: 'progress', message: `Block range ${fromBlock} → ${toBlock} (${toBlock - fromBlock + 1n} blocks)` });

  const ctx = { chain, url, token, fromBlock, toBlock, address: address?.toLowerCase(), direction, match, decimals: meta.decimals, symbol: meta.symbol, emit, limit, signal, cache };

  try {
    emit({ type: 'progress', message: 'Trying Alchemy Transfers API…' });
    return await scanAlchemyTransfers(ctx);
  } catch (err) {
    if (!isUnsupported(err)) throw err;
    emit({ type: 'progress', message: `Transfers API unavailable on this RPC (${err.message}). Falling back to eth_getLogs.` });
    return await scanLogs(ctx);
  }
}
