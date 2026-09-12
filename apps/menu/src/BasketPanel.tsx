import { Button } from '@snpos/ui';
import { formatMoney, lineTotal } from '@snpos/core';
import type { CartLine, Settings } from '@snpos/core';

/**
 * The basket, standing beside the menu instead of hiding behind a button.
 *
 * On anything wider than a tablet this is how every ordering tool worth
 * copying does it — a column on the right that fills as things are tapped, so
 * a hotel booking forty covers can see the order growing and check it against
 * the guests in front of them without opening anything. A single button at the
 * bottom of the page reading "See the booking · 2 meals" tells them a figure
 * and hides everything the figure is made of.
 *
 * It is NOT the answer on a phone, and this is the part people get wrong. A
 * phone has one column; a basket pinned beside the menu would take a third of
 * a screen that is mostly menu, and a basket stacked under it is a basket
 * nobody scrolls to. The pattern that works there — and the one the good
 * delivery apps all settled on — is a bar across the bottom that says what is
 * in the basket and opens it full-screen. So that is what happens: this panel
 * is hidden below the breakpoint by CSS, the bar is hidden above it, and both
 * read the same state, so neither can be stale or disagree.
 *
 * Not a scaled-down sheet either. Quantities can be changed here, because the
 * commonest correction is "make that nine, not four" and sending somebody
 * into a modal to do it is the thing the panel exists to avoid.
 */
export function BasketPanel({
  title, subtitle, lines, settings, total, totalLabel, actionLabel, onAction, onQty, empty,
}: {
  title: string;
  /** Which sitting is being filled, on a group booking. */
  subtitle?: string;
  lines: CartLine[];
  settings: Settings;
  total: number;
  totalLabel: string;
  actionLabel: string;
  onAction: () => void;
  onQty: (lineKey: string, qty: number) => void;
  /** Said instead of an empty list, because an empty box explains nothing. */
  empty: string;
}) {
  const portions = lines.reduce((n, l) => n + Math.max(0, l.qty), 0);

  return (
    <aside className="basket" aria-label={title}>
      <div className="basket-inner">
        <div className="basket-head">
          <h2>{title}</h2>
          {subtitle && <div className="basket-sub">{subtitle}</div>}
        </div>

        {lines.length === 0 ? (
          <p className="basket-empty">{empty}</p>
        ) : (
          <>
            <div className="basket-lines">
              {lines.map((line) => (
                <div className="basket-line" key={line.key}>
                  <div className="basket-line-body">
                    <div className="basket-line-name">{line.name}</div>
                    {line.addons.length > 0 && (
                      <div className="basket-line-note">{line.addons.map((a) => a.name).join(', ')}</div>
                    )}
                    {line.notes && <div className="basket-line-note">&ldquo;{line.notes}&rdquo;</div>}
                    <div className="qty" style={{ marginTop: '0.35rem' }}>
                      <button onClick={() => onQty(line.key, line.qty - 1)} aria-label={`One fewer ${line.name}`}>−</button>
                      <span>{line.qty}</span>
                      <button onClick={() => onQty(line.key, line.qty + 1)} aria-label={`One more ${line.name}`}>+</button>
                    </div>
                  </div>
                  <div className="basket-line-money">{formatMoney(lineTotal(line), settings)}</div>
                </div>
              ))}
            </div>

            <div className="basket-foot">
              <div className="basket-total">
                <span>
                  {totalLabel}
                  <span className="dim"> · {portions} portion{portions === 1 ? '' : 's'}</span>
                </span>
                <span>{formatMoney(total, settings)}</span>
              </div>
              <Button variant="primary" onClick={onAction} style={{ width: '100%' }}>
                {actionLabel}
              </Button>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
