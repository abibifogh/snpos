/**
 * The two questions the shift-closing email kept getting wrong, on their own.
 *
 * Pulled out of main.js and given no imports so they can be checked without a
 * database, because both faults were invisible until an owner read the email
 * and said so — one listed the wrong people, the other listed nobody at all.
 */

/**
 * The orders that belong to a shift, and only those.
 *
 * A shift's orders come from two places. Some carry its id, stamped on when
 * the payment was taken. The rest are found by the clock, because a QR order
 * has no shift on it — the phone that placed it has no idea one is open — and
 * scoping the night by id alone would leave out the busiest orders of it.
 *
 * THE CLOCK IS NOT ENOUGH ON ITS OWN. The bar is open during the bistro's
 * hours, so "every order at this venue between these times" is every trade in
 * the building. Closing the bistro listed the bartender under "who did what"
 * with the bar's bills against their name, on a summary headed with the
 * bistro's takings, and nothing on the page said which trade was which.
 *
 * So the clock's answers are filtered to this side, and the stamped ones are
 * kept whatever they say: that stamp is the shift's own record of what it
 * settled, and it outranks a guess from a field. Rows written before `module`
 * existed carry no value for it, and an absent one reads as kitchen, which is
 * what it was.
 */
export function ordersForSide(inWindow, stamped, side) {
  const mine = side || 'kitchen';
  const merged = new Map();
  for (const o of inWindow) {
    if ((o.module || 'kitchen') === mine) merged.set(o.$id, o);
  }
  for (const o of stamped) merged.set(o.$id, o);
  return [...merged.values()];
}

/**
 * What somebody actually saw on the shelves as they closed up.
 *
 * The stock table in the email lists exceptions — what is low, what is out —
 * so a shift where everything was fine printed no stock section at all. On
 * the page that is indistinguishable from the section being broken, and from
 * nobody having been asked to look. Three different things, one silence, and
 * the owner cannot tell them apart.
 *
 * This is the check itself, counted from the rows the close wrote: OK, LOW
 * and OUT as they were tapped. Built from those rows rather than from the
 * ingredients table, so it says what a person reported that night and not
 * what the running figures imply today.
 */
export function shelfCheckSummary(rows, nameById = new Map()) {
  const out = [];
  const low = [];
  let ok = 0;

  for (const r of rows) {
    const state = ['OK', 'LOW', 'OUT'].includes(r.status) ? r.status : 'OK';
    if (state === 'OK') { ok += 1; continue; }
    const name = nameById.get(r.ingredient_id) || 'an item';
    (state === 'OUT' ? out : low).push(name);
  }

  // Alphabetical within each list, so the same shelves read the same way
  // every night rather than in whatever order the rows came back.
  out.sort((a, b) => a.localeCompare(b));
  low.sort((a, b) => a.localeCompare(b));

  return { total: rows.length, ok, low: low.length, out: out.length, lowNames: low, outNames: out };
}
