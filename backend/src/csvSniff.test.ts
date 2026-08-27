// Engine tests for the generic CSV sniffer. Run via `npm test`.

import { strict as assert } from 'node:assert';
import { sniffCsv, parseCsvRows, parseAmountMilli } from './csvSniff';

// Italian bank: semicolon, header keywords in Italian, comma decimals, DMY
const italian = `Data;Descrizione;Causale;Importo
01/07/2026;COOP SUPERMARKET;POS;-17,99
03/07/2026;STIPENDIO ACME;BONIFICO;1.208,00
05/07/2026;NETTO BAR;POS;-3,50`;
const it = sniffCsv(italian);
assert.equal(it.delimiter, ';');
assert.equal(it.headerRow, 0);
assert.equal(it.columns.date, 0);
assert.equal(it.columns.payee, 1);
assert.equal(it.columns.amount, 3);
assert.equal(it.dateOrder, 'DMY');
assert.equal(it.decimal, ',');
const itRows = parseCsvRows(italian, it);
assert.deepEqual(itRows, [
  { date: '2026-07-01', payee: 'COOP SUPERMARKET', amount: -17990, memo: 'POS' },
  { date: '2026-07-03', payee: 'STIPENDIO ACME', amount: 1208000, memo: 'BONIFICO' },
  { date: '2026-07-05', payee: 'NETTO BAR', amount: -3500, memo: 'POS' },
]);

// US bank: comma delimiter, MDY, dot decimals, outflow/inflow columns
const us = `"Date","Description","Memo","Debit","Credit"
"07/15/2026","Whole Foods","groceries","45.20",
"07/18/2026","Salary","july","","2500.00"
"07/20/2026","Amazon","stuff","12.34",`;
const usSpec = sniffCsv(us);
assert.equal(usSpec.delimiter, ',');
assert.equal(usSpec.columns.date, 0);
assert.equal(usSpec.columns.payee, 1);
assert.equal(usSpec.columns.outflow, 3);
assert.equal(usSpec.columns.inflow, 4);
assert.equal(usSpec.dateOrder, 'MDY');
assert.equal(usSpec.decimal, '.');
assert.deepEqual(parseCsvRows(us, usSpec), [
  { date: '2026-07-15', payee: 'Whole Foods', amount: -45200, memo: 'groceries' },
  { date: '2026-07-18', payee: 'Salary', amount: 2500000, memo: 'july' },
  { date: '2026-07-20', payee: 'Amazon', amount: -12340, memo: 'stuff' },
]);

// German export: dot thousands, comma decimals, ISO dates, no matching header
const german = `Buchung;Empfänger;Verwendungszweck;Betrag
2026-07-02;REWE SAGT DANKE;Einkauf;-23,45
2026-07-10;Miete Wohnung;August;-950,00`;
const de = sniffCsv(german);
assert.equal(de.headerRow, 0); // Empfänger + Verwendungszweck hit the keyword sets
assert.equal(de.columns.date, 0);
assert.equal(de.columns.payee, 1);
assert.equal(de.dateOrder, 'ISO');
assert.deepEqual(parseCsvRows(german, de), [
  { date: '2026-07-02', payee: 'REWE SAGT DANKE', amount: -23450, memo: 'Einkauf' },
  { date: '2026-07-10', payee: 'Miete Wohnung', amount: -950000, memo: 'August' },
]);

// headerless: positional inference (date, payee, amount)
const raw = `01/08/2026;BAR TABACCHI;-4,00
02/08/2026;RIMBORSO;25,00`;
const rawSpec = sniffCsv(raw);
assert.equal(rawSpec.headerRow, -1);
assert.equal(rawSpec.columns.date, 0);
assert.equal(rawSpec.columns.amount, 2);
assert.deepEqual(parseCsvRows(raw, rawSpec), [
  { date: '2026-08-01', payee: 'BAR TABACCHI', amount: -4000, memo: '' },
  { date: '2026-08-02', payee: 'RIMBORSO', amount: 25000, memo: '' },
]);

// trailing-minus and parenthesized negatives
assert.equal(parseAmountMilli('100-', ','), -100000);
assert.equal(parseAmountMilli('(45.20)', '.'), -45200);
assert.equal(parseAmountMilli('€ 1.208,00', ','), 1208000);
assert.equal(parseAmountMilli('$2,500.75', '.'), 2500750);
assert.equal(parseAmountMilli('17,99', ','), -17990 * -1 - 17990 + 17990); // sanity: positive 17,99
assert.equal(parseAmountMilli('17,99', ','), 17990);

// quoted commas survive splitting; parseAmountMilli strips currency letters
const quoted = `"Date";"Payee";"Amount"
"03/08/2026";"Bar, coffee and snacks";"-12,50"`;
const qSpec = sniffCsv(quoted);
assert.deepEqual(parseCsvRows(quoted, qSpec), [{ date: '2026-08-03', payee: 'Bar, coffee and snacks', amount: -12500, memo: '' }]);

console.log('csvSniff: ok');
