import test from 'node:test';
import assert from 'node:assert/strict';
import { searchMenu } from '../menu-search.ts';

const entry = (id: string, name: string, extra: { description?: string; sku?: string; tags?: string[] } = {}, variants?: { label: string; barcode: string }[]) => ({
  item: { $id: id, name, ...extra }, price: 0, soldOut: false, groups: [], station: '', stationKey: '', variants,
});
const section = (name: string, entries: ReturnType<typeof entry>[]) => ({ category: { $id: name, name }, open: true, entries });

const SECTIONS = [
  section('Cosmetics', [
    entry('lav', 'Lavender oil'),
    entry('avo', 'Avocado oil'),
    entry('soap', 'Black soap (raw)', { description: 'Shea and plantain ash' }),
    entry('lip', 'Lip balm', { sku: 'LB-01' }),
    entry('mor', 'Moringa Soap', { tags: ['vegan'] }),
  ]),
  section('Coffee', [entry('cafe', 'Café au lait'), entry('oilcan', 'Oil can espresso')]),
  section('Gifts', [entry('lip', 'Lip balm', { sku: 'LB-01' })]),
  section('Bag', [entry('tote', 'Woven tote', {}, [{ label: 'Large', barcode: '6001234' }])]),
];
const names = (term: string) => searchMenu(SECTIONS, term).map((h) => h.entry.item.name);

test('the till search finds a product wherever it is filed, best first', () => {
  assert.deepEqual(names(''), []);
  assert.deepEqual(names('lip'), ['Lip balm'], 'once, though two categories hold it');
  // Names starting with it first, then a word starting with it, then the rest.
  assert.deepEqual(names('oil'), ['Oil can espresso', 'Avocado oil', 'Lavender oil']);
  assert.deepEqual(names('SOAP'), ['Black soap (raw)', 'Moringa Soap']);
  assert.deepEqual(names('cafe'), ['Café au lait'], 'accents ignored');
  assert.deepEqual(names('soap shea'), ['Black soap (raw)'], 'every word, from the description too');
  assert.deepEqual(names('vegan'), ['Moringa Soap'], 'tags');
  assert.deepEqual(names('coffee'), ['Café au lait', 'Oil can espresso'], 'the category name');
  assert.deepEqual(names('6001234'), ['Woven tote'], 'a size\'s barcode, as a scanner types it');
  assert.deepEqual(names('lb-01'), ['Lip balm'], 'a code');
  assert.equal(searchMenu(SECTIONS, 'lip')[0].section.category.name, 'Cosmetics');
  assert.deepEqual(names('zzz'), []);
});
