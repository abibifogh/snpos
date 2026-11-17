import test from 'node:test';
import assert from 'node:assert/strict';
import { storedCode, voucherCodeProblem } from '../voucher-code.ts';

const NOW = new Date('2026-11-16T12:00:00Z');

test('no code is stored as nothing, so any number of staff-only vouchers can exist', () => {
  assert.equal(storedCode(''), null);
  assert.equal(storedCode('   '), null);
  assert.equal(storedCode(undefined), null);
  assert.equal(storedCode(' 2nyt '), '2NYT');
  assert.equal(voucherCodeProblem('', [{ $id: 'a', code: '' }], null, NOW), null);
});

test('a code already on another voucher is named, with why it may have been forgotten', () => {
  const others = [
    { $id: 'a', name: 'Christmas lunch', code: '2nyt', active: false },
    { $id: 'b', name: 'Staff meal', code: 'STAFF', ends_at: '2026-10-01T00:00:00Z' },
    { $id: 'c', name: 'Weekend', code: 'WKND' },
  ];
  assert.match(voucherCodeProblem('2NYT', others, null, NOW) ?? '', /^2NYT is already the code of "Christmas lunch", which is switched off\./);
  assert.match(voucherCodeProblem('staff', others, null, NOW) ?? '', /"Staff meal", which has ended/);
  assert.match(voucherCodeProblem('wknd', others, null, NOW) ?? '', /"Weekend"\. Choose a different code/);
  assert.equal(voucherCodeProblem('NEW1', others, null, NOW), null);
});

test('a voucher keeping its own code is not a clash with itself', () => {
  assert.equal(voucherCodeProblem('WKND', [{ $id: 'c', name: 'Weekend', code: 'WKND' }], 'c', NOW), null);
});
