import { dietaryLabels } from '@snpos/core';

/**
 * What a dish is safe for, as small pills under its description.
 *
 * Green for "you may" and amber for "mind": "contains nuts" is the opposite
 * kind of statement from "vegan", and a guest scanning quickly reads the
 * colour before the word.
 */
export function DietTags({ tags }: { tags?: string[] }) {
  const labels = dietaryLabels(tags);
  if (labels.length === 0) return null;
  return (
    <div className="diet" aria-label="Dietary information">
      {labels.map((t) => <span key={t.key} className={t.caution ? 'caution' : ''}>{t.label}</span>)}
    </div>
  );
}
