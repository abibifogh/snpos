import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canEditCatalogue, canDeleteCatalogue } from '../access.ts';
import type { StaffProfile } from '../types.ts';

const who = (over: Partial<StaffProfile>): StaffProfile => ({ role: 'waiter', ...over } as StaffProfile);

test('an admin may always delete', () => {
  assert.equal(canDeleteCatalogue(who({ role: 'admin' })), true);
  // Even without the flag, which is not something an admin should have to
  // grant themselves.
  assert.equal(canDeleteCatalogue(who({ role: 'admin', can_delete_items: false })), true);
});

test('a manager may edit but not delete, until an admin says so', () => {
  const manager = who({ role: 'manager' });
  assert.equal(canEditCatalogue(manager), true, 'editing is unchanged');
  assert.equal(canDeleteCatalogue(manager), false);
  assert.equal(canDeleteCatalogue(who({ role: 'manager', can_delete_items: true })), true);
});

test('the flag alone is not enough without the right to edit at all', () => {
  // A waiter handed the delete flag by accident still cannot reach the
  // catalogue, so granting it must not quietly become a way in.
  const waiter = who({ role: 'waiter', can_delete_items: true });
  assert.equal(canEditCatalogue(waiter), false);
  assert.equal(canDeleteCatalogue(waiter), false);
});

test('nobody signed out deletes anything', () => {
  assert.equal(canDeleteCatalogue(null), false);
});

test('absent reads as no, which is what every existing row will say', () => {
  // The field arrives after the rows do, so every profile already in the
  // database has no value for it. That has to mean "not allowed".
  const manager = who({ role: 'manager' });
  assert.equal(manager.can_delete_items, undefined);
  assert.equal(canDeleteCatalogue(manager), false);
});
