/**
 * The catalogue as a printed list.
 *
 * What this is FOR decides its shape. It is not a designed menu for a table —
 * that is a job for somebody with a typeface and a photograph. It is the list
 * a restaurant actually keeps needing and has to rebuild by hand every time:
 * what we sell, what it costs, in the order we think about it. Pinned in the
 * office, handed to an accountant, carried to a supplier, checked against the
 * board on the wall.
 *
 * A4, unlike the voucher. A voucher is one thing somebody carries away; this
 * is a list of everything, read in a folder or on a desk, and a hundred dishes
 * on 80mm of till roll is a scroll.
 *
 * Grouped by category and never re-sorted inside one: the order is whatever
 * the person exporting had already arranged on screen, and that is the one
 * piece of intent this document has to go on.
 *
 * Built on the same primitives as the voucher and the booking sheet — see
 * pdf-doc.js — and Buffer-free, so Admin runs it in the browser.
 */

import { Doc, widthOf } from './pdf-doc.js';

const INK = '#1a2230';
const QUIET = '#66727f';
const LINE = '#dde3ea';

/** Latin-1 is all this document can carry; see pdf-doc.js. */
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * One dish: name on the left, price hard against the right, notes beneath.
 *
 * Measured before anything is drawn so a dish and the things that qualify it
 * are never split across a page break. A description on page two with no dish
 * above it belongs to whatever happens to be at the top of that page.
 */
function dish(doc, item, { money, showPrice }) {
  const name = clean(item.name) || 'Untitled';
  const price = showPrice ? money(item.price) : '';
  const under = [];

  const note = clean(item.description);
  if (note) under.push({ text: note, colour: QUIET, size: 8.5 });

  const tags = (item.tags ?? []).filter(Boolean).join(' · ');
  if (tags) under.push({ text: tags, colour: QUIET, size: 8 });

  /*
    Said on the line rather than left to be inferred from a missing tick.
    An archived dish in a printed list with nothing marking it is a dish
    somebody orders from a supplier for a board it is no longer on.
  */
  if (item.active === false) under.push({ text: 'Archived — not on the menu', colour: '#b4530a', size: 8 });
  if (item.group_only) under.push({ text: 'Group bookings only', colour: QUIET, size: 8 });

  const indent = doc.left + 12;
  const room = doc.right - indent - (price ? widthOf(price, 10, true) + 14 : 0);

  let height = 14;
  for (const u of under) height += doc.wrap(u.text, u.size, false, room).length * (u.size * 1.32);
  doc.need(height + 4);

  if (price) doc.pair(name, price, { size: 10, font: 'bold', valueFont: 'bold' });
  else doc.text(name, { size: 10, font: 'bold' });

  for (const u of under) {
    doc.text(u.text, { size: u.size, colour: u.colour, x: indent, width: room });
  }
  doc.gap(4);
}

/**
 * The bytes of a printed catalogue.
 *
 * @param {object} input
 * @param {Record<string, any>} [input.settings]
 * @param {Record<string, any> | null} [input.venue]
 * @param {{ category: string, items: Record<string, any>[] }[]} input.sections
 * @param {(n: number) => string} input.money
 * @param {string} [input.title] what this list is called
 * @param {string} [input.accent]
 * @param {boolean} [input.prices] false for a list with no money on it
 */
export function menuPdf({
  settings = {}, venue = null, sections, money, title = 'Menu', accent = '#0f766e', prices = true,
}) {
  const doc = new Doc();
  const house = clean(venue?.name) || clean(settings.restaurant_name) || 'Menu';

  /* --------------------------------------------------------------- masthead */
  doc.fill(0, doc.height - 8, doc.width, 8, accent);
  doc.gap(-14);
  doc.text(house, { size: 19, font: 'bold' });
  doc.text(title, { size: 10, colour: QUIET });
  doc.rule({ colour: accent, thickness: 1.4, above: 8, below: 12 });

  const count = sections.reduce((n, s) => n + s.items.length, 0);
  const when = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  doc.text(
    `${count} ${count === 1 ? 'item' : 'items'} · as at ${when}`,
    { size: 9, colour: QUIET, after: 6 },
  );

  for (const section of sections) {
    /*
      The heading and at least one dish together. A category name alone at the
      foot of a page says the list ends there, and whoever is reading stops.
    */
    doc.need(74);
    doc.band(clean(section.category) || 'Everything else', {
      colour: accent, size: 10.5, padding: 6,
      right: `${section.items.length}`,
    });

    if (section.items.length === 0) {
      doc.text('Nothing under this heading.', { size: 9, font: 'italic', colour: QUIET });
      continue;
    }
    for (const item of section.items) dish(doc, item, { money, showPrice: prices });
    doc.rule({ colour: LINE, above: 2, below: 8 });
  }

  const stamp = new Date().toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  return doc.build({
    foot: (page, total) => `${house} · ${title} · printed ${stamp} · page ${page} of ${total}`,
  });
}
