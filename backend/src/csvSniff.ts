// Generic CSV sniffer — pure functions. Detects delimiter, header row, column
// roles (date / payee / amount or outflow+inflow / memo), date order and the
// decimal separator for arbitrary bank CSV exports. Backs POST /import/auto
// (preview + commit) and the folder watcher. No deps, no I/O.

export interface CsvColumns {
  date: number;
  payee: number;
  amount: number | null; // signed single column (used when outflow/inflow absent)
  outflow: number | null;
  inflow: number | null;
  memo: number | null;
}

export interface CsvSpec {
  delimiter: string;
  headerRow: number; // line index of the header (-1 when no header found)
  header: string[]; // raw header cells ('' when none)
  columns: CsvColumns;
  dateOrder: 'DMY' | 'MDY' | 'ISO';
  decimal: ',' | '.';
  confidence: number; // 0..1
}

export interface CsvRow {
  date: string; // normalized YYYY-MM-DD
  payee: string;
  amount: number; // signed milliunits (+ inflow / − outflow)
  memo: string;
}

const KEYWORDS = {
  date: ['date', 'data', 'datum', 'valuta', 'buchungsdatum', 'wertstellung', 'posted', 'transaktionsdatum'],
  payee: ['payee', 'descrizione', 'description', 'beneficiario', 'merchant', 'empfaenger', 'empfänger', 'creditor', 'ordinante', 'mittente', 'name', 'details', 'counterparty'],
  amount: ['amount', 'importo', 'betrag', 'valore', 'quantita', 'quantità', 'ammount', 'betrag eur'],
  outflow: ['dare', 'debit', 'outflow', 'withdrawal', 'addebito', 'uscita', 'ausgang', 'soll', 'spesa'],
  inflow: ['avere', 'credit', 'inflow', 'deposit', 'accredito', 'entrata', 'eingang', 'haben', 'entrée'],
  memo: ['memo', 'nota', 'causale', 'verwendungszweck', 'reference', 'purpose', 'notes', 'note', 'description 2'],
};

export function splitLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else inQuotes = !inQuotes;
    } else if (ch === delimiter && !inQuotes) {
      cells.push(cur);
      cur = '';
    } else cur += ch;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

function scoreHeader(cells: string[]): { score: number; roles: Partial<Record<keyof typeof KEYWORDS, number>> } {
  const roles: Partial<Record<keyof typeof KEYWORDS, number>> = {};
  let score = 0;
  cells.forEach((cell, idx) => {
    const c = cell.toLowerCase().replace(/["'`]/g, '').trim();
    for (const [role, words] of Object.entries(KEYWORDS) as [keyof typeof KEYWORDS, string[]][]) {
      if (roles[role] === undefined && words.some((w) => c === w || c.includes(w))) {
        roles[role] = idx;
        score++;
        return;
      }
    }
  });
  return { score, roles };
}

function looksLikeDate(s: string): boolean {
  return /^\d{1,4}[-/.]\d{1,2}([-/.]\d{2,4})?$/.test(s.trim());
}

// Parse a date string with the given order → YYYY-MM-DD (null when invalid).
export function parseDate(raw: string, order: CsvSpec['dateOrder']): string | null {
  const s = raw.trim().replace(/"/g, '');
  const iso = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  const m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (!m) return null;
  let a = Number(m[1]);
  let b = Number(m[2]);
  const y = Number(m[3].length === 2 ? `20${m[3]}` : m[3]);
  if (order === 'MDY') [a, b] = [b, a];
  if (a < 1 || a > 31 || b < 1 || b > 12) return null;
  return `${y}-${String(b).padStart(2, '0')}-${String(a).padStart(2, '0')}`;
}

// "−€1.234,56" / "$1,234.56" / "(45.00)" / "100-" → signed milliunits.
export function parseAmountMilli(raw: string, decimal: ',' | '.'): number {
  let s = raw.replace(/[€$£¥\s'"A-Za-z]/g, '');
  let sign = 1;
  if (/^\(.*\)$/.test(s)) {
    sign = -1;
    s = s.slice(1, -1);
  } else if (s.endsWith('-')) {
    sign = -1; // trailing minus ("100-")
  } else if (s.startsWith('-')) {
    sign = -1;
  }
  s = s.replace(/[-+]/g, '');
  // strip the OTHER separator (thousands groups), keep the decimal one
  s = s.replace(decimal === ',' ? /\./g : /,/g, '');
  const parts = decimal === ',' ? s.split(',') : s.split('.');
  let cents: string;
  if (parts.length === 2) cents = `${parts[0]}.${parts[1].padEnd(2, '0').slice(0, 2)}`;
  else cents = `${s}.00`;
  const value = Number(cents);
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1000) * sign;
}

function pickDelimiter(lines: string[]): string {
  const sample = lines.slice(0, 5);
  let best = ';';
  let bestScore = -1;
  for (const d of [';', ',', '\t']) {
    const counts = sample.map((l) => splitLine(l, d).length);
    const min = Math.min(...counts);
    const consistent = counts.every((c) => c === counts[0]);
    const score = (min - 1) * 10 + (consistent ? 5 : 0);
    if (min >= 2 && score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

export function sniffCsv(text: string): CsvSpec {
  const noBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = noBom.replace(/\r/g, '').split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    return { delimiter: ';', headerRow: -1, header: [], columns: { date: 0, payee: 1, amount: 2, outflow: null, inflow: null, memo: null }, dateOrder: 'DMY', decimal: ',', confidence: 0 };
  }
  const delimiter = pickDelimiter(lines);
  const table = lines.map((l) => splitLine(l, delimiter));

  // header: first 3 lines scored against the keyword sets
  let headerRow = -1;
  let roles: Partial<Record<keyof typeof KEYWORDS, number>> = {};
  let headerScore = 0;
  for (let i = 0; i < Math.min(3, lines.length); i++) {
    const { score, roles: r } = scoreHeader(table[i]);
    if (score >= 2 && score > headerScore) {
      headerRow = i;
      roles = r;
      headerScore = score;
    }
  }
  const header = headerRow >= 0 ? table[headerRow] : [];
  const dataRows = table.filter((_, i) => i !== headerRow);
  const nCols = Math.max(...table.map((r) => r.length));

  // ---- column mapping ----
  let columns: CsvColumns;
  if (headerRow >= 0 && (roles.date !== undefined || roles.amount !== undefined || roles.outflow !== undefined)) {
    columns = {
      date: roles.date ?? 0,
      payee: roles.payee ?? 1,
      amount: roles.amount ?? null,
      outflow: roles.outflow ?? null,
      inflow: roles.inflow ?? null,
      memo: roles.memo ?? null,
    };
  } else {
    // positional inference from the data
    const isDateCol = (idx: number) => {
      const vals = dataRows.slice(0, 10).map((r) => r[idx] ?? '');
      return vals.filter((v) => looksLikeDate(v)).length >= Math.max(1, vals.length * 0.6);
    };
    const isNumCol = (idx: number) => {
      const vals = dataRows.slice(0, 10).map((r) => r[idx] ?? '');
      return vals.every((v) => v === '' || /^[-+(]?[\d.,]+[-)]?$/.test(v)) && vals.some((v) => v !== '');
    };
    const dateCol = Array.from({ length: nCols }, (_, i) => i).find(isDateCol) ?? 0;
    const numCols = Array.from({ length: nCols }, (_, i) => i).filter((i) => i !== dateCol && isNumCol(i));
    const amountCol = numCols.length > 0 ? numCols[numCols.length - 1] : null;
    const payeeCol = Array.from({ length: nCols }, (_, i) => i).find((i) => i !== dateCol && !numCols.includes(i)) ?? 1;
    columns = { date: dateCol, payee: payeeCol, amount: amountCol, outflow: null, inflow: null, memo: null };
  }

  // ---- date order ----
  const dateSamples = dataRows.slice(0, 12).map((r) => r[columns.date] ?? '').filter(Boolean);
  let dateOrder: CsvSpec['dateOrder'] = 'DMY';
  if (dateSamples.every((s) => /^\d{4}[-/.]/.test(s))) dateOrder = 'ISO';
  else if (dateSamples.some((s) => { const m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/); return m && Number(m[2]) > 12; })) dateOrder = 'MDY';

  // ---- decimal separator ----
  const amountSamples = dataRows
    .slice(0, 12)
    .map((r) => r[columns.amount ?? columns.outflow ?? columns.inflow ?? 0] ?? '')
    .filter((s) => /[-.,\d]/.test(s));
  let decimal: ',' | '.' = '.';
  if (amountSamples.some((s) => /,\d{2}\s*$/.test(s))) decimal = ',';
  else if (amountSamples.some((s) => /\.\d{2}\s*$/.test(s))) decimal = '.';
  else if (amountSamples.some((s) => s.includes(','))) decimal = ',';

  // ---- confidence ----
  let confidence = 0.3;
  if (headerRow >= 0) confidence = Math.min(0.9, 0.4 + headerScore * 0.08);
  if (columns.amount !== null || (columns.outflow !== null && columns.inflow !== null)) confidence += 0.05;
  const parsed = dataRows.slice(0, 10).filter((r) => parseDate(r[columns.date] ?? '', dateOrder));
  if (parsed.length >= Math.min(3, Math.max(1, dataRows.length))) confidence += 0.05;

  return { delimiter, headerRow, header, columns, dateOrder, decimal, confidence: Math.min(1, confidence) };
}

// Parse rows to normalizedCsvRow[] per a spec. max limits the output (preview).
export function parseCsvRows(text: string, spec: CsvSpec, max = Infinity): CsvRow[] {
  const noBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = noBom.replace(/\r/g, '').split('\n').filter((l) => l.trim().length > 0);
  const out: CsvRow[] = [];
  for (let i = 0; i < lines.length && out.length < max; i++) {
    if (i === spec.headerRow) continue;
    const cells = splitLine(lines[i], spec.delimiter);
    const date = parseDate(cells[spec.columns.date] ?? '', spec.dateOrder);
    if (!date) continue;
    const payee = (cells[spec.columns.payee] ?? '').trim();
    let amount = 0;
    if (spec.columns.outflow !== null || spec.columns.inflow !== null) {
      const outflow = spec.columns.outflow !== null ? parseAmountMilli(cells[spec.columns.outflow] ?? '', spec.decimal) : 0;
      const inflow = spec.columns.inflow !== null ? parseAmountMilli(cells[spec.columns.inflow] ?? '', spec.decimal) : 0;
      amount = inflow - outflow;
    } else if (spec.columns.amount !== null) {
      amount = parseAmountMilli(cells[spec.columns.amount] ?? '', spec.decimal);
    }
    if (amount === 0) continue; // summary / empty rows
    const memo = spec.columns.memo !== null ? (cells[spec.columns.memo] ?? '').trim() : '';
    out.push({ date, payee: payee || 'Unknown', amount, memo });
  }
  return out;
}
