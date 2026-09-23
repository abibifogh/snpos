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
 * RECEIPT WIDTH, because that is what a restaurant has a printer for. It was
 * A4 at first, which is a sheet of paper somebody has to find a printer for,
 * cut down, and then explain. 80mm comes off the roll already sitting on the
 * counter, and the page is as tall as the voucher needs and no taller, so it
 * tears off as one slip. It reads better on a phone for the same reason: a
 * narrow page is a page that does not need pinching about.
 *
 * ONE PER PAGE, and several pages when several are asked for, so a page is a
 * thing you hand over rather than a list to be cut up.
 *
 * WHY IT LOOKS LIKE THIS. The headline is the largest thing on the slip
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

/* ------------------------------------------------------------ the paper */

/**
 * 80mm, the roll nearly every counter printer takes, in points.
 *
 * The page is that wide and as tall as the voucher turns out to be — there is
 * no fixed height to design into, because a roll has none either.
 */
const ROLL_WIDTH = 226.77;
const ROLL_MARGIN = 9;

/** Every measurement on the slip, named once so measuring and drawing agree. */
const L = {
  band: 44,
  pad: 12,
  afterBand: 16,
  afterHeadline: 16,
  afterName: 4,
  noteLine: 11,
  beforeCode: 14,
  code: 42,
  afterCode: 15,
  afterValidity: 11,
  beforeTerms: 13,
  termLine: 9.5,
  beforeFoot: 12,
  footLine: 9,
  tail: 12,
};

/**
 * Everything the slip will say, wrapped once.
 *
 * Wrapping is the expensive part and the part that must not differ between
 * measuring and drawing, so it happens here and both passes read these same
 * arrays. How TALL it comes to is not worked out here at all — see below.
 */
function plan(scratch, v, { headline, code, hasCode, validity, terms, foot }) {
  const room = ROLL_WIDTH - ROLL_MARGIN * 2 - L.pad * 2;
  return {
    v,
    headline,
    hSize: headlineSize(headline, room, 28, 11),
    code,
    hasCode,
    validity,
    room,
    note: clean(v.description) ? scratch.wrap(clean(v.description), 8, false, room).slice(0, 3) : [],
    nameLines: scratch.wrap(clean(v.name), 10.5, true, room),
    termLines: terms.flatMap((t) => scratch.wrap(`\u00b7 ${t}`, 7, false, room - 4)),
    footLines: foot ? scratch.wrap(foot, 7, false, room) : [],
  };
}

/**
 * The words of one slip, down the page from `top`. Returns where it ended.
 *
 * MEASURING IS DRAWING. The height of the slip has to be known before the page
 * is made, and the obvious way — adding the gaps up in a list beside the code
 * that consumes them — is two things that must agree and will not. It already
 * did not: the first version budgeted a full headline where it consumed
 * three-quarters of one, and left a thumb of blank card under every voucher.
 *
 * So this runs twice. Once onto a scratch page nobody keeps, purely to learn
 * where it stops; then again, for real, on a page cut to that answer. The
 * wrapped lines come from `plan` so the two passes cannot lay out differently,
 * and there is no second list of constants to drift.
 */
function contents(doc, p, { top, accent }) {
  const inset = doc.left + L.pad;
  let cy = top - L.band - L.afterBand;

  // What it is worth, as large as the slip allows.
  cy -= p.hSize * 0.74;
  centre(doc, p.headline, cy, { size: p.hSize, font: 'bold', colour: accent });
  cy -= L.afterHeadline;

  for (const line of p.nameLines) {
    cy -= 13;
    centre(doc, line, cy, { size: 10.5, font: 'bold', colour: INK });
  }
  cy -= L.afterName;

  for (const line of p.note) {
    cy -= L.noteLine;
    centre(doc, line, cy, { size: 8, colour: QUIET });
  }

  /*
    The code, in a panel of its own.

    The one thing on the slip a customer has to reproduce exactly, so it is
    given the most contrast and set as wide as it will go — wide enough to read
    off a phone photograph. A voucher with no code says what to do instead,
    rather than showing an empty box to hunt in.
  */
  cy -= L.beforeCode + L.code;
  doc.fill(inset, cy, p.room, L.code, PANEL);
  centre(doc, p.hasCode ? 'USE THIS CODE' : 'HOW TO USE IT', cy + 29, { size: 6.5, font: 'bold', colour: QUIET });
  centre(doc, p.code, cy + 10, {
    size: p.hasCode ? headlineSize(p.code, p.room - 12, 18, 8) : 9.5, font: 'bold', colour: INK,
  });

  // When it runs.
  cy -= L.afterCode;
  centre(doc, p.validity, cy, { size: 9, font: 'bold', colour: INK });

  // And the conditions, inside the edge, where they survive the scissors.
  cy -= L.afterValidity;
  doc.fill(inset, cy, p.room, 0.6, LINE);
  cy -= L.beforeTerms;
  centre(doc, 'THE SMALL PRINT', cy, { size: 6.5, font: 'bold', colour: QUIET });
  for (const line of p.termLines) {
    cy -= L.termLine;
    doc.put(line, inset + 2, cy, { size: 7, colour: QUIET });
  }

  if (p.footLines.length) {
    cy -= L.beforeFoot;
    for (const line of p.footLines) {
      centre(doc, line, cy, { size: 7, colour: QUIET });
      cy -= L.footLine;
    }
  }
  return cy;
}

/**
 * One voucher, drawn as a slip, with everything it needs inside its own edge.
 *
 * SELF-CONTAINED ON PURPOSE. The slip has a border, which makes it read as
 * something to tear off and carry — so anything left outside that border is
 * something a customer loses the moment they do. The small print went below it
 * at first, which meant the conditions this whole file argues for reaching the
 * holder were the first thing thrown away.
 */
function draw(doc, p, { venueName, accent }) {
  const left = doc.left;
  const width = doc.inner;
  const top = doc.height - ROLL_MARGIN;
  const height = doc.height - ROLL_MARGIN * 2;
  const bottom = top - height;

  /*
    The border is a filled rectangle with a smaller one on top of it. There is
    no stroke in this toolkit and a voucher wants an edge, which is the one
    thing that makes it read as something to be torn off and carried.
  */
  doc.fill(left, bottom, width, height, accent);
  doc.fill(left + 1, bottom + 1, width - 2, height - 2, '#ffffff');

  /*
    The masthead. Stacked rather than set left and right against each other,
    because at 80mm there is no room to put two things on one line and a name
    of any length would run into the label.
  */
  doc.fill(left + 1, top - L.band, width - 2, L.band - 1, accent);
  centre(doc, venueName, top - 20, { size: 11.5, font: 'bold', colour: '#ffffff' });
  centre(doc, 'DISCOUNT VOUCHER', top - 33, { size: 6.5, font: 'bold', colour: '#ffffff' });

  contents(doc, p, { top, accent });
  return doc;
}

/**
 * The bytes of a voucher, or of several, one slip per page.
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
  const venueName = clean(venue?.name) || clean(settings.restaurant_name) || 'Voucher';
  // Once, on the slip. It was printed there AND under it, which on a thing
  // meant to be torn off is the same address twice and then none at all.
  const foot = [clean(settings.address), clean(settings.phone)].filter(Boolean).join(' \u00b7 ');

  /*
    Measured on a scratch page first, because a page has to be given its height
    when it is made and a voucher's height is whatever its conditions come to.
    Wrapping does not care how tall the page is, so a tall stand-in serves.
  */
  const scratch = new Doc({ width: ROLL_WIDTH, height: 4000, margin: ROLL_MARGIN });
  const plans = vouchers.map((v) => plan(scratch, v, {
    headline: headline(v),
    code: codeWords(v),
    hasCode: hasCode(v),
    validity: validity(v),
    terms: terms(v),
    foot,
  }));

  /*
    One height for every page, because a document carries one page size.
    The tallest wins: a roll printer feeds a little extra paper on the shorter
    slips, which costs a few millimetres, where cropping the tallest would cost
    somebody their conditions.
  */
  const measured = plans.map((p) => {
    const sheet = new Doc({ width: ROLL_WIDTH, height: 4000, margin: ROLL_MARGIN });
    const from = sheet.height - ROLL_MARGIN;
    return from - contents(sheet, p, { top: from, accent }) + L.tail;
  });
  const tallest = Math.max(...measured);
  const doc = new Doc({ width: ROLL_WIDTH, height: tallest + ROLL_MARGIN * 2, margin: ROLL_MARGIN });

  plans.forEach((p, i) => {
    if (i > 0) doc.newPage();
    draw(doc, p, { venueName, accent });
  });

  // No page footer: at this width there is no room under the slip for one, and
  // a voucher's own dates are what a holder actually needs.
  return doc.build();
}
