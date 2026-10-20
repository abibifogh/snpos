import test from 'node:test';
import assert from 'node:assert/strict';
import { orderToTell, orderNoticeRecipients } from '../../../../functions/notify/src/po-notice.js';

test('only an order somebody finished, and only once', () => {
  assert.equal(orderToTell({ status: 'waiting' }), true);
  assert.equal(orderToTell({ status: 'ready' }), true);
  assert.equal(orderToTell({ status: 'draft' }), false, 'still being written');
  assert.equal(orderToTell({ status: 'sent' }), false);
  assert.equal(orderToTell({ status: 'waiting', admin_told_at: '2026-10-20T12:00:00Z' }), false);
  assert.equal(orderToTell(null), false);
});

test('the admins with an address, not inactive ones, not whoever made it', () => {
  const profiles = [
    { $id: 'p1', user_id: 'u1', role: 'admin', email: 'owner@x.com', active: true },
    { $id: 'p2', user_id: 'u2', role: 'admin', email: 'partner@x.com', active: true },
    { $id: 'p3', user_id: 'u3', role: 'admin', email: 'gone@x.com', active: false },
    { $id: 'p4', user_id: 'u4', role: 'manager', email: 'manager@x.com', active: true },
    { $id: 'p5', user_id: 'u5', role: 'admin', email: '', active: true },
  ];
  assert.deepEqual(orderNoticeRecipients(profiles, 'u4', ['reports@x.com']), ['owner@x.com', 'partner@x.com']);
  assert.deepEqual(orderNoticeRecipients(profiles, 'u1'), ['partner@x.com'], 'the admin who made it is left out');
});

test('with no admin address on file at all, the stock-alert list hears instead', () => {
  const profiles = [{ $id: 'p1', role: 'admin', email: '', active: true }];
  assert.deepEqual(orderNoticeRecipients(profiles, 'u9', ['reports@x.com', 'reports@x.com']), ['reports@x.com']);
  assert.deepEqual(orderNoticeRecipients([], 'u9', []), []);
});
