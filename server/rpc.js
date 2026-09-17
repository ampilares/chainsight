// Minimal JSON-RPC client with retry/backoff for 429s and transient failures.

export class RpcError extends Error {
  constructor(message, code, data) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let idCounter = 1;

export async function rpc(url, method, params = [], opts = {}) {
  const { retries = 4, timeoutMs = 45000 } = opts;
  let attempt = 0;
  let lastErr;
  while (attempt <= retries) {
    attempt++;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: idCounter++, method, params }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.status === 429 || res.status >= 500) {
        lastErr = new RpcError(`HTTP ${res.status} from RPC`, res.status);
        await sleep(Math.min(8000, 400 * 2 ** attempt));
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new RpcError(`HTTP ${res.status} from RPC: ${text.slice(0, 200)}`, res.status);
      }
      const body = await res.json();
      if (body.error) {
        const { code, message, data } = body.error;
        if (code === 429 || /rate limit|too many requests|capacity/i.test(message || '')) {
          lastErr = new RpcError(message, code, data);
          await sleep(Math.min(8000, 400 * 2 ** attempt));
          continue;
        }
        throw new RpcError(message || 'RPC error', code, data);
      }
      return body.result;
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof RpcError) throw err;
      lastErr = err;
      if (attempt > retries) break;
      await sleep(Math.min(8000, 400 * 2 ** attempt));
    }
  }
  throw lastErr || new RpcError('RPC request failed');
}

// Run async fn over items with bounded concurrency, preserving order.
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) || 1 }, worker));
  return out;
}
