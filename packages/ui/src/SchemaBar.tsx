import { schemaState, schemaWords, SCHEMA_VERSION } from '@snpos/core';

/**
 * Says, plainly, when the database is behind the app.
 *
 * The apps are published on every merge and the database is provisioned on
 * the same merge, so this should never show for long. When it does — the
 * provision step failed, or somebody deployed by hand and forgot the other
 * button — the first sign used to be a save refused on a till at night with
 * "unknown attribute". This is the sign instead, and it says who can fix it.
 *
 * Nothing for a database that is current, and nothing while the settings
 * have not loaded: a bar that flashes on every cold start teaches people to
 * ignore it.
 */
export function SchemaBar({
  settings,
  owner = false,
}: {
  settings: { schema_version?: string | null } | null | undefined;
  /** Whether this person can run the fix themselves. */
  owner?: boolean;
}) {
  const words = schemaWords(schemaState(settings, SCHEMA_VERSION), { owner });
  if (!words) return null;
  return (
    <div className="offline-bar schema-bar" role="status" aria-live="polite">
      <span className="dot" aria-hidden="true" />
      <span><strong>Database update needed.</strong> {words}</span>
    </div>
  );
}
