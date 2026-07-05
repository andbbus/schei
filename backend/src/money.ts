// Milliunits: 1 currency unit = 1000 milliunits. All money is integer milliunits.
// Float math is confined to parsing/formatting at the edges only.
export const MILLI = 1000;

export function toMilli(amount: number): number {
  return Math.round(amount * MILLI);
}

export function fromMilli(m: number): number {
  return m / MILLI;
}

// Parse a user/CSV money string ("$1,234.56", "(50.00)", "-12") into milliunits.
export function parseMoney(input: string | number | null | undefined): number {
  if (input == null) return 0;
  if (typeof input === 'number') return Math.round(input * MILLI);
  const s = input.trim();
  if (!s) return 0;
  const negative = s.startsWith('-') || /^\(.*\)$/.test(s);
  const cleaned = s.replace(/[^0-9.]/g, '');
  if (!cleaned) return 0;
  const val = Math.round(parseFloat(cleaned) * MILLI);
  return negative ? -val : val;
}

// Format milliunits for display ("-$1,234.56").
export function formatMilli(
  m: number,
  opts?: { symbol?: string; digits?: number; locale?: string },
): string {
  const symbol = opts?.symbol ?? '$';
  const digits = opts?.digits ?? 2;
  const locale = opts?.locale ?? 'en-US';
  const negative = m < 0;
  const abs = Math.abs(m) / MILLI;
  const body = abs.toLocaleString(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return `${negative ? '-' : ''}${symbol}${body}`;
}
