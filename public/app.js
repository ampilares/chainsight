(() => {
  const $ = (id) => document.getElementById(id);
  const els = {
    chain: $('chain'), tokenPreset: $('tokenPreset'), tokenCustom: $('tokenCustom'), tokenCustomWrap: $('tokenCustomWrap'),
    amount: $('amount'), tolerance: $('tolerance'), limit: $('limit'), from: $('from'), to: $('to'),
    address: $('address'), addressHint: $('addressHint'), direction: $('direction'), form: $('searchForm'),
    searchBtn: $('searchBtn'), cancelBtn: $('cancelBtn'), results: $('results').querySelector('tbody'),
    count: $('count'), empty: $('empty'), log: $('log'), clearLog: $('clearLog'), exportCsv: $('exportCsv'),
    settings: $('settings'), toggleSettings: $('toggleSettings'), alchemyKey: $('alchemyKey'),
    rpcOverrides: $('rpcOverrides'), saveSettings: $('saveSettings'), settingsStatus: $('settingsStatus'), chainNote: $('chainNote'),
  };

  let chains = [];
  let rows = [];
  let controller = null;

  const SETTINGS_KEY = 'chainsight.settings';
  const FORM_KEY = 'chainsight.form';

  function loadSettings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch { return {}; }
  }
  function saveSettings(s) { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); }

  function log(msg, cls) {
    const line = document.createElement('div');
    if (cls) line.className = cls;
    line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    els.log.appendChild(line);
    els.log.scrollTop = els.log.scrollHeight;
  }

  function toLocalInput(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function currentChain() { return chains.find((c) => c.id === els.chain.value); }

  function renderTokenPresets() {
    const c = currentChain();
    if (!c) return;
    els.tokenPreset.innerHTML = '';
    const opts = [['native', `${c.native.symbol} (native)`], ...Object.entries(c.tokens).map(([sym, addr]) => [addr, sym]), ['custom', 'Custom address…']];
    for (const [v, label] of opts) {
      const o = document.createElement('option');
      o.value = v; o.textContent = label;
      els.tokenPreset.appendChild(o);
    }
    els.tokenPreset.value = Object.keys(c.tokens).length ? Object.values(c.tokens)[0] : 'custom';
    updateTokenCustom();
    if (c.type === 'solana') {
      els.addressHint.textContent = '(recommended; required for SOL. Without it, the mint is used as the anchor, best effort)';
      els.chainNote.textContent = 'Solana: signatures are walked for the address (or mint) and each transaction is inspected for balance changes of the token. Large windows on busy addresses take a while.';
    } else {
      els.addressHint.textContent = '(optional, narrows the search)';
      els.chainNote.textContent = c.id === 'bnb'
        ? 'BNB Chain: Alchemy does not offer the Transfers API here, so token transfers are scanned via eth_getLogs. Native BNB transfers need an RPC with the Transfers API.'
        : c.id === 'robinhood'
          ? 'Robinhood Chain produces a block every ~100 ms, so wide windows mean large block ranges. Alchemy Transfers API is attempted first.'
          : '';
    }
  }

  function updateTokenCustom() {
    const custom = els.tokenPreset.value === 'custom';
    els.tokenCustomWrap.style.display = custom ? '' : 'none';
    els.tokenCustom.required = custom;
  }

  function resolveToken() {
    return els.tokenPreset.value === 'custom' ? els.tokenCustom.value.trim() : els.tokenPreset.value;
  }

  function renderSettings() {
    const s = loadSettings();
    els.alchemyKey.value = s.alchemyKey || '';
    els.rpcOverrides.innerHTML = '';
    for (const c of chains) {
      const l = document.createElement('label');
      l.textContent = `${c.name} RPC URL override`;
      const i = document.createElement('input');
      i.type = 'text'; i.placeholder = c.configured ? 'configured on server via .env' : 'https://…';
      i.dataset.chain = c.id; i.value = s.rpcUrls?.[c.id] || ''; i.spellcheck = false;
      l.appendChild(i);
      els.rpcOverrides.appendChild(l);
    }
  }

  function short(a) { return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—'; }

  function rowHtml(r) {
    const dir = r.direction ? `<span class="dir-${r.direction}">${r.direction}</span> ` : '';
    return `<tr>
      <td class="mono">${r.timestamp ? r.timestamp.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '—'}</td>
      <td>${r.chain}</td>
      <td class="mono">${dir}${r.amount} ${r.symbol || ''}</td>
      <td class="mono" title="${r.from || ''}">${short(r.from)}</td>
      <td class="mono" title="${r.to || ''}">${short(r.to)}</td>
      <td><a href="${r.explorer}" target="_blank" rel="noopener">${short(r.hash)}</a></td>
    </tr>`;
  }

  // Rows stream in scan order (Solana walks newest-first, EVM oldest-first); keep the table sorted by time.
  let renderQueued = false;
  function renderRows() {
    renderQueued = false;
    rows.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
    els.results.innerHTML = rows.map(rowHtml).join('');
  }

  function addRow(r) {
    rows.push(r);
    if (!renderQueued) { renderQueued = true; requestAnimationFrame(renderRows); }
    els.count.textContent = rows.length;
    els.empty.hidden = true;
    els.exportCsv.disabled = false;
  }

  function resetResults() {
    rows = [];
    els.results.innerHTML = '';
    els.count.textContent = '0';
    els.empty.hidden = false;
    els.exportCsv.disabled = true;
  }

  function persistForm() {
    localStorage.setItem(FORM_KEY, JSON.stringify({
      chain: els.chain.value, tokenPreset: els.tokenPreset.value, tokenCustom: els.tokenCustom.value,
      amount: els.amount.value, tolerance: els.tolerance.value, address: els.address.value, direction: els.direction.value, limit: els.limit.value,
    }));
  }

  function restoreForm() {
    try {
      const f = JSON.parse(localStorage.getItem(FORM_KEY) || 'null');
      if (!f) return;
      if (f.chain) els.chain.value = f.chain;
      renderTokenPresets();
      if (f.tokenPreset && [...els.tokenPreset.options].some((o) => o.value === f.tokenPreset)) els.tokenPreset.value = f.tokenPreset;
      updateTokenCustom();
      els.tokenCustom.value = f.tokenCustom || '';
      els.amount.value = f.amount || '';
      els.tolerance.value = f.tolerance || '0';
      els.address.value = f.address || '';
      els.direction.value = f.direction || 'any';
      els.limit.value = f.limit || '500';
    } catch { /* ignore */ }
  }

  async function runSearch(e) {
    e.preventDefault();
    if (controller) return;
    const s = loadSettings();
    const body = {
      chain: els.chain.value,
      token: resolveToken(),
      amount: els.amount.value.trim(),
      tolerance: Number(els.tolerance.value) || 0,
      from: els.from.value ? new Date(els.from.value).toISOString() : null,
      to: els.to.value ? new Date(els.to.value).toISOString() : null,
      address: els.address.value.trim() || null,
      direction: els.direction.value,
      limit: Number(els.limit.value) || 500,
      alchemyKey: s.alchemyKey || undefined,
      rpcUrls: s.rpcUrls || undefined,
    };
    persistForm();
    resetResults();
    controller = new AbortController();
    els.searchBtn.disabled = true;
    els.cancelBtn.disabled = false;
    log(`Search: ${body.chain} token=${body.token} amount=${body.amount || 'any'} ±${body.tolerance}% ${body.from} → ${body.to || 'now'}${body.address ? ' address=' + body.address : ''}`);

    try {
      const res = await fetch('/api/search', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          handle(JSON.parse(line));
        }
      }
      if (buf.trim()) handle(JSON.parse(buf));
    } catch (err) {
      if (err.name === 'AbortError') log('Cancelled.', 'err');
      else log(`Error: ${err.message}`, 'err');
    } finally {
      controller = null;
      els.searchBtn.disabled = false;
      els.cancelBtn.disabled = true;
    }
  }

  function handle(msg) {
    if (msg.type === 'progress') log(msg.message);
    else if (msg.type === 'result') addRow(msg.row);
    else if (msg.type === 'error') log(`Error: ${msg.message}`, 'err');
    else if (msg.type === 'done') {
      log(`Done in ${(msg.elapsedMs / 1000).toFixed(1)}s: ${msg.found} match(es), ${msg.scanned} transfer(s)/tx(s) inspected${msg.truncated ? ` — TRUNCATED (${msg.reason}); narrow the window or add an address` : ''}`, msg.truncated ? 'err' : 'ok');
    }
  }

  function exportCsv() {
    const head = ['timestamp', 'chain', 'direction', 'amount', 'amountRaw', 'symbol', 'token', 'from', 'to', 'hash', 'block', 'explorer', 'source'];
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [head.join(','), ...rows.map((r) => head.map((k) => esc(r[k])).join(','))].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `chainsight-${els.chain.value}-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function init() {
    const res = await fetch('/api/chains');
    chains = (await res.json()).chains;
    els.chain.innerHTML = '';
    for (const c of chains) {
      const o = document.createElement('option');
      o.value = c.id; o.textContent = c.name + (c.configured ? '' : ' (no RPC in .env)');
      els.chain.appendChild(o);
    }
    renderTokenPresets();
    renderSettings();
    restoreForm();
    const now = new Date();
    els.to.value = '';
    els.from.value = toLocalInput(new Date(now.getTime() - 24 * 3600 * 1000));

    els.chain.addEventListener('change', renderTokenPresets);
    els.tokenPreset.addEventListener('change', updateTokenCustom);
    els.form.addEventListener('submit', runSearch);
    els.cancelBtn.addEventListener('click', () => controller?.abort());
    els.clearLog.addEventListener('click', () => { els.log.innerHTML = ''; });
    els.exportCsv.addEventListener('click', exportCsv);
    els.toggleSettings.addEventListener('click', () => { els.settings.hidden = !els.settings.hidden; });
    els.saveSettings.addEventListener('click', () => {
      const rpcUrls = {};
      for (const i of els.rpcOverrides.querySelectorAll('input')) if (i.value.trim()) rpcUrls[i.dataset.chain] = i.value.trim();
      saveSettings({ alchemyKey: els.alchemyKey.value.trim(), rpcUrls });
      els.settingsStatus.textContent = 'Saved.';
      setTimeout(() => { els.settingsStatus.textContent = ''; }, 2000);
    });
    document.querySelectorAll('.presets button').forEach((b) => b.addEventListener('click', () => {
      const h = Number(b.dataset.hours);
      const end = new Date();
      els.to.value = '';
      els.from.value = toLocalInput(new Date(end.getTime() - h * 3600 * 1000));
    }));
  }

  init().catch((err) => log(`Init failed: ${err.message}`, 'err'));
})();
