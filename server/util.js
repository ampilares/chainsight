// BigInt-safe unit helpers and amount matching.

export function parseUnits(amountStr, decimals) {
  const s = String(amountStr).trim().replace(/,/g, '');
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') throw new Error(`Invalid amount: ${amountStr}`);
  const [whole = '0', frac = ''] = s.split('.');
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(fracPadded || '0');
}

export function formatUnits(raw, decimals) {
  const neg = raw < 0n;
  const v = neg ? -raw : raw;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + whole.toString() + (frac ? '.' + frac : '');
}

// Build a matcher for raw BigInt amounts. tolerancePct is a percentage (0 = exact).
export function makeAmountMatcher(targetRaw, tolerancePct) {
  if (targetRaw === null || targetRaw === undefined) return () => true;
  const tol = Number(tolerancePct) || 0;
  const tolRaw = (targetRaw * BigInt(Math.round(tol * 10000))) / 1000000n;
  const lo = targetRaw - tolRaw;
  const hi = targetRaw + tolRaw;
  return (raw) => raw >= lo && raw <= hi;
}

export const hex = (n) => '0x' + BigInt(n).toString(16);
export const fromHex = (h) => (h === null || h === undefined ? null : BigInt(h));

export function isoFromUnix(sec) {
  return new Date(Number(sec) * 1000).toISOString();
}
