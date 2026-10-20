/**
 * Columns an earlier schema left behind, and how to stop them refusing writes.
 *
 * Provisioning only ever adds. A column the schema has since dropped stays in
 * the live database, and if it was REQUIRED it refuses every new row the
 * current code writes, because the code has never heard of it. That is how
 * "Missing required attribute po_number" reached a manager pressing Done on a
 * purchase order: an older design of `purchase_orders` had a required
 * `po_number` (and `ordered_by`, `subtotal`…), the current one numbers orders
 * in `po_no`, and nothing ever told the old column it was no longer needed.
 *
 * Such a column is made optional, never deleted. Deleting would throw away
 * whatever the old rows hold, and an optional column nobody writes costs
 * nothing. Making it optional cannot break a write — it only stops refusing
 * them — which is why this needs no list of names and nobody's say-so.
 *
 * Plain JavaScript with no imports, so a test can load it without the SDK.
 */

/** Required live columns that the schema for this collection no longer has. */
export function leftoversToRelax(schemaAttributes, liveAttributes) {
  const known = new Set(schemaAttributes.map((a) => a[0]));
  return liveAttributes.filter((a) => a && a.required === true && !known.has(a.key));
}

/**
 * Bounds only where there genuinely are any. An integer created without
 * limits comes back carrying the full 64-bit range, which cannot survive a
 * round trip through a JavaScript number. See relaxIfNowOptional.
 */
const bound = (v) => (typeof v === 'number' && Number.isSafeInteger(v) ? v : null);

/**
 * Which update call makes this live column optional, and its arguments after
 * (database, collection, key). Null for a kind that cannot be relaxed this way
 * (an array, a relationship), which is left alone and reported.
 */
export function relaxCall(live) {
  if (live.array) return null;
  switch (live.type) {
    case 'string':
      if (live.format === 'enum') return ['updateEnumAttribute', [live.elements ?? [], false, null]];
      if (live.format === 'email') return ['updateEmailAttribute', [false, null]];
      if (live.format === 'url') return ['updateUrlAttribute', [false, null]];
      if (live.format === 'ip') return ['updateIpAttribute', [false, null]];
      return ['updateStringAttribute', [false, null, live.size]];
    case 'integer': return ['updateIntegerAttribute', [false, bound(live.min), bound(live.max), null]];
    case 'double': return ['updateFloatAttribute', [false, bound(live.min), bound(live.max), null]];
    case 'boolean': return ['updateBooleanAttribute', [false, null]];
    case 'datetime': return ['updateDatetimeAttribute', [false, null]];
    default: return null;
  }
}
