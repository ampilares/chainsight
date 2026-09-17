import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHAINS, resolveRpcUrl, publicChainList } from './chains.js';
import { searchEvm } from './evm.js';
import { searchSolana } from './solana.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/chains', (_req, res) => {
  res.json({ chains: publicChainList() });
});

function toUnix(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Math.floor(v > 1e12 ? v / 1000 : v);
  const n = Number(v);
  if (Number.isFinite(n)) return Math.floor(n > 1e12 ? n / 1000 : n);
  const t = Date.parse(v);
  if (Number.isNaN(t)) return null;
  return Math.floor(t / 1000);
}

// Streams NDJSON: {type:'progress'|'result'|'done'|'error', ...}
app.post('/api/search', async (req, res) => {
  const b = req.body || {};
  const chain = CHAINS[b.chain];
  const send = (obj) => { if (!res.writableEnded) res.write(JSON.stringify(obj) + '\n'); };
  const fail = (msg, status = 400) => {
    if (!res.headersSent) res.status(status).json({ error: msg });
    else { send({ type: 'error', message: msg }); res.end(); }
  };

  if (!chain) return fail(`Unknown chain "${b.chain}"`);
  const url = resolveRpcUrl(chain, { alchemyKey: b.alchemyKey, rpcUrls: b.rpcUrls });
  if (!url) return fail(`No RPC configured for ${chain.name}. Set ALCHEMY_API_KEY or ${chain.envVar} in .env, or enter it in Settings.`);

  const token = String(b.token || '').trim() === '' ? null : String(b.token).trim();
  if (!token) return fail('Token is required ("native" or a token address)');
  const fromTs = toUnix(b.from);
  const toTs = toUnix(b.to) ?? Math.floor(Date.now() / 1000);
  if (fromTs === null) return fail('Start time is required');
  if (toTs <= fromTs) return fail('End time must be after start time');
  if (toTs - fromTs > 60 * 60 * 24 * 90) return fail('Time window is capped at 90 days');
  const amount = b.amount === undefined || b.amount === null || String(b.amount).trim() === '' ? null : String(b.amount).trim();
  const tolerance = Math.max(0, Number(b.tolerance) || 0);
  const address = b.address ? String(b.address).trim() : null;
  const direction = ['in', 'out', 'any'].includes(b.direction) ? b.direction : 'any';
  const limit = Math.min(5000, Math.max(1, Number(b.limit) || 500));

  res.status(200);
  res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('x-accel-buffering', 'no');
  res.flushHeaders?.();

  const signal = { aborted: false };
  // res 'close' fires on client disconnect (and after a normal end, which is harmless).
  res.on('close', () => { if (!res.writableEnded) signal.aborted = true; });

  const started = Date.now();
  send({ type: 'progress', message: `Searching ${chain.name} from ${new Date(fromTs * 1000).toISOString()} to ${new Date(toTs * 1000).toISOString()}` });
  try {
    const args = { chain, url, token, amount, tolerance, fromTs, toTs, address, direction, limit, emit: send, signal };
    const summary = chain.type === 'solana' ? await searchSolana(args) : await searchEvm(args);
    send({ type: 'done', ...summary, elapsedMs: Date.now() - started, aborted: signal.aborted });
  } catch (err) {
    console.error(err);
    send({ type: 'error', message: err?.message || String(err) });
  }
  res.end();
});

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '127.0.0.1';
app.listen(port, host, () => {
  console.log(`chainsight listening on http://${host}:${port}`);
  const configured = publicChainList().filter((c) => c.configured).map((c) => c.name);
  console.log(configured.length ? `RPC configured for: ${configured.join(', ')}` : 'No RPC configured via .env; enter an Alchemy key in the UI Settings panel.');
});
