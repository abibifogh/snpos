/**
 * What to call a place somebody is sitting.
 *
 * One sentence, read by the dropdown a guest picks from and by the ticket a
 * cook reads, so the words on the ticket are the words the guest chose. Two
 * copies of this would be two vocabularies for the same room, and the argument
 * that follows happens at the pass, in front of the customer.
 *
 * Pure. Imports nothing at runtime.
 */

/** Only what naming a place needs. The real row carries a good deal more. */
export interface Seat {
  label: string;
  zone?: string;
  kind?: 'table' | 'area';
}

/**
 * Is this label a table number, or is it the name of somewhere?
 *
 * "7" and "12b" are numbers and read badly alone; a ticket saying just "7" is
 * a ticket that has to be interpreted. "Lounge" and "Notice board area" are
 * names and are ruined by being called Table Lounge.
 *
 * Asked of the label rather than trusted to the `kind` field, because `kind`
 * defaults to 'table' and a place added in a hurry keeps that default. The
 * word the owner typed is the better evidence of what they meant: nobody
 * types "Poolside" intending a table number.
 */
const looksLikeANumber = (label: string): boolean => /^[a-z]?\d+[a-z]?$/i.test(label.trim());

/**
 * The name of a seat, as a guest would say it out loud.
 *
 * "Table 7", "Lounge", "Poolside · Garden". The zone comes after when there is
 * one, because a room can have a Lounge upstairs and a Lounge outside.
 */
export function seatName(seat: Seat): string {
  const label = (seat.label ?? '').trim();
  if (!label) return 'Table order';

  const named =
    seat.kind === 'area' || !looksLikeANumber(label) ? label : `Table ${label}`;
  return seat.zone ? `${named} · ${seat.zone}` : named;
}

/**
 * Where an order is going, from the order alone.
 *
 * Falls back to the plain description when the seating cannot be looked up. A
 * ticket that says "Table order" is thin; a ticket that says nothing because a
 * read failed is worse.
 */
export function seatFor(
  order: { table_id?: string; fulfilment?: string },
  seating: Record<string, Seat>,
): string {
  if (!order.table_id) return order.fulfilment === 'delivery' ? 'Delivery' : 'Takeaway';
  const seat = seating[order.table_id];
  return seat ? seatName(seat) : 'Table order';
}
