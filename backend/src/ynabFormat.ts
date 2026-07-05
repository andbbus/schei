// Parsers for YNAB's TSV export (Italian/European number + date format).
// Shared by the importer (TSV → DB) and the oracle (TSV → engine validation).

export function parseTsv(text: string): string[][] {
  const noBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // YNAB export has a UTF-8 BOM
  return noBom
    .replace(/\r/g, '')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((line) =>
      line.split('\t').map((cell) => {
        let c = cell;
        if (c.startsWith('"') && c.endsWith('"')) c = c.slice(1, -1);
        return c.replace(/""/g, '"');
      }),
    );
}

// "€9,99" / "-€17,99" / "€1.208,00" → milliunits. European: '.' = thousands, ',' = decimal.
// ponytail: tuned to this export's it-IT format; if a US-format export shows up, swap separators.
export function parseEuroMilli(s: string): number {
  if (!s) return 0;
  const negative = s.includes('-');
  const cleaned = s.replace(/[^0-9.,]/g, '').replace(/\./g, '').replace(',', '.');
  if (!cleaned) return 0;
  const v = Math.round(parseFloat(cleaned) * 1000);
  return negative ? -v : v;
}

// "12/07/2026" (DD/MM/YYYY) → "2026-07-12"
export function parseEuDate(s: string): string {
  const [dd, mm, yyyy] = s.split('/');
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

const MON: Record<string, string> = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

// "Jul 2025" → "2025-07-01"
export function parseMonthLabel(s: string): string {
  const [mon, yr] = s.trim().split(/\s+/);
  return `${yr}-${MON[mon] ?? '01'}-01`;
}

export const clearedFromLabel = (s: string): 'uncleared' | 'cleared' | 'reconciled' => {
  const l = s.toLowerCase();
  if (l === 'reconciled') return 'reconciled';
  if (l === 'cleared') return 'cleared';
  return 'uncleared';
};
