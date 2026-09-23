import { db, DB_ID, ID, Query, listAll } from './client';
import type { Doc } from './types';
import { looksLikeEmail } from './voucher-words';
import type { VoucherSendState } from './voucher-words';

/**
 * Asking for a voucher to be emailed to somebody.
 *
 * A REQUEST, not a send. The browser cannot post mail — the settings and the
 * provider live on the server — so this writes a row and the background job
 * builds the voucher and sends it, the same route a sign-in link and a booking
 * notice take.
 *
 * ONE ROW PER ADDRESS. A message addressed to several people is all-or-nothing
 * at the provider: one address it dislikes loses it for everybody on the line,
 * and the log records one failure rather than naming who was not told. That
 * fault has already cost this system a group booking's notice once. Per
 * address is also the only way a screen can say which ones arrived.
 */
export interface VoucherSendDoc extends Doc {
  venue_id: string;
  discount_id: string;
  to_email: string;
  to_name?: string;
  voucher_name?: string;
  status: VoucherSendState;
  last_error?: string;
  requested_by?: string;
  sent_at?: string;
}

export async function sendVoucherTo(input: {
  venueId: string;
  voucherId: string;
  voucherName: string;
  /** One address per call; the caller loops. See the note above. */
  email: string;
  name?: string;
  by: string;
}): Promise<void> {
  const to = input.email.trim().toLowerCase();
  if (!looksLikeEmail(to)) throw new Error(`${input.email} does not look like an email address.`);

  await db.createDocument(DB_ID, 'voucher_sends', ID.unique(), {
    venue_id: input.venueId,
    discount_id: input.voucherId,
    to_email: to,
    to_name: (input.name ?? '').trim().slice(0, 160),
    // Copied so a list reads without fetching the voucher for every row, and
    // so the record still says what was sent after the offer is renamed.
    voucher_name: input.voucherName.slice(0, 120),
    status: 'queued',
    requested_by: input.by,
  });
}

/** Where every send of one voucher got to, newest first. */
export async function voucherSendsFor(voucherId: string): Promise<VoucherSendDoc[]> {
  const rows = await listAll<VoucherSendDoc>('voucher_sends', [
    Query.equal('discount_id', voucherId),
  ]).catch(() => [] as VoucherSendDoc[]);
  return rows.sort((a, b) => (b.$createdAt ?? '').localeCompare(a.$createdAt ?? ''));
}
