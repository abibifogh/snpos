/**
 * The group booking sheet: one PDF, every sitting, every choice, every tag.
 *
 * A group booking arrives as several orders — one per sitting, because a
 * sitting is what the kitchen cooks and each has its own fire time. The email
 * that announces it can only be a summary: sittings, portions, a total. What
 * the kitchen actually needs is the other thing entirely, and it is long.
 *
 * "Two of the jollof, no momoni, extra plantain, and the note says one of
 * them cannot have nuts" is not a line in a table. It is the shopping list,
 * the prep list and the thing somebody carries to the pass, and until now it
 * existed only inside the ordering app, on a screen the guest closed.
 *
 * So it is written out properly and attached to the email: the booking at the
 * top, then each sitting with its own band, and under each dish the choices
 * made, the things left out, the note in the guest's own words, and what the
 * plate is once all of that is on it. The tags are recomputed here rather
 * than copied from the menu, because a dish listed vegan and ordered with
 * cheese is not a vegan dish and the sheet must not say it is. See diet.js.
 */

import { Doc, widthOf } from './pdf-doc.js';
import { splitDiet, parseOmissions, tagsWithout, tagsWithOptions } from './diet.js';

const INK = '#1a2230';
const QUIET = '#66727f';
const LINE = '#dde3ea';
const WARN = '#b4530a';

const FULFILMENT = {
  dine_in: 'Dine in',
  takeaway: 'Packed to take away',
  delivery: 'Delivery',
};

const SERVICE = {
  plated: 'Served to each guest',
  buffet: 'Buffet, set out to share',
};

const OMIT_GROUP = 'omit';
const OMIT_PREFIX = 'omit-';

/* ------------------------------------------------------------ reading it all */

/**
 * Everything on this booking, in the order it will be cooked.
 *
 * Four reads whatever the size of the party: the orders, all their lines at
 * once, the dishes those lines name, and the options they chose. A booking of
 * twelve sittings must not be twelve round trips inside a function with a
 * timeout on it.
 */
export async function bookingSittings({ db, DB_ID, Query, booking }) {
  const orders = await db.listDocuments(DB_ID, 'orders', [
    Query.equal('group_booking_id', booking.$id),
    Query.limit(100),
  ]).then((r) => r.documents).catch(() => []);

  if (orders.length === 0) return [];

  orders.sort((a, b) => String(a.scheduled_for || a.$createdAt).localeCompare(
    String(b.scheduled_for || b.$createdAt),
  ));

  const items = await db.listDocuments(DB_ID, 'order_items', [
    Query.equal('order_id', orders.map((o) => o.$id)),
    Query.limit(500),
  ]).then((r) => r.documents).catch(() => []);

  const live = items.filter((i) => i.status !== 'void');

  // The dishes, for what they are; and the choices, for what they do to it.
  const dishIds = [...new Set(live.map((i) => i.menu_item_id).filter(Boolean))];
  const optionIds = [...new Set(live.flatMap((i) => readAddons(i)
    .filter((a) => a.group_id !== OMIT_GROUP)
    .map((a) => a.option_id)
    .filter(Boolean)))];

  const [dishes, options] = await Promise.all([
    dishIds.length
      ? db.listDocuments(DB_ID, 'menu_items', [Query.equal('$id', dishIds.slice(0, 100)), Query.limit(100)])
        .then((r) => r.documents).catch(() => [])
      : [],
    optionIds.length
      ? db.listDocuments(DB_ID, 'addon_options', [Query.equal('$id', optionIds.slice(0, 100)), Query.limit(100)])
        .then((r) => r.documents).catch(() => [])
      : [],
  ]);

  const dishById = new Map(dishes.map((d) => [d.$id, d]));
  const optionById = new Map(options.map((o) => [o.$id, o]));

  return orders.map((order) => ({
    order,
    lines: live
      .filter((i) => i.order_id === order.$id)
      .map((i) => describeLine(i, dishById, optionById)),
  }));
}

function readAddons(item) {
  try {
    const parsed = item.addons ? JSON.parse(item.addons) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * One line, read back the way it was ordered.
 *
 * Order matters in the arithmetic: what is left out first, then what was
 * added. Leaving the fish out earns vegetarian; ticking cheese afterwards can
 * take dairy free away again. Doing it the other way round would let an
 * omission reinstate a diet a choice had already cost.
 */
function describeLine(item, dishById, optionById) {
  const dish = dishById.get(item.menu_item_id);
  const addons = readAddons(item);

  const omitted = addons.filter((a) => a.group_id === OMIT_GROUP);
  const chosen = addons.filter((a) => a.group_id !== OMIT_GROUP);

  const base = Array.isArray(dish?.tags) ? dish.tags : [];
  const afterOmissions = tagsWithout(
    base,
    parseOmissions(dish?.omissions),
    omitted.map((a) => String(a.option_id || '').replace(OMIT_PREFIX, '')),
  );

  const { tags, unknown } = tagsWithOptions(
    afterOmissions,
    chosen.map((a) => {
      const doc = optionById.get(a.option_id);
      return {
        name: doc?.name || a.name || 'A choice',
        tags: Array.isArray(doc?.tags) ? doc.tags : [],
        diet_neutral: !!doc?.diet_neutral,
      };
    }),
  );

  const { diets, cautions } = splitDiet(tags);

  return {
    qty: item.qty || 1,
    name: item.name_snapshot || 'Dish',
    variant: item.variant_label || '',
    total: item.line_total || 0,
    choices: chosen.map((a) => (a.qty > 1 ? `${a.name} \u00d7${a.qty}` : a.name)).filter(Boolean),
    // Already worded "No momoni" by the app that wrote them.
    omissions: omitted.map((a) => a.name).filter(Boolean),
    notes: (item.notes || '').trim(),
    diets,
    cautions,
    unknown,
    // A dish taken off the menu since. Its tags cannot be recomputed, and
    // saying nothing would read as "nothing to declare".
    lost: !dish,
  };
}

/* ---------------------------------------------------------------- the sheet */

const clean = (s) => String(s ?? '').trim();

function when(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).replace(',', '');
}

/**
 * The document.
 *
 * `accent` is the venue's own colour, the same one the emails are branded
 * with, so the sheet that comes out of the printer belongs to the place.
 *
 * @param {object} input
 * @param {Record<string, any>} [input.settings]
 * @param {Record<string, any> | null} [input.venue]
 * @param {Record<string, any>} input.booking
 * @param {{ order: Record<string, any>, lines: Record<string, any>[] }[]} input.sittings
 * @param {string} [input.label]
 * @param {string} [input.accent]
 */
export function bookingSheetPdf({
  settings = {}, venue = null, booking, sittings, label = 'Reservation', accent = '#0f766e',
}) {
  const decimals = settings.currency_decimals ?? 2;
  const code = booking.currency_code || settings.currency_code || '';
  const money = (n) => `${code} ${((n || 0) / 10 ** decimals).toFixed(decimals)}`.trim();

  const doc = new Doc();

  /* --------------------------------------------------------------- masthead */
  doc.fill(0, doc.height - 8, doc.width, 8, accent);
  doc.gap(-14);
  doc.text(clean(venue?.name) || clean(settings.restaurant_name) || 'Group booking',
    { size: 19, font: 'bold' });
  doc.text('Group booking sheet — every choice, note and dietary tag', { size: 10, colour: QUIET });
  doc.rule({ colour: accent, thickness: 1.4, above: 8, below: 12 });

  /* ------------------------------------------------------------ the booking */
  const portions = sittings.reduce(
    (n, s) => n + s.lines.reduce((m, l) => m + l.qty, 0), 0,
  );
  const facts = [
    ['Booked by', clean(booking.contact_name) || '-'],
    [label, clean(booking.reference) || '-'],
    ['Email', clean(booking.email) || '-'],
    ['Sittings', `${sittings.length}`],
    ['Plates in all', `${portions}`],
    ['First sitting', when(booking.first_at) || '-'],
    ['Last sitting', when(booking.last_at) || '-'],
    ['Orders', clean(booking.order_nos) || '-'],
    ['Total', money(booking.total)],
  ];
  factTable(doc, facts, { accent });

  /* ------------------------------------------- what the kitchen must know first */
  const notice = kitchenNotice(sittings);
  if (notice.length) {
    doc.gap(6);
    doc.band('What the kitchen must know', { colour: '#7a2e0e' });
    for (const words of notice) {
      doc.text(`•  ${words}`, { size: 10, colour: INK, x: doc.left + 2 });
    }
    doc.gap(4);
  }

  /* ---------------------------------------------------------- every sitting */
  sittings.forEach((sitting, i) => {
    const { order } = sitting;
    const style = order.fulfilment === 'dine_in' && order.group_service
      ? ` · ${SERVICE[order.group_service] ?? order.group_service}`
      : '';
    const plates = sitting.lines.reduce((n, l) => n + l.qty, 0);

    doc.gap(10);
    // A sitting's band must never be the last thing on a page. Room for the
    // band, the line under it and a dish, or it starts the next page: a
    // heading alone at the foot of page one sends somebody looking for a
    // sitting that is printed overleaf.
    doc.need(86);
    doc.band(
      `Sitting ${i + 1} of ${sittings.length}  ·  ${when(order.scheduled_for) || 'Time not set'}`,
      { colour: accent, right: `Order ${clean(order.order_no)}` },
    );
    doc.text(
      `${FULFILMENT[order.fulfilment] ?? 'Dine in'}${style}  ·  ${plates} plate${plates === 1 ? '' : 's'}`,
      { size: 9.5, colour: QUIET },
    );
    doc.gap(4);

    if (sitting.lines.length === 0) {
      doc.text('Nothing on this sitting.', { size: 10, font: 'italic', colour: QUIET });
      return;
    }

    for (const line of sitting.lines) dishBlock(doc, line, money);

    doc.rule({ colour: LINE, above: 6, below: 4 });
    doc.pair('Sitting total', money(order.total), {
      size: 10, font: 'bold', valueFont: 'bold',
    });
  });

  /* ------------------------------------------------------ the whole booking */
  doc.gap(10);
  doc.need(40);
  doc.rule({ colour: accent, thickness: 1.2, above: 2, below: 8 });
  doc.pair('Booking total', money(booking.total), { size: 13, font: 'bold', valueFont: 'bold' });
  doc.gap(4);
  doc.text(
    'Each sitting reaches the kitchen in time to cook it and not before. Nothing is owed until the day.',
    { size: 9, colour: QUIET },
  );

  const stamp = new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  const ref = clean(booking.reference) || clean(booking.contact_name) || booking.$id;
  return doc.build({
    foot: (page, total) => `${ref} · printed ${stamp} · page ${page} of ${total}`,
  });
}

/** The booking's facts, two to a row, on a tinted card. */
function factTable(doc, facts, { accent }) {
  const rowH = 15;
  const rows = Math.ceil(facts.length / 2);
  const height = rows * rowH + 16;
  doc.need(height + 6);
  doc.y -= height;
  doc.fill(doc.left, doc.y, doc.inner, height, '#f4f7f9');
  doc.fill(doc.left, doc.y, 3, height, accent);

  const colW = (doc.inner - 26) / 2;
  facts.forEach((fact, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = doc.left + 14 + col * colW;
    const y = doc.y + height - 8 - (row + 1) * rowH + 4;
    doc.put(fact[0], x, y, { size: 8.5, colour: QUIET });
    const labelW = Math.max(66, widthOf(fact[0], 8.5, false) + 8);
    doc.put(fact[1], x + labelW, y, { size: 9.5, font: 'bold', colour: INK });
  });
  doc.gap(4);
}

/**
 * The things that would ruin the service if nobody read them.
 *
 * Pulled to the front because a sheet of nine sittings buries them otherwise,
 * and a note saying "one of the children cannot have nuts" is not something
 * to find on page three at seven o'clock.
 */
function kitchenNotice(sittings) {
  const out = [];
  const cautions = new Map();
  const unknown = new Set();
  let notes = 0;
  let omissions = 0;

  for (const sitting of sittings) {
    for (const line of sitting.lines) {
      if (line.notes) notes += 1;
      if (line.omissions.length) omissions += 1;
      for (const c of line.cautions) cautions.set(c, (cautions.get(c) ?? 0) + line.qty);
      for (const u of line.unknown) unknown.add(u);
    }
  }

  if (notes) {
    out.push(notes === 1
      ? 'One line carries a special request, in the guest’s own words.'
      : `${notes} lines carry special requests, in the guests’ own words.`);
  }
  if (omissions) {
    out.push(omissions === 1
      ? 'One line is ordered with something left out. The prep list is not the recipe card.'
      : `${omissions} lines are ordered with something left out. The prep list is not the recipe card.`);
  }
  for (const [word, plates] of cautions) {
    out.push(`${word}: ${plates} plate${plates === 1 ? '' : 's'}.`);
  }
  if (unknown.size) {
    out.push(`Not yet recorded as suitable for anything: ${[...unknown].join(', ')}. `
      + 'The tags below cannot account for it.');
  }
  return out;
}

/** One dish, with everything that was said about it underneath. */
function dishBlock(doc, line, money) {
  // Measured first so a dish and its notes are never split across a page
  // break. A choice on page two with no dish above it is a wrong plate.
  const indent = doc.left + 16;
  const detail = doc.right - indent;
  let height = 14;
  const under = [];

  if (line.choices.length) under.push(['With', line.choices.join(', '), INK, 'regular']);
  if (line.omissions.length) under.push(['Leave out', line.omissions.join(', '), WARN, 'bold']);
  if (line.notes) under.push(['They asked', `"${line.notes}"`, INK, 'italic']);
  if (line.diets.length) under.push(['Suitable for', line.diets.join(' · '), '#0d6d5f', 'regular']);
  if (line.cautions.length) under.push(['Warning', line.cautions.join(' · '), WARN, 'bold']);
  if (line.unknown.length) {
    under.push(['Not recorded', `${line.unknown.join(', ')} — ask before promising anything`, QUIET, 'regular']);
  }
  if (!line.diets.length && !line.cautions.length && !line.lost) {
    under.push(['Suitable for', 'Nothing recorded on this dish', QUIET, 'italic']);
  }
  if (line.lost) under.push(['Note', 'This dish is no longer on the menu; its tags cannot be checked', WARN, 'regular']);

  for (const [head, words] of under) {
    height += doc.wrap(`${head}: ${words}`, 9, false, detail - 4).length * 11.9;
  }
  doc.need(height + 4);

  doc.pair(`${line.qty} \u00d7  ${line.name}${line.variant ? ` (${line.variant})` : ''}`,
    money(line.total), { size: 10.5, font: 'bold', valueFont: 'bold' });

  for (const [head, words, colour, font] of under) {
    doc.text(`${head}: ${words}`, { size: 9, colour, font, x: indent, width: detail });
  }
  doc.gap(5);
}
