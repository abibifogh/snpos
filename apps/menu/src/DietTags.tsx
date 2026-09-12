import { dietaryLabels } from '@snpos/core';

/**
 * What a dish is safe for, as small pills under its description.
 *
 * Green for "you may" and amber for "mind": "contains nuts" is the opposite
 * kind of statement from "vegan", and a guest scanning quickly reads the
 * colour before the word.
 */
export function DietTags({ tags, couldBe }: {
  tags?: string[];
  /**
   * What the dish is not yet but could be, if something were left out.
   *
   * A quieter pill than the rest, and worded as an instruction rather than a
   * fact: "Open to make it vegetarian" is a different promise from
   * "Vegetarian", and a guest who cannot eat fish has to be able to tell them
   * apart at a glance — and to know that the second one needs them to do
   * something. See couldBeWords.
   */
  couldBe?: string;
}) {
  const labels = dietaryLabels(tags);
  if (labels.length === 0 && !couldBe) return null;
  return (
    <div className="diet" aria-label="Dietary information">
      {labels.map((t) => <span key={t.key} className={t.caution ? 'caution' : ''}>{t.label}</span>)}
      {couldBe && <span className="onask">{couldBe}</span>}
    </div>
  );
}
