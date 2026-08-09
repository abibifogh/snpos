import { db, DB_ID, Query, Permission, Role, teams } from './client';
import type { Doc } from './types';

/**
 * Which hotel is this?
 *
 * One database holds every hotel using the system, so every read has to be
 * answerable to "whose rows are these?" — and 117 query sites is 117 chances to
 * forget. So nothing here relies on remembering. The context is set once at
 * start-up and every query goes through one place that applies it.
 *
 * There are two lines of defence and they are deliberately independent:
 *
 *   1. `org_id` on every row, filtered into every query by `scopedQueries`.
 *      This is what makes reads fast and the data checkable.
 *
 *   2. Appwrite document permissions. Every row is written readable only by its
 *      own organisation's team. A query that somehow escapes the first defence
 *      returns nothing rather than another hotel's takings, because the server
 *      refuses to hand the documents over at all.
 *
 * The second is the one that matters. The first can be defeated by a bug; the
 * second cannot be defeated from a browser.
 */

export interface Organisation extends Doc {
  name: string;
  slug: string;
  team_id: string;
  status: 'trial' | 'active' | 'overdue' | 'suspended' | 'closed';
  plan?: string;
  trial_ends_at?: string;
  owner_email: string;
  owner_name?: string;
  tools?: string[];
  suspended_reason?: string;
}

/**
 * Collections that belong to nobody in particular.
 *
 * `organisations` has to be readable before anybody knows which organisation
 * they are in — that is the lookup itself. `org_requests` is written by
 * strangers on the public website who have no organisation at all.
 */
const UNSCOPED = new Set(['organisations', 'org_requests']);

type Context =
  /** Before multi-hotel: one restaurant, no filtering, exactly as it was. */
  | { mode: 'single' }
  /** One hotel among many. */
  | { mode: 'org'; id: string; teamId: string };

let context: Context | null = null;

/**
 * Declare which hotel this app is working for.
 *
 * Called once during start-up, before any data is read. Until it is called,
 * every scoped query throws — which is the point. The dangerous state is not
 * "no organisation set", it is "no organisation set and everything returned
 * anyway", and refusing outright is the only way that state cannot exist.
 */
export function configureOrg(next: Context): void {
  context = next;
}

/** The organisation in force, or null while this is still one restaurant. */
export function currentOrg(): { id: string; teamId: string } | null {
  if (!context) {
    throw new Error(
      'The app tried to read data before saying which hotel it is working for. ' +
        'This is a bug — configureOrg() must be called during start-up.',
    );
  }
  return context.mode === 'org' ? { id: context.id, teamId: context.teamId } : null;
}

/** Whether the caller may skip scoping for this collection. */
export const isUnscoped = (collectionId: string) => UNSCOPED.has(collectionId);

/**
 * The queries a read should actually run with.
 *
 * Prepended rather than appended so the org filter is the first condition
 * Appwrite sees, which is also the order the indexes are built in.
 */
export function scopedQueries(collectionId: string, queries: string[] = []): string[] {
  const org = currentOrg();
  if (!org || isUnscoped(collectionId)) return queries;
  return [Query.equal('org_id', org.id), ...queries];
}

/**
 * What a new document should carry, and who may read it.
 *
 * The permissions are the real work. A document created without them is
 * readable by whatever the collection allows, which across a shared database
 * means every hotel — so this is never optional and never inlined at a call
 * site where somebody can leave it out.
 */
export function scopedPayload(
  collectionId: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const org = currentOrg();
  if (!org || isUnscoped(collectionId)) return payload;
  return { ...payload, org_id: org.id };
}

export function scopedPermissions(collectionId: string, extra: string[] = []): string[] | undefined {
  const org = currentOrg();
  if (!org || isUnscoped(collectionId)) return extra.length ? extra : undefined;
  const team = Role.team(org.teamId);
  return [
    Permission.read(team),
    Permission.update(team),
    Permission.delete(team),
    // Anything the caller adds on top — a guest granted read on their own
    // order, for instance. Never instead of the team's, always as well as.
    ...extra,
  ];
}

/**
 * Find the organisation a signed-in person belongs to.
 *
 * Read from their team membership rather than from anything they could type.
 * A person is in exactly one hotel's team; the staff teams (cooks, waiters and
 * so on) say what they may do, and this says whose data they may do it to.
 */
export async function organisationForSession(): Promise<Organisation | null> {
  const mine = await teams.list().catch(() => null);
  if (!mine) return null;

  const ids = mine.teams.map((t) => t.$id);
  if (ids.length === 0) return null;

  // The organisation teams are the ones this lookup knows about; the staff
  // teams simply will not match.
  const found = await db
    .listDocuments(DB_ID, 'organisations', [Query.equal('team_id', ids), Query.limit(1)])
    .catch(() => null);

  return (found?.documents[0] as unknown as Organisation) ?? null;
}

/**
 * Whether this hotel may still be used, and what to say if not.
 *
 * Deliberately generous. A trial that ran out yesterday and a card that failed
 * this morning both leave a restaurant mid-service, and locking the till over
 * a payment problem loses somebody their evening's takings. Only an explicit
 * suspension actually stops the system, and even then the message says who to
 * talk to rather than just refusing.
 */
export function organisationBlock(org: Organisation | null): string | null {
  if (!org) return null;
  if (org.status === 'closed') {
    return 'This account has been closed. Please get in touch if that is not right.';
  }
  if (org.status === 'suspended') {
    return org.suspended_reason || 'This account is on hold. Please get in touch to put it back.';
  }
  return null;
}

/** Days left on a trial, or null when there is no clock running. */
export function trialDaysLeft(org: Organisation | null): number | null {
  if (!org?.trial_ends_at || org.status !== 'trial') return null;
  const ms = new Date(org.trial_ends_at).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 86_400_000));
}
