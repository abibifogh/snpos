import type { ReactNode } from 'react';

/**
 * Two controls that were being drawn the same way, and should never have been.
 *
 * A screen asks two different questions and they had one answer between them:
 *
 *   WHICH VIEW am I in?      Ingredients, Categories, Packs, Where stock sits.
 *                            Different content. Nothing is being hidden.
 *   WHICH SUBSET am I seeing? All, Bistro, Bar, Craft shop.
 *                             Same content, narrowed. Things ARE being hidden.
 *
 * Both were pill rows, so pressing one told you nothing about whether the rows
 * that vanished were filtered out or simply belong to another screen. That
 * matters most when a list comes back empty: "there is nothing here" and "you
 * are looking in the wrong place" are the same picture.
 *
 * So they are drawn differently on purpose. Tabs are underlined text and read
 * as navigation. Filters are an enclosed switch and read as a setting. The
 * difference is the point; do not tidy them into looking alike.
 */

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

/**
 * A setting with a few options, all worth one tap.
 *
 * A dropdown for three choices that get switched between constantly costs two
 * taps and hides the options until you ask. This shows what there is and what
 * is on.
 */
export function Segmented<T extends string>({
  value, onChange, options, ariaLabel,
}: {
  value: T;
  onChange: (v: T) => void;
  options: SegmentedOption<T>[];
  ariaLabel: string;
}) {
  // One option is not a choice. A control that cannot change anything, sitting
  // where somebody expects one that can, teaches people to ignore the next one
  // along, which might matter.
  if (options.length < 2) return null;

  return (
    <div className="segmented" role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={value === o.value ? 'on' : ''}
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Which part of a screen you are looking at.
 *
 * Deliberately not the same shape as a filter. These were `pos-tabs`, a class
 * defined in the till's stylesheet and used on three admin pages that never
 * load it — so they rendered as bare browser buttons in a row, on a screen
 * where everything else is styled.
 */
export function ViewTabs<T extends string>({
  value, onChange, options, ariaLabel = 'Which view',
}: {
  value: T;
  onChange: (v: T) => void;
  options: SegmentedOption<T>[];
  ariaLabel?: string;
}) {
  return (
    <div className="view-tabs" role="tablist" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          className={value === o.value ? 'on' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * A filter's own label, beside it rather than above it.
 *
 * The stacked `Field` is right in a form, where somebody is answering
 * questions one after another and the label is the question. A filter bar is
 * not a form: nothing here is being filled in, it is being adjusted, and
 * stacking six labelled boxes turns "narrow this list" into a page of
 * homework standing between somebody and what they came to look at.
 */
export function FilterField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="filter-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

/**
 * The strip of controls that narrows the list below it.
 *
 * Directly above that list, always, and never inside a titled card. Filters
 * used to live in three places on three screens — the page header, a Card
 * called "Which orders", and loose above the table — so the first thing to
 * find on any screen was where the controls had been put this time.
 *
 * The count is not decoration. "Showing 12 of 140" is the difference between
 * a quiet day and a filter somebody forgot they set, and without it an empty
 * list is indistinguishable from a broken one.
 *
 * `onClear` appears only when something is actually narrowing the list. A
 * Clear button that is always there is one nobody reads; one that appears is
 * itself the signal that a filter is on.
 */
export function FilterBar({
  children, shown, total, noun, onClear,
}: {
  children: ReactNode;
  /** How many rows are showing, and how many there are altogether. */
  shown?: number;
  total?: number;
  /** What the rows are, for the count: "orders", "drinks". */
  noun?: string;
  onClear?: () => void;
}) {
  const counted = typeof shown === 'number' && typeof total === 'number';
  const narrowed = counted && shown !== total;

  return (
    <div className="filter-bar">
      <div className="filter-bar-controls">{children}</div>
      <div className="filter-bar-end">
        {counted && (
          <span className={narrowed ? 'small' : 'small dim'}>
            {narrowed ? `Showing ${shown} of ${total}` : `${total} ${noun ?? ''}`.trim()}
          </span>
        )}
        {onClear && (
          <button type="button" className="filter-clear" onClick={onClear}>Clear filters</button>
        )}
      </div>
    </div>
  );
}
