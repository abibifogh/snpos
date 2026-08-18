import { Fragment } from 'react';
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

/* ------------------------------------------------- grouping and sorting

   Odoo's shape, and for its reason: the questions people actually have are
   two or three deep. "What did we take" is answered by a total; "what did we
   take, by day, by who was on" is the question somebody has when a figure
   looks wrong, and it needs the groupings to stack in a chosen order. */

/** A menu of things to tick, staying open so several can be chosen at once. */
export function PickerMenu({
  label, children, count, open, onOpen,
}: {
  label: string;
  children: ReactNode;
  /** Shown as a badge, so a closed menu still says how many are on. */
  count?: number;
  open: boolean;
  onOpen: (open: boolean) => void;
}) {
  return (
    <div className="picker">
      <button
        type="button"
        className={count ? 'picker-button on' : 'picker-button'}
        aria-expanded={open}
        onClick={() => onOpen(!open)}
      >
        {label}
        {count ? <span className="picker-count">{count}</span> : null}
        <span aria-hidden="true" className="picker-caret">▾</span>
      </button>
      {open && (
        <>
          {/*
            A click anywhere else closes it. Without this the only way out is
            to press the button again, which nobody does — they click the page
            and then wonder why the menu is following them down it.
          */}
          <button type="button" className="picker-scrim" aria-label="Close" onClick={() => onOpen(false)} />
          <div className="picker-menu" role="menu">{children}</div>
        </>
      )}
    </div>
  );
}

/** One line in a picker menu: a tick, a name, and where it sits in the order. */
export function PickerItem({
  label, on, position, dir, onClick,
}: {
  label: string;
  on: boolean;
  /** 1-based place in the chosen order, shown so the sequence is visible. */
  position?: number;
  dir?: 'asc' | 'desc' | null;
  onClick: () => void;
}) {
  return (
    <button type="button" role="menuitem" className={on ? 'picker-item on' : 'picker-item'} onClick={onClick}>
      <span className="picker-tick" aria-hidden="true">{on ? '✓' : ''}</span>
      <span className="picker-label">{label}</span>
      {dir && <span className="picker-dir" aria-hidden="true">{dir === 'asc' ? '↑' : '↓'}</span>}
      {position ? <span className="picker-order">{position}</span> : null}
    </button>
  );
}

/**
 * What is currently applied, in order, each removable.
 *
 * The menus say what is available; these say what is ON. Without them the
 * only way to know how a list is grouped is to open two menus and read the
 * ticks, and the order — which is the whole point of stacking them — is not
 * visible anywhere at all.
 */
export function FacetChips({
  facets, onRemove, onClear,
}: {
  facets: { kind: string; label: string; detail?: string }[];
  onRemove: (index: number) => void;
  onClear?: () => void;
}) {
  if (facets.length === 0) return null;
  return (
    <div className="facets">
      {facets.map((f, i) => (
        <span className="facet" key={`${f.kind}-${f.label}-${i}`}>
          <span className="facet-kind">{f.kind}</span>
          <span>{f.label}{f.detail ? ` ${f.detail}` : ''}</span>
          <button type="button" aria-label={`Remove ${f.label}`} onClick={() => onRemove(i)}>×</button>
        </span>
      ))}
      {onClear && facets.length > 1 && (
        <button type="button" className="filter-clear" onClick={onClear}>Clear all</button>
      )}
    </div>
  );
}

/**
 * A grouped table body: group rows with the real rows nested underneath.
 *
 * Rendered as rows in the SAME table rather than as nested tables or cards,
 * because the columns have to keep lining up. A group of orders whose amounts
 * sit under a different column from the ungrouped ones is a table you cannot
 * read down, which is the only reason to have a table.
 *
 * Every group starts open. A screen that groups by day and then hides every
 * day has answered a question nobody asked and added a click per answer; the
 * folding is there for the one deep list where it helps, not as a default
 * state to be dug out of.
 */
export function GroupedRows<T>({
  nodes, rows, columns, renderRow, summary, closed, onToggle, rowKey,
}: {
  /** The tree, or null when nothing is grouped. */
  nodes: GroupNodeLike<T>[] | null;
  /** The flat rows, used when nothing is grouped. */
  rows: T[];
  /** How many columns the table has, so a group row can span them. */
  columns: number;
  renderRow: (row: T) => ReactNode;
  /** Something to show on the group's own row: a total, usually. */
  summary?: (rows: T[]) => ReactNode;
  closed: Set<string>;
  onToggle: (path: string) => void;
  rowKey: (row: T) => string;
}): ReactNode {
  if (!nodes) return <>{rows.map((r) => <Fragment key={rowKey(r)}>{renderRow(r)}</Fragment>)}</>;

  return (
    <>
      {nodes.map((node) => {
        const shut = closed.has(node.path);
        return (
          <Fragment key={node.path}>
            <tr className="group-row" onClick={() => onToggle(node.path)}>
              <td colSpan={Math.max(1, columns - 1)} style={{ paddingLeft: `${0.6 + node.depth * 1.1}rem` }}>
                <span className="group-caret" aria-hidden="true">{shut ? '▸' : '▾'}</span>
                <span className="group-kind">{node.label}: </span>
                {node.value}
                <span className="group-count">
                  {node.rows.length} {node.rows.length === 1 ? 'row' : 'rows'}
                </span>
              </td>
              <td className="num">{summary?.(node.rows)}</td>
            </tr>
            {!shut && (
              <GroupedRows
                nodes={node.children}
                rows={node.rows}
                columns={columns}
                renderRow={renderRow}
                summary={summary}
                closed={closed}
                onToggle={onToggle}
                rowKey={rowKey}
              />
            )}
          </Fragment>
        );
      })}
    </>
  );
}

/** Mirrors GroupNode in core, kept structural so this package imports nothing. */
export interface GroupNodeLike<T> {
  key: string;
  label: string;
  value: string;
  rows: T[];
  children: GroupNodeLike<T>[] | null;
  depth: number;
  path: string;
}

/** A column header that sorts, showing its direction and its place in the order. */
export function SortableTh({
  label, dir, position, onClick, className,
}: {
  label: string;
  dir: 'asc' | 'desc' | null;
  /** 1-based, 0 when this column is not part of the sort. */
  position: number;
  onClick: () => void;
  className?: string;
}) {
  return (
    <th
      className={className ? `${className} sortable` : 'sortable'}
      onClick={onClick}
      aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'}
    >
      {label}
      {dir && <span className="sort-mark" aria-hidden="true">{dir === 'asc' ? '↑' : '↓'}</span>}
      {position > 1 && <span className="sort-order" aria-hidden="true">{position}</span>}
    </th>
  );
}
