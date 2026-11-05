import { strict as assert } from 'node:assert';
import { parseTrExport, payeeOf, memoOf, matchExisting, type ExistingRow } from './importTradeRepublic';

const H = '"datetime","date","account_type","category","type","asset_class","name","symbol","shares","price","amount","fee","tax","currency","original_amount","original_currency","fx_rate","description","transaction_id","counterparty_name","counterparty_iban","payment_reference","mcc_code"';
const row = (date: string, type: string, name: string, amount: string, tax: string, desc: string, id: string, cp = '') =>
  `"${date}T10:00:00Z","${date}","DEFAULT","CASH","${type}","","${name}","","","","${amount}","","${tax}","EUR","","","","${desc}","${id}","${cp}","","",""`;
const csv = [
  H,
  row('2026-10-01', 'INTEREST_PAYMENT', '', '13.370000', '-3.48', 'Interest payment for payout', 'i1'),
  row('2026-10-13', 'TAX_OPTIMIZATION', '', '0.000000', '-8.60', 'Stamp Duty Tax (Cash)', 't1'),
  row('2026-10-19', 'CARD_TRANSACTION_INTERNATIONAL', 'OPENCODE', '-8.920000', '', 'OPENCODE, 10,00 $, exchange rate: 0,892', 'c1'),
  row('2026-10-21', 'TRANSFER_DIRECT_DEBIT_INBOUND', '', '-25.000000', '', 'Sepa Direct Debit transfer to Uni Goettingen (DE89250500000101423341)', 'd1', 'Me'),
  row('2026-09-24', 'CARD_TRANSACTION', 'Netto Marken-Discount', '-6.830000', '', 'NETTO', 'n1'),
  row('2026-09-24', 'CARD_TRANSACTION', 'Netto Marken-Discount', '-6.420000', '', 'NETTO', 'n2'),
  row('2026-09-12', 'TRANSFER_INSTANT_OUTBOUND', '', '-540.000000', '', 'Outgoing transfer for Anne', 'o1', 'Anne Stollenwerk'),
  row('2026-10-03', 'CARD_TRANSACTION', 'Studentenwerk Goetting', '-5.000000', '', 'STUDENTENWERK', 's1'),
  row('2026-10-04', 'CARD_TRANSACTION', 'Studentenwerk Goetting', '-5.000000', '', 'STUDENTENWERK', 's2'),
  row('2026-10-05', 'CARD_TRANSACTION', 'Lidl', '-3.000000', '', 'LIDL', 'l1'),
].join('\n');

const rows = parseTrExport('﻿' + csv);
const by = Object.fromEntries(rows.map((r) => [r.id, r]));
// cash effect = amount + fee + tax, exact milliunits
assert.equal(by.i1.net, 9890);
assert.equal(by.t1.net, -8600);
assert.equal(by.c1.net, -8920);
assert.equal(payeeOf(by.i1), 'Trade Republic Interest');
assert.equal(payeeOf(by.d1), 'Uni Goettingen'); // creditor, not the account holder
assert.equal(payeeOf(by.o1), 'Anne Stollenwerk');
assert.equal(payeeOf(by.t1), 'Trade Republic');
assert.equal(memoOf(by.c1), '10,00 $, exchange rate: 0,892'); // quoted commas survive
assert.equal(memoOf(by.t1), 'Stamp Duty Tax (Cash)');
assert.throws(() => parseTrExport('DATA;IMPORTO;PAYEE;MEMO\n01/10/2026;-1,00;X;'), /Not a Trade Republic/);

const ex = (id: string, date: string, amount: number, payee: string, importId: string | null = null): ExistingRow => ({ id, date, amount, payee, importId });
const fresh = matchExisting(rows, [
  ex('a', '2026-09-12', -540000, 'Anne Coinquilina'), // exact amount, renamed payee
  ex('b', '2026-09-23', -13250, 'NETTO MARKEN-DISCOUNT'), // two card payments entered as one
  ex('c', '2026-10-18', -8980, 'OpenCode', 'sched:x:2026-10-18'), // FX estimate, ±3% / ±3 days
  ex('d', '2026-10-21', -25000, 'Universitaet Goettingen'),
  ex('e', '2026-10-03', -5000, 'Studentenwerk Goetting', 'tr-export:s1'), // written by an earlier run
  ex('f', '2026-10-01', 9890, 'Reconciliation Balance Adjustment'), // system payee: never a match
]).map((r) => r.id);
// s2 (same amount, next day) must NOT be eaten by s1's register row
assert.deepEqual(fresh.sort(), ['i1', 'l1', 's2', 't1']);

console.log('importTradeRepublic: ok');
