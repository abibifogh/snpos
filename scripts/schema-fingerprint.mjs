import { createHash } from 'node:crypto';

/**
 * One short string that changes whenever the database's shape does.
 *
 * Provisioning writes it onto the settings row when it finishes, and every
 * app is built knowing the value its code expects (packages/core/src/
 * schema-version.ts, generated from the same schema). When the two differ,
 * the database is behind the apps, and the apps say so in plain words
 * instead of failing on the first save with "unknown attribute".
 *
 * Worked out from the schema rather than bumped by hand, because a version
 * number somebody has to remember to change is exactly the forgotten button
 * this exists to remove. Everything provisioning applies is included: the
 * collections and their columns, enum values and indexes, the permissions,
 * the teams, the buckets, the feature switches and the accounts the code
 * posts to. A change to any of them needs a provision run, and a change to
 * none of them does not.
 */
export function schemaFingerprint({ COLLECTIONS, FEATURES, SYSTEM_ACCOUNT_CODES, TEAMS, BUCKETS }) {
  const shape = {
    collections: COLLECTIONS.map((c) => ({
      id: c.id,
      perms: c.perms,
      attributes: c.attributes.map((a) => a.slice(0, 5)),
      indexes: c.indexes ?? [],
    })),
    features: FEATURES.map((f) => f.key),
    accounts: [...SYSTEM_ACCOUNT_CODES],
    teams: TEAMS.map((t) => t.id),
    buckets: BUCKETS.map((b) => b.id),
  };
  return createHash('sha1').update(JSON.stringify(shape)).digest('hex').slice(0, 12);
}
