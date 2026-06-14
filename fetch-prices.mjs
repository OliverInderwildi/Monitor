// fetch-prices.mjs — pulls energy-transition market values and writes data.json
// Runs in GitHub Actions (Node 20+, global fetch). No API keys required for the
// Yahoo Finance sources (Brent, copper, platinum, palladium). EU-ETS carbon is
// attempted from Ember and falls back to manual.json; lithium is manual.json.
//
// Robust by design: each source is wrapped in try/catch, and on any failure the
// previous value from the existing data.json is preserved so a transient outage
// never blanks a card.

import { readFile, writeFile } from 'node:fs/promises';

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; MonitorBot/1.0)' };
const LB_PER_TONNE = 2204.62;

// ---- helpers ---------------------------------------------------------------

async function yahoo(symbol, range, interval) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=${interval}`;
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`Yahoo ${symbol} ${range}/${interval} -> HTTP ${r.status}`);
  const j = await r.json();
  const res = j?.chart?.result?.[0];
  if (!res) throw new Error(`Yahoo ${symbol}: empty result`);
  const ts = res.timestamp || [];
  const close = res.indicators?.quote?.[0]?.close || [];
  const d = [], v = [];
  for (let i = 0; i < ts.length; i++) {
    if (close[i] != null) {
      d.push(new Date(ts[i] * 1000).toISOString().slice(0, 10));
      v.push(close[i]);
    }
  }
  return { d, v, meta: res.meta || {} };
}

// Pull a Yahoo symbol's 5y monthly + 1m daily history and latest quote.
async function fromYahoo(symbol, transform = (x) => x, round = 2) {
  const five = await yahoo(symbol, '5y', '1mo');
  const one = await yahoo(symbol, '1mo', '1d');
  const tx = (a) => a.map((x) => +(transform(x)).toFixed(round));
  const h5 = { d: five.d, v: tx(five.v) };
  const h1 = { d: one.d, v: tx(one.v) };
  const lastClose = one.v[one.v.length - 1];
  const price = +(transform(one.meta.regularMarketPrice ?? lastClose)).toFixed(round);
  // day-over-day change from the last two daily closes (already transformed)
  const a = h1.v[h1.v.length - 2], b = h1.v[h1.v.length - 1];
  const changePct = (a != null && a !== 0) ? +(((b - a) / a) * 100).toFixed(2) : 0;
  return { price, changePct, asOf: h1.d[h1.d.length - 1] || null, h5, h1 };
}

// Attempt Ember's free carbon-price API; return null on any failure.
async function fromEmber() {
  const url = 'https://api.ember-energy.org/v1/carbon-price/daily?entity_code=EU&start_date=2021-01-01';
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`Ember -> HTTP ${r.status}`);
  const j = await r.json();
  const rows = (j?.data || j || []).filter((x) => x && (x.price ?? x.value) != null);
  if (!rows.length) throw new Error('Ember: no rows');
  const d = [], v = [];
  for (const row of rows) {
    d.push((row.date || row.day || '').slice(0, 10));
    v.push(+(+(row.price ?? row.value)).toFixed(2));
  }
  // monthly thinning for the 5y view (keep ~last point of each month)
  const byMonth = new Map();
  for (let i = 0; i < d.length; i++) byMonth.set(d[i].slice(0, 7), { d: d[i], v: v[i] });
  const monthly = [...byMonth.values()];
  const h5 = { d: monthly.map((x) => x.d), v: monthly.map((x) => x.v) };
  const h1 = { d: d.slice(-30), v: v.slice(-30) };
  const price = v[v.length - 1];
  const prev = v[v.length - 2] ?? price;
  return { price, changePct: prev ? +(((price - prev) / prev) * 100).toFixed(2) : 0, asOf: d[d.length - 1] || null, h5, h1 };
}

async function loadJSON(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { return fallback; }
}

// ---- main ------------------------------------------------------------------

const prev = await loadJSON('data.json', { indicators: {} });
const manual = await loadJSON('manual.json', {
  eua: { price: 72.0, changePct: 0 },
  lithium: { price: 24500, changePct: 0 },
});

const indicators = { ...prev.indicators };

async function set(key, fn, label) {
  try {
    indicators[key] = { ...(indicators[key] || {}), ...(await fn()) };
    console.log(`ok   ${label}: ${indicators[key].price}`);
  } catch (e) {
    console.warn(`FAIL ${label}: ${e.message} (keeping previous value)`);
  }
}

await set('brent',  () => fromYahoo('BZ=F', (x) => x, 2), 'Brent (BZ=F)');
await set('copper', () => fromYahoo('HG=F', (x) => x * LB_PER_TONNE, 0), 'Copper (HG=F→USD/t, $/lb→$/t)');
await set('pt',     () => fromYahoo('PL=F', (x) => x, 0), 'Platinum (PL=F)');
await set('pd',     () => fromYahoo('PA=F', (x) => x, 0), 'Palladium (PA=F)');

// EU-ETS carbon: try Ember, else fall back to manual.json
try {
  indicators.eua = { ...(indicators.eua || {}), ...(await fromEmber()) };
  console.log(`ok   EUA (Ember): ${indicators.eua.price}`);
} catch (e) {
  indicators.eua = { ...(indicators.eua || {}), price: manual.eua.price, changePct: 0, asOf: manual.eua.asOf || null, manual: true };
  console.warn(`FAIL EUA Ember: ${e.message} -> using manual.json (${manual.eua.price} as of ${manual.eua.asOf})`);
}

// Lithium: no free real-time feed — manual.json
indicators.lithium = { price: manual.lithium.price, changePct: 0, asOf: manual.lithium.asOf || null, manual: true };

// Combine platinum + palladium into the single "pgm" card the page expects
if (indicators.pt || indicators.pd) {
  indicators.pgm = {
    price: indicators.pt?.price ?? null,
    changePct: indicators.pt?.changePct ?? 0,
    asOf: indicators.pt?.asOf ?? null,
    pt: indicators.pt ? { h5: indicators.pt.h5, h1: indicators.pt.h1 } : null,
    pd: indicators.pd ? { h5: indicators.pd.h5, h1: indicators.pd.h1 } : null,
  };
}

const out = { updated: new Date().toISOString(), indicators };
await writeFile('data.json', JSON.stringify(out, null, 2) + '\n');
console.log(`\nWrote data.json @ ${out.updated}`);
