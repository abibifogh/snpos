import test from 'node:test';
import assert from 'node:assert/strict';
import { isGroupPath, groupLink, GROUP_PATH } from '../group-link.ts';

test('the group menu is known by its address, wherever the site is served from', () => {
  // A domain of its own, and a repository subfolder on github.io.
  assert.equal(isGroupPath('/menu/group'), true);
  assert.equal(isGroupPath('/snpos/menu/group'), true);
  // With the slash a browser adds when it asks a folder for its index.
  assert.equal(isGroupPath('/menu/group/'), true);
  assert.equal(isGroupPath('/snpos/menu/group/'), true);
});

test('the ordinary menu is not the group menu', () => {
  assert.equal(isGroupPath('/menu'), false);
  assert.equal(isGroupPath('/menu/'), false);
  assert.equal(isGroupPath('/'), false);
  assert.equal(isGroupPath(''), false);
  // A dish called "group" would be a route, not this. Only the last segment.
  assert.equal(isGroupPath('/menu/group/starters'), false);
  assert.equal(isGroupPath('/menu/groups'), false);
  assert.equal(isGroupPath('/menu/grouping'), false);
});

test('the link is built from where the menu actually lives', () => {
  assert.equal(groupLink('https://pos.example.com/menu'), 'https://pos.example.com/menu/group');
  // A trailing slash on the base must not produce a double one.
  assert.equal(groupLink('https://pos.example.com/menu/'), 'https://pos.example.com/menu/group');
  assert.equal(groupLink('http://localhost:5173'), `http://localhost:5173/${GROUP_PATH}`);
});
