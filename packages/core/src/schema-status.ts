/**
 * Is the database the shape this build of the apps expects?
 *
 * Every column the apps write has to exist before they can write it, and
 * the only thing that creates columns is a provision run. Until now the
 * first sign that one had been forgotten was a save refused with "unknown
 * attribute", on a till, at night. Provisioning now stamps the settings row
 * with the fingerprint of what it applied, and each app compares that to
 * the fingerprint it was built with.
 *
 * Pure. Imports nothing at runtime.
 */

export type SchemaState = 'current' | 'behind' | 'unknown';

/**
 * Where the database stands.
 *
 *   current  the row carries this build's fingerprint
 *   behind   it carries another, or none: a provision run has not happened
 *            since the schema changed (or ever, on a database provisioned
 *            before the stamp existed, which needs one run to say so)
 *   unknown  the settings row could not be read at all
 */
export function schemaState(
  settings: { schema_version?: string | null } | null | undefined,
  expected: string,
): SchemaState {
  if (!settings) return 'unknown';
  return (settings.schema_version ?? '') === expected ? 'current' : 'behind';
}

/**
 * What to say, and to whom.
 *
 * Staff cannot fix this and should not be sent to look for a button; the
 * words tell them the app still works and that the owner has been told what
 * to do. The owner's words name the actual step.
 */
export function schemaWords(state: SchemaState, opts: { owner: boolean }): string | null {
  if (state !== 'behind') return null;
  return opts.owner
    ? 'The database is behind this version of the apps. Merging to main runs Provision on its own; '
      + 'if this stays after a deploy, run Actions, Provision Appwrite by hand. Until then some new things will not save.'
    : 'The database is behind this version of the app. It still works; anything new that will not save '
      + 'is waiting on the owner to update it.';
}
