/**
 * A discount voucher, as something you would hand to a customer.
 *
 * The Vouchers page describes an offer to somebody who already knows what the
 * fields mean. What a restaurant actually needs to DO with an offer is put it
 * in front of people: printed and left on the counter, slipped into a takeaway
 * bag, attached to an email. None of that was possible — the offer existed
 * only as a row on an admin screen, and the only way to tell a customer about
 * it was to say the code out loud.
 *
 * ONE PER PAGE, and a sheet when several are asked for, so a page is a thing
 * you can print and hand over rather than a list to be cut up.
 *
 * WHY IT LOOKS LIKE THIS. The headline is the largest thing on the page
 * because a voucher on a counter has to be readable by somebody walking past.
 * The code is in a panel of its own because it is the one part a customer has
 * to copy, and it is set wide and bold so it survives a phone photograph. And
 * the conditions are printed rather than left in a policy: a minimum spend or
 * a Tuesdays-only rule that the holder finds out about at the till, with a
 * queue behind them, is a complaint the paper could have prevented.
 *
 * Built on the same primitives as the booking sheet — see pdf-doc.js — and
 * Buffer-free for the same reason: Admin runs this in the browser, and a
 * voucher attached to an email later would run the very same builder rather
 * than a second one that drifts.
 */

import { Doc, widthOf } from './pdf-doc.js';

const INK = '#1a2230';
const QUIET = '#66727f';
const LINE = '#dde3ea';
const PANEL = '#f4f6f8';

/** Latin-1 is all this document can carry; see pdf-doc.js. */
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** One line, centred on the page. The whole design hangs off this. */
function centre(doc, text, y, { size = 10, font = 'regular', colour = INK } = {}) {
  const words = clean(text);
  if (!words) return;
  doc.put(words, (doc.width - widthOf(words, size, font === 'bold')) / 2, y, { size, font, colour });
}

/**
 * A headline shrunk until it fits.
 *
 * "FREE DELIVERY" is nearly twice the width of "20% OFF" at the same size, and
 * a fixed size would either clip the long one or waste the short one. The
 * biggest size that fits the card is chosen instead, so every voucher fills
 * its own width and none of them overruns.
 */
function headlineSize(text, room, start = 46, floor = 20) {
  let size = start;
  while (size > floor && widthOf(clean(text), size, true) > room) size -= 1;
  return size;
}

/**
 * One voucher, drawn as a card, with everything it needs inside its own edge.
 *
 * SELF-CONTAINED ON PURPOSE. The card has a border, which makes it read as
 * something to cut out and carry — so anything left outside that border is
 * something a customer loses the moment they do. The small print went below
 * it at first, which meant the conditions this whole file argues for reaching
 * the holder were the first thing thrown away.
 *
 * Its height is measured from its own contents rather than fixed, because the
 * conditions are what vary: a voucher with a minimum spend, days, hours, a cap
 * and a usage limit carries twice the lines of a plain one. A fixed card either
 * overflows the long one or leaves the short one half empty.
 */
function card(doc, v, {
  headline, code, hasCode, validity, venueName, accent, terms, foot,
}) {
  const pad = 26;
  const left = doc.left;
  const width = doc.inner;
  const room = width - pad * 2;
  const bandH = 54;

  const hSize = headlineSize(headline, room);
  const noteLines = clean(v.description) ? doc.wrap(clean(v.description), 9.5, false, room - 30).slice(0, 2) : [];
  const termLines = terms.flatMap((t) => doc.wrap(`\u00b7  ${t}`, 8.5, false, room - 6));

  // Measured, then drawn. Every gap below is counted here in the same order.
  const height = bandH + 24 + hSize + 26 + 6 + noteLines.length * 13
    + 22 + 54 + 16 + 14 + 18 + termLines.length * 11.5 + (foot ? 20 : 6) + 14;

  /*
    Centred down the page rather than pinned to the top.

    A card at the top of a sheet with half a page of nothing under it reads as
    a document that ran out; centred, it reads as the thing the page is for.
    It also puts the fold of a sheet folded in half clear of the card.
  */
  const bottom = Math.max(doc.margin + 30, (doc.height - height) / 2);
  const top = bottom + height;

  /*
    The border is a filled rectangle with a smaller one on top of it. There is
    no stroke in this toolkit and a voucher wants an edge, which is the one
    thing that makes it read as something to be cut out and carried.
  */
  doc.fill(left, bottom, width, height, accent);
  doc.fill(left + 1.2, bottom + 1.2, width - 2.4, height - 2.4, '#ffffff');

  // The masthead, in the house colour, with the business's name on it.
  doc.fill(left + 1.2, top - bandH, width - 2.4, bandH - 1.2, accent);
  doc.put(clean(venueName) || 'Voucher', left + pad, top - 34, { size: 15, font: 'bold', colour: '#ffffff' });
  const tag = 'DISCOUNT VOUCHER';
  doc.put(tag, doc.right - pad - widthOf(tag, 9, true), top - 32, { size: 9, font: 'bold', colour: '#ffffff' });

  let cy = top - bandH - 24;

  // What it is worth, as large as the card allows.
  cy -= hSize * 0.74;
  centre(doc, headline, cy, { size: hSize, font: 'bold', colour: accent });
  cy -= 26;

  // What the offer is called, under the figure. The gap is measured from the
  // BASELINE, so it has to clear the descender of a headline set at 46pt.
  centre(doc, v.name, cy, { size: 13, font: 'bold', colour: INK });
  cy -= 6;

  for (const line of noteLines) {
    cy -= 13;
    centre(doc, line, cy, { size: 9.5, colour: QUIET });
  }

  /*
    The code, in a panel of its own.

    The one thing on the page a customer has to reproduce exactly, so it is
    given the most contrast on the card and set wide enough to read off a
    photograph. A voucher with no code says what to do instead, rather than
    showing an empty box to hunt in.
  */
  cy -= 22 + 54;
  doc.fill(left + pad, cy, room, 54, PANEL);
  centre(doc, hasCode ? 'USE THIS CODE' : 'HOW TO USE IT', cy + 37, { size: 8, font: 'bold', colour: QUIET });
  centre(doc, code, cy + 14, {
    size: hasCode ? headlineSize(code, room - 40, 26, 12) : 13, font: 'bold', colour: INK,
  });

  // When it runs.
  cy -= 16;
  centre(doc, validity, cy, { size: 10.5, font: 'bold', colour: INK });

  // And the conditions, inside the edge, where they survive the scissors.
  cy -= 14;
  doc.fill(left + pad, cy, room, 0.7, LINE);
  cy -= 18;
  centre(doc, 'THE SMALL PRINT', cy, { size: 7.5, font: 'bold', colour: QUIET });
  for (const line of termLines) {
    cy -= 11.5;
    doc.put(line, left + pad + 3, cy, { size: 8.5, colour: QUIET });
  }

  if (foot) {
    cy -= 20;
    centre(doc, foot, cy, { size: 8.5, colour: QUIET });
  }

  // Nothing flows under it; the card is the page.
  doc.y = bottom - 20;
  return doc;
}

/**
 * The bytes of a voucher sheet: one page per voucher.
 *
 * @param {object} input
 * @param {Record<string, any>} [input.settings]
 * @param {Record<string, any> | null} [input.venue]
 * @param {Record<string, any>[]} input.vouchers
 * @param {(v: any) => string} input.headline what it is worth, in words
 * @param {(v: any) => string} input.validity when it runs
 * @param {(v: any) => string[]} input.terms the conditions, one per line
 * @param {(v: any) => string} input.codeWords the code, or what to do instead
 * @param {(v: any) => boolean} input.hasCode whether that is a real code
 * @param {string} [input.accent]
 */
export function voucherPdf({
  settings = {}, venue = null, vouchers, accent = '#0f766e',
  headline, validity, terms, codeWords, hasCode,
}) {
  const doc = new Doc();
  const venueName = clean(venue?.name) || clean(settings.restaurant_name) || 'Voucher';

  vouchers.forEach((v, i) => {
    if (i > 0) doc.newPage();

    card(doc, v, {
      headline: headline(v),
      code: codeWords(v),
      hasCode: hasCode(v),
      validity: validity(v),
      terms: terms(v),
      venueName,
      accent,
      // Once, on the card. It was printed here AND under it, which on a thing
      // meant to be cut out is the same address twice and then none at all.
      foot: [clean(settings.address), clean(settings.phone)].filter(Boolean).join(' \u00b7 '),
    });

  });

  const stamp = new Date().toLocaleString('en-GB', { dateStyle: 'medium' });
  return doc.build({
    foot: (page, total) => (total > 1
      ? `${venueName} · printed ${stamp} · voucher ${page} of ${total}`
      : `${venueName} · printed ${stamp}`),
  });
}
