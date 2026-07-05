// Recurrence date math for scheduled transactions. Pure, UTC, testable.

import { addMonths } from './budget';

export type Frequency = 'once' | 'weekly' | 'everyOtherWeek' | 'monthly' | 'yearly';

function addDays(date: string, n: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Clamp a day-of-month to what the month actually has (31 Jan → 28 Feb).
function clampDay(month: string, day: number): string {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month.slice(0, 7)}-${String(Math.min(day, last)).padStart(2, '0')}`;
}

// Next occurrence after `date`, or null when the schedule is exhausted.
// ponytail: monthly anchor = day of the current nextDate, so a 31st schedule
// drifts to 28/30 after clamping — store an anchorDay if it ever matters.
export function nextOccurrence(frequency: string, date: string): string | null {
  switch (frequency as Frequency) {
    case 'once':
      return null;
    case 'weekly':
      return addDays(date, 7);
    case 'everyOtherWeek':
      return addDays(date, 14);
    case 'monthly':
      return clampDay(addMonths(date.slice(0, 7) + '-01', 1), Number(date.slice(8, 10)));
    case 'yearly': {
      const next = `${Number(date.slice(0, 4)) + 1}${date.slice(4, 7)}`;
      return clampDay(next.slice(0, 7) + '-01', Number(date.slice(8, 10)));
    }
    default:
      return null;
  }
}
