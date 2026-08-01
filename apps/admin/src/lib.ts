export { account, db, storage, teams, client, DB_ID, ID, Query, Permission, Role, listAll } from '@snpos/core';
export { applyTheme } from '@snpos/ui';

import { applyTheme } from '@snpos/ui';
import type { Settings } from '@snpos/core';

export const applyThemeSettings = (s: Settings) =>
  applyTheme({ primary_color: s.primary_color, secondary_color: s.secondary_color, accent_color: s.accent_color });

/**
 * Turn an Appwrite failure into something a person can act on.
 *
 * The raw messages are written for developers; a manager seeing
 * "Invalid document structure" needs to know which field and why.
 */
export function humanError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/Invalid credentials/i.test(msg)) return 'That email and password combination was not recognised.';
  if (/User .*not found/i.test(msg)) return 'No account exists for that email address.';
  if (/missing scopes|not authorized|unauthorized/i.test(msg)) return 'Your account does not have permission to do that.';
  if (/Document with the requested ID could not be found/i.test(msg)) return 'That record no longer exists — it may have been deleted.';
  if (/already exists/i.test(msg)) return 'Something with that name or code already exists.';
  if (/Network|fetch failed|Failed to fetch/i.test(msg)) return 'Could not reach the server. Check your connection and try again.';
  if (/Rate limit/i.test(msg)) return 'Too many attempts. Wait a minute and try again.';
  return msg;
}
