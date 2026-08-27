// Engine tests for autoAssignAmount + planUnderfunded. Run via `npm test`.

import { strict as assert } from 'node:assert';
import { autoAssignAmount, planUnderfunded } from './autoAssign';

const month = '2026-08-01';
const prev = '2026-07-01';
const hist = {
  [prev]: { assigned: 100000, activity: -60000, available: 40000 },
  [month]: { assigned: 30000, activity: -10000, available: 20000 },
};

// quick-fund buttons
assert.equal(autoAssignAmount('assignedLastMonth', month, hist, 0), 100000);
assert.equal(autoAssignAmount('spentLastMonth', month, hist, 0), 60000);
assert.equal(autoAssignAmount('underfunded', month, hist, 25000), 55000); // assigned + shortfall
assert.equal(autoAssignAmount('averageAssigned', month, hist, 0), 33333); // 100k over 3 months
assert.equal(autoAssignAmount('averageSpent', month, hist, 0), 20000);
assert.equal(autoAssignAmount('resetAvailable', month, hist, 0), 10000); // makes available 0
assert.equal(autoAssignAmount('resetAssigned', month, hist, 0), 0);
// missing history months degrade to 0
assert.equal(autoAssignAmount('spentLastMonth', month, {}, 0), 0);

// planUnderfunded: largest first, capped at RTA
const plan = planUnderfunded(
  [
    { categoryId: 'a', underfunded: 80000 },
    { categoryId: 'b', underfunded: 50000 },
    { categoryId: 'c', underfunded: 20000 },
  ],
  100000,
);
assert.deepEqual(plan, [
  { categoryId: 'a', add: 80000 },
  { categoryId: 'b', add: 20000 },
]);
// remainder goes to the next category exactly
assert.deepEqual(planUnderfunded([{ categoryId: 'a', underfunded: 30000 }, { categoryId: 'b', underfunded: 90000 }], 100000), [
  { categoryId: 'b', add: 90000 },
  { categoryId: 'a', add: 10000 },
]);
// non-positive RTA or shortfalls → nothing
assert.deepEqual(planUnderfunded([{ categoryId: 'a', underfunded: 5000 }], 0), []);
assert.deepEqual(planUnderfunded([{ categoryId: 'a', underfunded: 0 }], 50000), []);
assert.deepEqual(planUnderfunded([{ categoryId: 'a', underfunded: -100 }], 50000), []);
// exactly enough RTA covers everyone
assert.deepEqual(planUnderfunded([{ categoryId: 'a', underfunded: 1 }, { categoryId: 'b', underfunded: 2 }], 3), [
  { categoryId: 'b', add: 2 },
  { categoryId: 'a', add: 1 },
]);

console.log('autoAssign: ok');
