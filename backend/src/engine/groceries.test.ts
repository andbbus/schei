import { strict as assert } from 'node:assert';
import { buildEmailBody, isoWeek, parseAldiHtml, parseCatalogCsv } from './groceries';

const NEXT = (apiData: unknown) =>
  `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps: { apiData: JSON.stringify(apiData) } },
  })}</script></body></html>`;

const OFFER = [
  [
    'OFFER_GET',
    {
      res: {
        algoliaDataMap: {
          p1: {
            name: 'Schnecke',
            brandName: 'LYTTOS',
            currentPrice: { priceValue: 3.79, basePrice: [{ basePriceValue: 3.79, basePriceScale: 'kg' }] },
            assets: [
              { type: 'gallery', url: 'https://s7g10.scene7.com/is/image/aldinord/gallery_1' },
              { type: 'primary', url: 'https://s7g10.scene7.com/is/image/aldinord/primary_1' },
            ],
            objectID: 'p1',
          },
          p2: {
            name: 'Bananen',
            brandName: '',
            currentPrice: { priceValue: 1.19, basePrice: [] },
            assets: [],
            objectID: 'p2',
          },
          p3: {
            shortDescription: 'Nur Beschreibung',
            currentPrice: { priceValue: 0.99 },
            objectID: 'p3',
          },
        },
      },
    },
  ],
] as unknown[];

export function test() {
  // isoWeek: 2026-08-10 is a Monday of week 33
  assert.equal(isoWeek(new Date(2026, 7, 10)), '2026-W33');
  assert.equal(isoWeek(new Date(2026, 7, 14)), '2026-W33'); // Friday same week
  assert.equal(isoWeek(new Date(2027, 0, 1)), '2026-W53'); // ISO week boundary

  // Aldi parser
  const items = parseAldiHtml(NEXT(OFFER));
  assert.equal(items.length, 3);
  const schnecke = items.find((i) => i.name === 'Schnecke')!;
  assert.equal(schnecke.brand, 'LYTTOS');
  assert.equal(schnecke.price, 3790);
  assert.equal(schnecke.unit, 'kg');
  assert.equal(schnecke.externalId, 'p1');
  assert.equal(schnecke.imageUrl, 'https://s7g10.scene7.com/is/image/aldinord/primary_1'); // primary asset wins
  const banane = items.find((i) => i.name === 'Bananen')!;
  assert.equal(banane.brand, null); // empty brand → null
  assert.equal(banane.unit, null); // no base price
  assert.equal(banane.imageUrl, null); // no assets → null
  const desc = items.find((i) => i.name === 'Nur Beschreibung')!;
  assert.equal(desc.price, 990);

  // missing payload → descriptive errors
  assert.throws(() => parseAldiHtml('<html></html>'), /__NEXT_DATA__/);
  assert.throws(() => parseAldiHtml(NEXT([])), /offer data missing/);

  // CSV parser (semicolon, European decimals, header + blanks skipped)
  const csv = 'name;price;unit\nBanane;0,89;kg\nMehl;1,09;1 kg\n\n\n';
  const rows = parseCatalogCsv(csv);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'Banane');
  assert.equal(rows[0].price, 890);
  assert.equal(rows[1].unit, '1 kg');

  // email body: sections, line totals, grand total
  const body = buildEmailBody(
    [
      { name: 'Schnecke', brand: 'LYTTOS', price: 3790, quantity: 1, store: 'aldi' },
      { name: 'Bananen', price: 1190, quantity: 2, store: 'aldi' },
      { name: 'Pane integrale', price: 180, quantity: 1, store: 'manual' },
      { name: 'Sconosciuto', price: 0, quantity: 1, store: 'manual' },
    ],
    'lunedì 14 agosto 2026',
  );
  assert.ok(body.includes('Lista della spesa — lunedì 14 agosto 2026'));
  assert.ok(body.includes('== ALDI =='));
  assert.ok(body.includes('== Varie =='));
  assert.ok(body.includes('2× Bananen — 1,19 € × 2 = 2,38 €'));
  assert.ok(body.includes('prezzo da verificare'));
  assert.ok(body.includes('TOTALE STIMATO: 6,35 €'));
}

test();
console.log('groceries: ok');
