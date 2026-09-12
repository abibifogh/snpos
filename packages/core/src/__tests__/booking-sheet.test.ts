import test from 'node:test';
import assert from 'node:assert/strict';
import { Doc, widthOf, latin1, rgb } from '../../../../functions/notify/src/pdf-doc.js';
import { bookingSheetPdf, bookingSittings } from '../../../../functions/notify/src/booking-sheet.js';
import * as fnDiet from '../../../../functions/notify/src/diet.js';
import { DIETARY_TAGS, tagsWithOptions, tagsWithout, parseOmissions } from '../dietary.ts';

/* ------------------------------------------------------- the drawing itself */

test('the cedi becomes a currency code rather than a black diamond', () => {
  // Latin-1 is what the built-in fonts can draw. Everything else is a lie
  // shaped like a glyph.
  assert.equal(latin1('₵40'), 'GHS40');
  assert.equal(latin1('two — three'), 'two - three');
  assert.equal(latin1('café'), 'café');
  assert.equal(latin1('中'), '?');
});

test('Helvetica is measured, not guessed', () => {
  // The width table is the only thing standing between a long dish name and a
  // line that runs off the paper.
  assert.ok(widthOf('iiii', 10) < widthOf('MMMM', 10));
  // Bold is wider than regular for the same letters.
  assert.ok(widthOf('Booking', 10, true) > widthOf('Booking', 10, false));
  // An accent must not measure as nothing, or a name with one in it wraps late.
  assert.equal(widthOf('cafe', 10), widthOf('café', 10));
  assert.equal(widthOf('', 10), 0);
});

test('a colour that is not a colour draws black rather than breaking the file', () => {
  assert.deepEqual(rgb('#000000'), [0, 0, 0]);
  assert.deepEqual(rgb('#ffffff'), [1, 1, 1]);
  assert.deepEqual(rgb('not a colour'), [0, 0, 0]);
  assert.deepEqual(rgb(''), [0, 0, 0]);
});

test('text that runs past the bottom starts a second page', () => {
  const doc = new Doc();
  for (let i = 0; i < 120; i++) doc.text(`Line ${i}`, { size: 11 });
  const bytes = doc.build({ foot: (page, total) => `page ${page} of ${total}` });
  const pdf = bytes.toString('latin1');

  assert.ok(pdf.startsWith('%PDF-1.4'));
  assert.ok(pdf.endsWith('%%EOF'));
  const count = /\/Count (\d+)/.exec(pdf);
  assert.ok(count && Number(count[1]) > 1, 'a hundred and twenty lines is more than one page');
  // Every page says which it is, so a sheet with a page missing shows it.
  assert.ok(pdf.includes('(page 1 of '));
  assert.ok(pdf.includes('(page 2 of '));
});

test('a bracket in a dish name does not break the document', () => {
  /*
    Unescaped, a bracket closes the string operator and the rest of the page
    becomes instructions. "Kelewele (spiced)" is an ordinary thing to call a
    dish, so this has to survive it.
  */
  const doc = new Doc();
  doc.text('Kelewele (spiced) \\ half');
  const pdf = doc.build().toString('latin1');
  assert.ok(pdf.includes('Kelewele \\(spiced\\) \\\\ half'));
});

/* --------------------------------------------------- the sheet, end to end */

const booking = {
  $id: 'bk1',
  venue_id: 'v1',
  reference: 'Hotel Reg 4471',
  contact_name: 'Ama Mensah',
  email: 'ama@example.com',
  currency_code: 'GHS',
  total: 24_000,
  order_nos: 'A-1041, A-1042',
  first_at: '2026-10-02T11:00:00.000Z',
  last_at: '2026-10-03T18:00:00.000Z',
};

const sittings = [
  {
    order: {
      $id: 'o1', order_no: 'A-1041', scheduled_for: '2026-10-02T11:00:00.000Z',
      fulfilment: 'dine_in', group_service: 'buffet', total: 14_000,
    },
    lines: [
      {
        qty: 12, name: 'Jollof rice', variant: '', total: 9_600,
        choices: ['Extra plantain'], omissions: ['No momoni'],
        notes: 'One of the children cannot have nuts at all',
        diets: ['Vegetarian'], cautions: ['Contains nuts'], unknown: [], lost: false,
      },
      {
        qty: 4, name: 'Grilled tilapia', variant: 'Large', total: 4_400,
        choices: [], omissions: [], notes: '',
        diets: [], cautions: [], unknown: ['Pepper sauce'], lost: false,
      },
    ],
  },
  {
    order: {
      $id: 'o2', order_no: 'A-1042', scheduled_for: '2026-10-03T18:00:00.000Z',
      fulfilment: 'takeaway', total: 10_000,
    },
    lines: [
      {
        qty: 10, name: 'Waakye', variant: '', total: 10_000,
        choices: [], omissions: [], notes: '', diets: ['Vegan'], cautions: [], unknown: [], lost: false,
      },
    ],
  },
];

test('the sheet carries every choice, every omission, every note and every tag', () => {
  const pdf = bookingSheetPdf({
    settings: { restaurant_name: 'SN Bistro', currency_code: 'GHS', currency_decimals: 2 },
    venue: { name: 'SN Bistro' },
    booking,
    sittings,
  }).toString('latin1');

  for (const words of [
    'Ama Mensah', 'Hotel Reg 4471', 'ama@example.com',
    'Jollof rice', 'Extra plantain', 'No momoni',
    'One of the children cannot have nuts at all',
    'Vegetarian', 'Contains nuts', 'Pepper sauce', 'Waakye',
    'A-1041', 'A-1042',
  ]) {
    assert.ok(pdf.includes(words.replace(/\(/g, '\\(')), `the sheet must say "${words}"`);
  }

  // Buffet and plated are two different days of work; the sheet says which.
  assert.ok(pdf.includes('Buffet, set out to share'));
  assert.ok(pdf.includes('Packed to take away'));
  // Plates counted from the lines, not from anything anyone typed.
  assert.ok(pdf.includes('26'), '12 + 4 + 10 plates');
});

test('what the party said about the whole booking is on the sheet, whole', () => {
  /*
    Not a dish note. "The coach leaves at two" is true of the arrangement and
    had nowhere to go before this but a telephone call to whoever picked up.
  */
  const said = 'The coach leaves at two, so we cannot run late. One guest is in a wheelchair. '
    + 'Please bring the cake out at the end of the second sitting.';
  const pdf = bookingSheetPdf({
    settings: {}, booking: { ...booking, note: said }, sittings,
  }).toString('latin1');

  assert.ok(pdf.includes('A note from the party'));
  // Every sentence of it, not a summary and not a truncation.
  for (const part of ['The coach leaves at two', 'wheelchair', 'bring the cake out']) {
    assert.ok(pdf.includes(part), `the sheet must say "${part}"`);
  }
  // And it comes before the sittings, like everything else they must read.
  assert.ok(pdf.indexOf('A note from the party') < pdf.indexOf('Sitting 1 of 2'));
});

test('a booking with nothing to add prints no note block', () => {
  for (const note of [undefined, '', '   ']) {
    const pdf = bookingSheetPdf({ settings: {}, booking: { ...booking, note }, sittings })
      .toString('latin1');
    assert.ok(!pdf.includes('A note from the party'));
  }
});

test('what would ruin the service is pulled to the front', () => {
  const pdf = bookingSheetPdf({ settings: {}, booking, sittings }).toString('latin1');
  const notice = pdf.indexOf('What the kitchen must know');
  const firstSitting = pdf.indexOf('Sitting 1 of 2');
  assert.ok(notice > 0 && notice < firstSitting, 'the warnings come before the sittings');
  assert.ok(pdf.includes('Contains nuts: 12 plates'));
  assert.ok(pdf.includes('Not yet recorded as suitable'));
});

test('a booking with nothing worrying on it prints no warning band', () => {
  const quiet = [{
    order: { order_no: 'A-1', scheduled_for: booking.first_at, fulfilment: 'dine_in', total: 1_000 },
    lines: [{
      qty: 2, name: 'Tea', variant: '', total: 1_000, choices: [], omissions: [],
      notes: '', diets: ['Vegan'], cautions: [], unknown: [], lost: false,
    }],
  }];
  const pdf = bookingSheetPdf({ settings: {}, booking, sittings: quiet }).toString('latin1');
  assert.ok(!pdf.includes('What the kitchen must know'));
});

test('a dish taken off the menu says so instead of saying nothing', () => {
  const gone = [{
    order: { order_no: 'A-9', scheduled_for: booking.first_at, fulfilment: 'dine_in', total: 500 },
    lines: [{
      qty: 1, name: 'Something withdrawn', variant: '', total: 500, choices: [], omissions: [],
      notes: '', diets: [], cautions: [], unknown: [], lost: true,
    }],
  }];
  const pdf = bookingSheetPdf({ settings: {}, booking, sittings: gone }).toString('latin1');
  assert.ok(pdf.includes('no longer on the menu'));
  assert.ok(!pdf.includes('Nothing recorded on this dish'), 'one explanation, not two');
});

test('a party of forty runs to more than one page and every page is numbered', () => {
  const many = Array.from({ length: 9 }, (_, s) => ({
    order: {
      order_no: `A-${1000 + s}`, scheduled_for: '2026-10-02T11:00:00.000Z',
      fulfilment: 'dine_in', group_service: 'plated', total: 5_000,
    },
    lines: Array.from({ length: 6 }, (_, i) => ({
      qty: 4, name: `Dish number ${i} on sitting ${s}`, variant: '', total: 800,
      choices: ['Extra plantain', 'Shito on the side'], omissions: ['No momoni'],
      notes: 'Please keep it mild, there are small children at this table',
      diets: ['Vegetarian', 'Gluten free'], cautions: ['Spicy'], unknown: [], lost: false,
    })),
  }));
  const pdf = bookingSheetPdf({ settings: {}, booking, sittings: many }).toString('latin1');
  const count = Number(/\/Count (\d+)/.exec(pdf)?.[1] ?? 0);
  assert.ok(count >= 3, `nine sittings is more than two pages, got ${count}`);
  for (let p = 1; p <= count; p++) assert.ok(pdf.includes(`page ${p} of ${count}`));
});

/* ------------------------------------------------------------- reading it back */

/** The smallest thing that answers like Appwrite's client for this job. */
function fakeDb(tables: Record<string, Record<string, unknown>[]>) {
  return {
    listDocuments: async (_db: string, table: string, queries: string[]) => {
      const field = /"attribute":"([^"]+)"/.exec(queries[0] ?? '')?.[1] ?? '';
      const values = [...(queries[0] ?? '').matchAll(/"values":\[([^\]]*)\]/g)]
        .flatMap((m) => m[1].split(',').map((v) => v.trim().replace(/^"|"$/g, '')));
      const rows = (tables[table] ?? []).filter(
        (r) => values.length === 0 || values.includes(String(r[field === '$id' ? '$id' : field])),
      );
      return { documents: rows, total: rows.length };
    },
  };
}

const Q = {
  equal: (attribute: string, values: unknown) =>
    JSON.stringify({ attribute, values: Array.isArray(values) ? values : [values] }),
  limit: (n: number) => `limit ${n}`,
};

test('what was ordered is read back with its tags recomputed, not copied', async () => {
  /*
    The whole point. The dish is listed vegan; this guest ticked cheese, which
    is not. A sheet that repeated the menu's tag would send a vegan a plate of
    cheese with the word "Vegan" printed beside it.
  */
  const db = fakeDb({
    orders: [{ $id: 'o1', order_no: 'A-1', scheduled_for: '2026-10-02T11:00:00.000Z', group_booking_id: 'bk1' }],
    order_items: [{
      $id: 'i1', order_id: 'o1', menu_item_id: 'm1', name_snapshot: 'Garden bowl', qty: 3,
      line_total: 3_000, status: 'queued', notes: 'no ice please',
      addons: JSON.stringify([
        { option_id: 'opt1', group_id: 'g1', name: 'Extra cheese', price_delta: 200 },
        { option_id: 'omit-o0', group_id: 'omit', name: 'No momoni', price_delta: 0 },
      ]),
    }],
    menu_items: [{
      $id: 'm1', tags: ['vegan', 'gluten_free'],
      omissions: JSON.stringify([{ key: 'o0', name: 'momoni', earns: ['vegetarian'] }]),
    }],
    addon_options: [{ $id: 'opt1', name: 'Extra cheese', tags: ['vegetarian', 'gluten_free'] }],
  });

  const read = await bookingSittings({ db, DB_ID: 'db', Query: Q, booking: { $id: 'bk1' } });
  assert.equal(read.length, 1);
  const line = read[0].lines[0];

  assert.equal(line.name, 'Garden bowl');
  assert.deepEqual(line.choices, ['Extra cheese']);
  assert.deepEqual(line.omissions, ['No momoni']);
  assert.equal(line.notes, 'no ice please');
  // Cheese is vegetarian and gluten free, so the bowl keeps gluten free and
  // loses vegan. It cannot GAIN vegetarian from a choice — but it earns it
  // from the momoni being left out.
  assert.ok(line.diets.includes('Gluten free'));
  assert.ok(line.diets.includes('Vegetarian'));
  assert.ok(!line.diets.includes('Vegan'), 'cheese is not vegan');
  assert.deepEqual(line.unknown, []);
});

test('a choice nobody has judged is named rather than assumed safe', async () => {
  const db = fakeDb({
    orders: [{ $id: 'o1', order_no: 'A-1', group_booking_id: 'bk1' }],
    order_items: [{
      $id: 'i1', order_id: 'o1', menu_item_id: 'm1', name_snapshot: 'Bowl', qty: 1,
      line_total: 1_000, status: 'queued',
      addons: JSON.stringify([{ option_id: 'opt9', group_id: 'g1', name: 'House sauce', price_delta: 0 }]),
    }],
    menu_items: [{ $id: 'm1', tags: ['vegan'] }],
    addon_options: [{ $id: 'opt9', name: 'House sauce' }],
  });
  const read = await bookingSittings({ db, DB_ID: 'db', Query: Q, booking: { $id: 'bk1' } });
  assert.deepEqual(read[0].lines[0].unknown, ['House sauce']);
  // It strips nothing: guessing unsafe would empty a menu that is correct.
  assert.deepEqual(read[0].lines[0].diets, ['Vegan']);
});

test('a voided line is not on the sheet', async () => {
  const db = fakeDb({
    orders: [{ $id: 'o1', order_no: 'A-1', group_booking_id: 'bk1' }],
    order_items: [
      { $id: 'i1', order_id: 'o1', menu_item_id: 'm1', name_snapshot: 'Kept', qty: 1, line_total: 1, status: 'queued' },
      { $id: 'i2', order_id: 'o1', menu_item_id: 'm1', name_snapshot: 'Voided', qty: 1, line_total: 1, status: 'void' },
    ],
    menu_items: [{ $id: 'm1', tags: [] }],
  });
  const read = await bookingSittings({ db, DB_ID: 'db', Query: Q, booking: { $id: 'bk1' } });
  assert.deepEqual(read[0].lines.map((l: { name: string }) => l.name), ['Kept']);
});

test('a booking whose orders cannot be read produces no sheet rather than an empty one', async () => {
  const db = { listDocuments: async () => { throw new Error('offline'); } };
  const read = await bookingSittings({ db, DB_ID: 'db', Query: Q, booking: { $id: 'bk1' } });
  assert.deepEqual(read, []);
});

/* ------------------------------------------------------------------- drift */

test('the function and the apps agree about what the dietary tags are', () => {
  /*
    functions/notify/src/diet.js is a hand copy of dietary.ts, because a
    deployed function cannot import the workspace. This is the guard: add a
    tag in one place and not the other and it fails here, rather than on a
    plate.
  */
  assert.deepEqual(
    fnDiet.DIETARY_TAGS.map((t: { key: string; label: string }) => [t.key, t.label]),
    DIETARY_TAGS.map((t) => [t.key, t.label]),
  );
  assert.deepEqual(
    fnDiet.DIETARY_TAGS.filter((t: { caution?: boolean }) => t.caution).map((t: { key: string }) => t.key),
    DIETARY_TAGS.filter((t) => t.caution).map((t) => t.key),
  );
});

test('the copied arithmetic answers the same as the original', () => {
  const options = [
    { name: 'Extra cheese', tags: ['vegetarian'] },
    { name: 'Napkin', diet_neutral: true },
    { name: 'Unjudged', tags: [] },
  ];
  assert.deepEqual(
    fnDiet.tagsWithOptions(['vegan', 'vegetarian'], options),
    tagsWithOptions(['vegan', 'vegetarian'], options),
  );

  // The key, the name and what it earns. The function's copy carries no
  // ingredientId: taking something off the shelf is not its job.
  const raw = JSON.stringify([{ key: 'a', name: 'fish', earns: ['vegetarian'] }]);
  const same = (o: { key: string; name: string; earns: string[] }) => [o.key, o.name, o.earns];
  assert.deepEqual(fnDiet.parseOmissions(raw).map(same), parseOmissions(raw).map(same));
  assert.deepEqual(
    fnDiet.tagsWithout(['gluten_free'], fnDiet.parseOmissions(raw), ['a']),
    tagsWithout(['gluten_free'], parseOmissions(raw), ['a']),
  );
});
