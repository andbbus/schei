// Engine tests for schedule.ts (occurrence math + range expansion).

import { strict as assert } from 'node:assert';
import { nextOccurrence, occurrencesInRange } from './schedule';

// monthly with anchor day avoids the 31st drift
assert.equal(nextOccurrence('monthly', '2026-01-31', 31), '2026-02-28');
assert.equal(nextOccurrence('monthly', '2026-02-28', 31), '2026-03-31');
assert.equal(nextOccurrence('monthly', '2026-03-15'), '2026-04-15');
assert.equal(nextOccurrence('weekly', '2026-08-03'), '2026-08-10');
assert.equal(nextOccurrence('everyOtherWeek', '2026-08-03'), '2026-08-17');
assert.equal(nextOccurrence('yearly', '2026-02-28', 28), '2027-02-28');
assert.equal(nextOccurrence('once', '2026-08-03'), null);

// range expansion
assert.deepEqual(
  occurrencesInRange('monthly', '2026-08-05', '2026-08-01', '2026-08-31'),
  ['2026-08-05'],
);
assert.deepEqual(
  occurrencesInRange('monthly', '2026-08-05', '2026-08-01', '2026-10-31'),
  ['2026-08-05', '2026-09-05', '2026-10-05'],
);
assert.deepEqual(occurrencesInRange('monthly', '2026-08-05', '2026-08-01', '2026-08-31', 5, '2026-08-01'), ['2026-08-05'], 'endMonth inclusive');
assert.deepEqual(occurrencesInRange('once', '2026-09-10', '2026-08-01', '2026-08-31'), []);
assert.deepEqual(occurrencesInRange('once', '2026-08-10', '2026-08-01', '2026-08-31'), ['2026-08-10']);
// weekly inside one month
assert.deepEqual(
  occurrencesInRange('weekly', '2026-08-03', '2026-08-01', '2026-08-31'),
  ['2026-08-03', '2026-08-10', '2026-08-17', '2026-08-24', '2026-08-31'],
);

console.log('schedule: ok');
