import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normaliseName, findDuplicates, removalKind, describeGroup, hasImage,
  planMerge,
} from '../duplicates.ts';

const craft = (over: Record<string, unknown>) => ({
  $id: 'x', name: 'Thing', module: 'craft', ...over,
} as Parameters<typeof findDuplicates>[0][number]);

test('the same name typed three ways is one name', () => {
  assert.equal(normaliseName('Beaded Necklace'), 'beaded necklace');
  assert.equal(normaliseName('beaded  necklace '), 'beaded necklace');
  assert.equal(normaliseName('Beaded Necklace.'), 'beaded necklace');
});

test('punctuation that carries meaning is left alone', () => {
  // "Bowl (large)" and "Bowl (small)" are not the same bowl, and stripping
  // brackets to be tidy would merge two real products into one.
  assert.notEqual(normaliseName('Bowl (large)'), normaliseName('Bowl (small)'));
});

test('the copy with the picture is the one kept', () => {
  const groups = findDuplicates([
    craft({ $id: 'a', name: 'Kente scarf' }),
    craft({ $id: 'b', name: 'Kente scarf', image_id: 'img1' }),
  ], { module: 'craft' });

  assert.equal(groups.length, 1);
  assert.equal(groups[0].keep?.$id, 'b');
  assert.deepEqual(groups[0].drop.map((r) => r.$id), ['a']);
});

test('two makers with the same product are not duplicates', () => {
  // A consignment shop's real hazard. Merging these takes one maker's stock
  // off the shelf and points their ledger at a row that no longer exists.
  const rows = [
    craft({ $id: 'a', name: 'Beaded necklace', consignor_id: 'ama', image_id: 'i' }),
    craft({ $id: 'b', name: 'Beaded necklace', consignor_id: 'kofi' }),
  ];
  assert.deepEqual(findDuplicates(rows, { module: 'craft' }), []);

  // Unless the shop owns its stock and says so.
  const loose = findDuplicates(rows, { module: 'craft', acrossOwners: true });
  assert.equal(loose.length, 1);
  assert.equal(loose[0].keep?.$id, 'a');
});

test('when no copy has a picture, nothing is touched', () => {
  const groups = findDuplicates([
    craft({ $id: 'a', name: 'Clay pot' }),
    craft({ $id: 'b', name: 'Clay pot' }),
  ], { module: 'craft' });

  assert.equal(groups[0].skipped, 'none-has-a-picture');
  assert.deepEqual(groups[0].drop, []);
  assert.equal(groups[0].keep, undefined);
});

test('when several copies have pictures, nothing is touched', () => {
  // "Remove the ones without pictures" runs out before the job is done, and
  // picking between two photographed pieces is a person's call.
  const groups = findDuplicates([
    craft({ $id: 'a', name: 'Stool', image_id: 'i1' }),
    craft({ $id: 'b', name: 'Stool', image_id: 'i2' }),
    craft({ $id: 'c', name: 'Stool' }),
  ], { module: 'craft' });

  assert.equal(groups[0].skipped, 'several-have-pictures');
  assert.deepEqual(groups[0].drop, []);
});

test('a blank image id does not count as a picture', () => {
  assert.equal(hasImage(craft({ image_id: '   ' })), false);
  assert.equal(hasImage(craft({ image_id: undefined })), false);
  assert.equal(hasImage(craft({ image_id: 'i' })), true);
});

test('the kitchen is not swept up in a craft tidy-up', () => {
  const rows = [
    craft({ $id: 'a', name: 'Jollof', module: 'kitchen' }),
    craft({ $id: 'b', name: 'Jollof', module: 'kitchen', image_id: 'i' }),
  ];
  assert.deepEqual(findDuplicates(rows, { module: 'craft' }), []);
});

test('a single row is not a duplicate of itself', () => {
  assert.deepEqual(findDuplicates([craft({ $id: 'a', name: 'Only one' })], { module: 'craft' }), []);
});

test('a row that has sold is archived, never deleted', () => {
  // Thirteen other tables point at a product. Deleting one that has been sold
  // leaves a consignor statement that will not add up, weeks later.
  assert.equal(removalKind(craft({}), true), 'archive');
  assert.equal(removalKind(craft({}), false), 'delete');
});

test('a row with stock on the shelf is archived too', () => {
  // Never sold, but there are three of them on the shelf. Deleting the row
  // makes them vanish from the count while staying physically present.
  assert.equal(removalKind(craft({ on_hand: 3 }), false), 'archive');
  assert.equal(removalKind(craft({ on_hand: 0 }), false), 'delete');
});

test('the report says what will happen in words', () => {
  const groups = findDuplicates([
    craft({ $id: 'a', name: 'Kente scarf' }),
    craft({ $id: 'b', name: 'Kente scarf', image_id: 'i' }),
    craft({ $id: 'c', name: 'Kente scarf' }),
  ], { module: 'craft' });

  const sold = (id: string) => id === 'c';
  assert.equal(
    describeGroup(groups[0], sold),
    'Kente scarf: keeping the one with the picture, 1 deleted, 1 archived (has sales or stock).',
  );
});

test('the groups needing a person come first', () => {
  const rows = [
    craft({ $id: 'a1', name: 'Alpha' }),
    craft({ $id: 'a2', name: 'Alpha', image_id: 'i' }),
    craft({ $id: 'z1', name: 'Zeta' }),
    craft({ $id: 'z2', name: 'Zeta', image_id: 'i' }),
  ];
  // Zeta's doomed copy has been sold, so it must not be buried below Alpha
  // just because Z comes after A.
  const groups = findDuplicates(rows, { module: 'craft', hasHistory: (id) => id === 'z1' });
  assert.deepEqual(groups.map((g) => g.label), ['Zeta', 'Alpha']);
});

/* --------------------------------------------------------------- merging */

test('the shelf counts are added together', () => {
  // Four here and one there is five things on the shelf. If the surviving row
  // does not account for all five, the next count comes up short.
  const plan = planMerge([
    craft({ $id: 'old', on_hand: 1, $createdAt: '2026-08-13T15:23:00Z' }),
    craft({ $id: 'new', on_hand: 4, $createdAt: '2026-08-17T15:46:00Z' }),
  ])!;
  assert.equal(plan.patch.on_hand, 5);
});

test('a piece with sizes does not have its count added twice', () => {
  // With variants the count lives on each one. The variants move across
  // intact, so adding the parent totals as well counts everything twice.
  const plan = planMerge([
    craft({ $id: 'old', on_hand: 1 }),
    craft({ $id: 'new', on_hand: 4 }),
  ], { hasVariants: true })!;
  assert.equal('on_hand' in plan.patch, false);
});

test('the maker is rescued from the copy being removed', () => {
  // The real hazard in this shop: one import attached makers and the other did
  // not. A craft shop that loses the maker link cannot pay anybody.
  const plan = planMerge([
    craft({ $id: 'old', image_id: 'i', $createdAt: '2026-08-13T00:00:00Z' }),
    craft({ $id: 'new', consignor_id: 'ama', $createdAt: '2026-08-17T00:00:00Z' }),
  ])!;
  assert.equal(plan.keep.$id, 'old');
  assert.equal(plan.patch.consignor_id, 'ama');
});

test('a copy never overwrites an answer the keeper already has', () => {
  const plan = planMerge([
    craft({ $id: 'keep', image_id: 'i', consignor_id: 'ama' }),
    craft({ $id: 'other', consignor_id: 'kofi' }),
  ])!;
  assert.equal(plan.keep.$id, 'keep');
  assert.equal('consignor_id' in plan.patch, false);
});

test('a blank string does not count as an answer', () => {
  const plan = planMerge([
    craft({ $id: 'keep', image_id: 'i', consignor_id: '  ' }),
    craft({ $id: 'other', consignor_id: 'kofi' }),
  ])!;
  assert.equal(plan.patch.consignor_id, 'kofi');
});

test('the busiest row is kept, so the fewest records have to move', () => {
  // Every reference on the losing row has to be re-pointed by hand, and every
  // move is a chance to get something wrong.
  const plan = planMerge([
    craft({ $id: 'quiet', $createdAt: '2026-08-13T00:00:00Z' }),
    craft({ $id: 'busy', $createdAt: '2026-08-17T00:00:00Z' }),
  ], { references: (id) => (id === 'busy' ? 40 : 2) })!;
  assert.equal(plan.keep.$id, 'busy');
});

test('a picture outranks being busy', () => {
  // It is the row staff recognise on the screen.
  const plan = planMerge([
    craft({ $id: 'pretty', image_id: 'i' }),
    craft({ $id: 'busy' }),
  ], { references: (id) => (id === 'busy' ? 99 : 0) })!;
  assert.equal(plan.keep.$id, 'pretty');
});

test('age breaks a tie', () => {
  const plan = planMerge([
    craft({ $id: 'newer', $createdAt: '2026-08-17T00:00:00Z' }),
    craft({ $id: 'older', $createdAt: '2026-08-13T00:00:00Z' }),
  ])!;
  assert.equal(plan.keep.$id, 'older');
});

test('one row alone is not a merge', () => {
  assert.equal(planMerge([craft({ $id: 'a' })]), null);
});
