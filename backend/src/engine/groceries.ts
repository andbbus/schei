// Grocery catalog: store adapters + parsers. Pure functions (no I/O) so the
// parsing is unit-testable; the fetchers live behind a small HTTP layer used
// by the sync route.

export interface GroceryItemInput {
  store: string; // aldi | lidl | netto | manual
  name: string;
  brand?: string | null;
  price: number; // milliunits (€3.79 → 3790); 0 = unknown
  unit?: string | null;
  imageUrl?: string | null;
  externalId?: string | null;
}

export interface WeekResult {
  week: string;
  items: GroceryItemInput[];
}

// ISO week (e.g. "2026-W33") for a date, per ISO 8601 (week 1 = week with the
// first Thursday; weeks run Monday–Sunday).
export function isoWeek(date = new Date()): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

// ---- Aldi Nord ------------------------------------------------------------
// The angebote page embeds the full current-week catalog server-side in
// `__NEXT_DATA__` → `props.pageProps.apiData` → the `OFFER_GET` entry's
// `res.algoliaDataMap`. Parse the HTML string; no JS execution needed.

export function parseAldiHtml(html: string): GroceryItemInput[] {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('ALDI page has no __NEXT_DATA__ payload (site layout changed?).');
  let next: { props?: { pageProps?: { apiData?: unknown } } };
  try {
    next = JSON.parse(m[1]);
  } catch {
    throw new Error('ALDI __NEXT_DATA__ is not valid JSON.');
  }
  const apiData = next?.props?.pageProps?.apiData;
  if (typeof apiData !== 'string') throw new Error('ALDI page has no apiData (site layout changed?).');
  let ops: unknown[];
  try {
    ops = JSON.parse(apiData);
  } catch {
    throw new Error('ALDI apiData is not valid JSON.');
  }
  const offer = ops.find((o): o is [string, { res?: { algoliaDataMap?: Record<string, unknown> } }] =>
    Array.isArray(o) && o[0] === 'OFFER_GET' && typeof o[1] === 'object' && o[1] !== null,
  );
  const map = offer?.[1]?.res?.algoliaDataMap;
  if (!map) throw new Error('ALDI offer data missing (site layout changed?).');
  const out: GroceryItemInput[] = [];
  for (const [key, rec] of Object.entries(map)) {
    const r = (rec ?? {}) as {
      name?: unknown;
      brandName?: unknown;
      shortDescription?: unknown;
      currentPrice?: { priceValue?: unknown; basePrice?: { basePriceScale?: unknown }[] };
      isAvailable?: unknown;
      isComingSoon?: unknown;
      objectID?: unknown;
      assets?: { type?: unknown; url?: unknown }[];
    };
    const priceValue = typeof r.currentPrice?.priceValue === 'number' ? r.currentPrice.priceValue : 0;
    const scale = r.currentPrice?.basePrice?.[0]?.basePriceScale;
    const primary = r.assets?.find((a) => a.type === 'primary');
    out.push({
      store: 'aldi',
      name: String(r.name ?? r.shortDescription ?? '').trim() || `ALDI offer ${key}`,
      brand: typeof r.brandName === 'string' && r.brandName.trim() ? r.brandName.trim() : null,
      price: Math.round(priceValue * 1000),
      unit: typeof scale === 'string' ? scale : null,
      imageUrl: typeof primary?.url === 'string' ? primary.url : null,
      externalId: typeof r.objectID === 'string' ? r.objectID : key,
    });
  }
  return out;
}

// ---- Lidl / Netto ---------------------------------------------------------
// Lidl's prospekt is delivered as raster page images (no product data in the
// DOM or any public API — the flyer SPA fetches product details only on click
// from shop-search ids, which the flyer never exposes); Netto blocks
// non-browser clients (403). Both keep the adapter shape so a future fetch
// implementation can slot in; until then use the CSV import path.
export const BLOCKED_STORES = new Set(['lidl', 'netto']);

// ---- CSV import (any store) ----------------------------------------------
// Columns: name;price;unit (semicolon or comma delimited, European numbers).
// Blank lines and a header row are skipped.
export function parseCatalogCsv(text: string): GroceryItemInput[] {
  const rows = text.split(/\r?\n/).filter((l) => l.trim());
  const delim = text.includes(';') ? ';' : ',';
  const out: GroceryItemInput[] = [];
  for (const row of rows) {
    const parts = row.split(delim).map((p) => p.trim());
    if (parts.length < 2) continue;
    const [name, priceStr, unit = ''] = parts;
    if (!name || /^name$/i.test(name)) continue; // header row
    const milli = Math.round(parseFloat(priceStr.replace(/€/g, '').replace(',', '.')) * 1000);
    out.push({ store: 'manual', name, price: Number.isFinite(milli) ? milli : 0, unit: unit || null });
  }
  return out;
}

// ---- Email body -----------------------------------------------------------
export interface EmailLine {
  name: string;
  brand?: string | null;
  price: number;
  quantity: number;
  store: string;
}

// Plain-text list for the email: per-store sections, line totals, grand total.
export function buildEmailBody(lines: EmailLine[], dateLabel: string): string {
  const money = (milli: number) =>
    `${(milli / 1000).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
  const byStore = new Map<string, EmailLine[]>();
  for (const l of lines) {
    const arr = byStore.get(l.store) ?? [];
    arr.push(l);
    byStore.set(l.store, arr);
  }
  const parts: string[] = [`Lista della spesa — ${dateLabel}`, ''];
  let grand = 0;
  for (const [store, items] of byStore) {
    const label = store === 'manual' ? 'Varie' : store.toUpperCase();
    parts.push(`== ${label} ==`);
    let storeTotal = 0;
    for (const it of items) {
      const line = it.price * it.quantity;
      storeTotal += line;
      grand += line;
      const suffix = it.price > 0 ? ` — ${money(it.price)}${it.quantity > 1 ? ` × ${it.quantity} = ${money(line)}` : ''}` : ' — prezzo da verificare';
      parts.push(`- ${it.quantity > 1 ? `${it.quantity}× ` : ''}${it.name}${it.brand ? ` (${it.brand})` : ''}${suffix}`);
    }
    parts.push(`  Subtotale: ${money(storeTotal)}`);
    parts.push('');
  }
  parts.push(`TOTALE STIMATO: ${money(grand)}`);
  parts.push('');
  parts.push('Prezzi da offerte settimanali; potrebbero differire in negozio.');
  return parts.join('\n');
}
