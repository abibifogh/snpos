/**
 * What a plate is, worked out on the server.
 *
 * A deliberate copy. The apps decide this in packages/core/src/dietary.ts, and
 * that is the source of truth — but a deployed function is its own little
 * program with its own node_modules and cannot import the workspace. The
 * alternative was a booking sheet with no dietary tags on it, which for a
 * party of forty is the one thing the sheet is for.
 *
 * The tag list is guarded: packages/core/src/__tests__/booking-sheet.test.ts
 * fails if this list and DIETARY_TAGS drift apart, so adding "gluten free" in
 * one place and not the other is caught here rather than on a plate.
 *
 * Pure. Imports nothing.
 */

export const DIETARY_TAGS = [
  { key: 'vegetarian', label: 'Vegetarian' },
  { key: 'vegan', label: 'Vegan' },
  { key: 'pescatarian', label: 'Pescatarian' },
  { key: 'halal', label: 'Halal' },
  { key: 'gluten_free', label: 'Gluten free' },
  { key: 'dairy_free', label: 'Dairy free' },
  { key: 'nut_free', label: 'Nut free' },
  { key: 'contains_nuts', label: 'Contains nuts', caution: true },
  { key: 'contains_shellfish', label: 'Contains shellfish', caution: true },
  { key: 'spicy', label: 'Spicy', caution: true },
];

const byKey = new Map(DIETARY_TAGS.map((t) => [t.key, t]));
const isCaution = (key) => !!byKey.get(key)?.caution;

/** The words, in the list's order, keeping anything written elsewhere. */
export function dietaryLabels(tags) {
  if (!tags || tags.length === 0) return [];
  const wanted = new Set(tags.map((t) => String(t).trim()).filter(Boolean));
  const known = DIETARY_TAGS.filter((t) => wanted.has(t.key));
  const strange = [...wanted]
    .filter((k) => !byKey.has(k))
    .map((k) => ({ key: k, label: k.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) }));
  return [...known, ...strange];
}

/** The reassurances, and separately the warnings. The sheet colours them apart. */
export function splitDiet(tags) {
  const labels = dietaryLabels(tags);
  return {
    diets: labels.filter((t) => !t.caution).map((t) => t.label),
    cautions: labels.filter((t) => t.caution).map((t) => t.label),
  };
}

/** Dishes keep what can be left out as JSON. Anything unreadable is none. */
export function parseOmissions(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((o) => o && typeof o === 'object' && typeof o.name === 'string')
      .map((o, i) => ({
        key: String(o.key || `o${i}`),
        name: String(o.name).trim(),
        earns: Array.isArray(o.earns) ? o.earns.map(String).filter(Boolean) : [],
      }))
      .filter((o) => o.name !== '');
  } catch {
    return [];
  }
}

/**
 * What the dish becomes with these left out.
 *
 * A tag is earned only when EVERY omission offering it has been taken: two
 * things standing between a dish and vegan means leaving out one of them does
 * not make it vegan.
 */
export function tagsWithout(tags, omissions, chosen) {
  const taken = new Set(chosen);
  const has = new Set((tags ?? []).map((t) => String(t).trim()).filter(Boolean));
  const offered = new Set();
  for (const o of omissions) for (const t of o.earns) offered.add(t);
  for (const tag of offered) {
    const needed = omissions.filter((o) => o.earns.includes(tag));
    if (needed.length > 0 && needed.every((o) => taken.has(o.key))) has.add(tag);
  }
  return [...has];
}

/** Has anybody actually judged this choice? Untagged and not marked is "not yet". */
export const dietAssessed = (o) =>
  !!o.diet_neutral || (o.tags ?? []).some((t) => !isCaution(t));

/**
 * What the plate is once these choices are on it.
 *
 * A choice can only take a diet away, never grant one — cheese marked
 * vegetarian does not make a beef stew vegetarian — so diets intersect.
 * Cautions run the other way and are added: nuts in a sauce are nuts on the
 * plate, whatever the plate was before.
 *
 * `unknown` names the choices nobody has judged. They change nothing, and are
 * printed, because guessing safe risks somebody's health and guessing unsafe
 * would empty a menu that is perfectly correct.
 */
export function tagsWithOptions(tags, options) {
  let diets = (tags ?? []).map((t) => String(t).trim()).filter(Boolean).filter((t) => !isCaution(t));
  const cautions = new Set(
    (tags ?? []).map((t) => String(t).trim()).filter(Boolean).filter(isCaution),
  );
  const unknown = [];

  for (const o of options) {
    if (o.diet_neutral) continue;
    if (!dietAssessed(o)) { unknown.push(o.name); continue; }
    const its = new Set((o.tags ?? []).map((t) => String(t).trim()).filter(Boolean));
    diets = diets.filter((t) => its.has(t));
    for (const t of its) if (isCaution(t)) cautions.add(t);
  }

  const all = new Set([...diets, ...cautions]);
  return {
    tags: [
      ...DIETARY_TAGS.map((t) => t.key).filter((k) => all.has(k)),
      ...[...all].filter((k) => !byKey.has(k)),
    ],
    unknown,
  };
}
