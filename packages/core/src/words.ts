/**
 * What to call things, on a screen that serves three trades.
 *
 * A shop counter told somebody that "2 dishes are off the menu" and that "the
 * kitchen screen will not show them", about a luggage strap, in a building
 * whose kitchen has nothing to do with it. The email said "Off the menu:
 * Luggage strap".
 *
 * Wording like that is not cosmetic. Somebody reading it reasonably concludes
 * the system has done something to the wrong record, and the honest ones stop
 * trusting the next message too — including the one that matters.
 *
 * One list, so a fourth message cannot be written in the kitchen's words by
 * somebody who only ever sees the kitchen.
 *
 * Pure. Imports nothing at runtime.
 */

export interface Words {
  /** "dish", "drink", "piece". */
  one: string;
  many: string;
  /** What the catalogue screen is called. */
  title: string;
  /** Where it goes when it runs out: "off the menu", "off the shelf". */
  off: string;
  /** What a customer can no longer do, and what stops showing it. */
  consequence: string;
  /** The heading on the alert email. */
  ranOut: string;
}

const KITCHEN: Words = {
  one: 'dish',
  many: 'dishes',
  title: 'Dishes & drinks',
  off: 'off the menu',
  consequence: 'Customers cannot order them and the kitchen screen will not show them.',
  ranOut: 'A dish has run out',
};

const BAR: Words = {
  one: 'drink',
  many: 'drinks',
  title: 'Drinks & cocktails',
  off: 'off the menu',
  // A bar has no kitchen screen. Saying it does sends a bartender looking for
  // one, and teaches them the message was not written about them.
  consequence: 'Customers cannot order them and they will not show at the bar.',
  ranOut: 'A drink has run out',
};

const CRAFT: Words = {
  one: 'piece',
  many: 'pieces',
  title: 'Products',
  // Nothing in a shop is on a menu, and a piece that has sold is not "run
  // out" — there was only ever the one.
  off: 'off the shelf',
  consequence: 'Customers cannot buy them and they will not show at the counter.',
  ranOut: 'A piece has sold out',
};

export function tradeWords(module: string | undefined): Words {
  if (module === 'craft') return CRAFT;
  if (module === 'bar') return BAR;
  return KITCHEN;
}

/** "2 dishes are off the menu.", "1 piece is off the shelf." */
export function offCountLine(count: number, module: string | undefined): string {
  const w = tradeWords(module);
  const noun = count === 1 ? `${w.one} is` : `${w.many} are`;
  return `${count} ${noun} ${w.off}.`;
}

/** The subject of the alert email: "Off the shelf: Luggage strap". */
export function offSubject(name: string, module: string | undefined): string {
  const w = tradeWords(module);
  // Capitalised because it opens a subject line, not a sentence.
  return `${w.off.charAt(0).toUpperCase()}${w.off.slice(1)}: ${name}`;
}
