import type { ReactNode } from 'react';
import { Badge, Input, Select } from './components';

/**
 * The rows of a count sheet, once, for the till and the admin.
 *
 * The bar's sheet was drawn twice — in the till's counting-in modal and on
 * the admin's Bar counts page — and the shop's twice more, in the till's
 * shelf count and on the Stocktake page. Same columns, same blank-is-not-
 * nought rule, same difference badge, each written out again, and the four
 * had already drifted: one showed what a difference was worth and one did
 * not, one padded the note box and one did not.
 *
 * The tables live here. What differs between the screens — which room, the
 * pour warnings, the held-change words — comes in as props.
 */

/* ------------------------------------------------------------------ bar */

export interface BarSheetLine {
  ingredientId: string;
  name: string;
  expected: number;
  unitCost?: number;
  countedText?: string;
  note?: string;
}

/** Counted less expected, or null while the box is blank or unreadable. */
export const barDelta = (l: { countedText?: string; expected: number }): number | null => {
  const typed = (l.countedText ?? '').trim();
  const counted = typed === '' ? null : Number(typed);
  return counted === null || !Number.isFinite(counted) ? null : Math.round((counted - l.expected) * 1000) / 1000;
};

export function BarCountTable({
  lines, onChange, money, extra,
}: {
  lines: BarSheetLine[];
  onChange: (ingredientId: string, patch: { countedText?: string; note?: string }) => void;
  /** Given, the difference is priced in a column of its own. */
  money?: (minor: number) => string;
  /** Anything a screen wants to say under a name: a pour warning, a button. */
  extra?: (line: BarSheetLine) => ReactNode;
}) {
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>What</th>
            <th className="num">Should be</th>
            <th style={{ width: '7rem' }}>Actually</th>
            <th className="num">Difference</th>
            {money && <th className="num">Worth</th>}
            <th style={{ width: '11rem' }}>Note</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => {
            const delta = barDelta(l);
            return (
              <tr key={l.ingredientId}>
                <td style={{ fontWeight: 550 }}>
                  {l.name}
                  {extra?.(l)}
                </td>
                <td className="num dim">{l.expected}</td>
                <td>
                  <Input
                    type="number"
                    step="any"
                    min="0"
                    placeholder="—"
                    value={l.countedText ?? ''}
                    onChange={(e) => onChange(l.ingredientId, { countedText: e.target.value })}
                  />
                </td>
                <td className="num">
                  {delta === null || delta === 0
                    ? <span className="dim">—</span>
                    : <Badge tone={delta < 0 ? 'danger' : 'warn'}>{delta > 0 ? `+${delta}` : delta}</Badge>}
                </td>
                {money && (
                  <td className="num dim">
                    {delta === null || delta === 0 ? '' : money(Math.round(Math.abs(delta) * (l.unitCost ?? 0)))}
                  </td>
                )}
                <td>
                  {/* Only where there is something to explain. A note box on
                      every line is forty boxes nobody fills. */}
                  {delta !== null && delta !== 0 ? (
                    <Input
                      value={l.note ?? ''}
                      placeholder="Breakage, a taste…"
                      onChange={(e) => onChange(l.ingredientId, { note: e.target.value })}
                    />
                  ) : (
                    <span className="dim small">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ----------------------------------------------------------------- shop */

export interface ShopSheetLine {
  menuItemId: string;
  variantId?: string;
  name: string;
  variantLabel?: string;
  consignorName?: string;
  categoryName?: string;
  onHand: number;
  countedText?: string;
  reason?: string;
}

export interface ShopReason { value: string; label: string }

/** Counted less what the shelf says, or null while the box is blank. */
export const shopDelta = (l: { countedText?: string; onHand: number }): number | null => {
  const typed = (l.countedText ?? '').trim();
  const counted = typed === '' ? null : Number(typed);
  return counted === null || !Number.isFinite(counted) ? null : counted - l.onHand;
};

export function ShopCountTable({
  lines, reasons, onChange, held, showMaker, showCategory, showDifference,
}: {
  lines: { line: ShopSheetLine; index: number }[];
  reasons: readonly ShopReason[];
  onChange: (index: number, patch: { countedText?: string; reason?: string }) => void;
  /**
   * Words for a piece with a change already waiting on it, or nothing. A
   * held piece cannot be counted again: two pending differences on one shelf
   * are applied as two deltas, which takes the pieces off twice.
   */
  held?: (line: ShopSheetLine) => ReactNode | null;
  showMaker?: boolean;
  showCategory?: boolean;
  /** The admin shows the difference in a column; the till keeps the sheet narrow. */
  showDifference?: boolean;
}) {
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>Piece</th>
            {showMaker && <th>Maker</th>}
            {showCategory && <th>Category</th>}
            <th className="num">Shelf says</th>
            <th style={{ width: '7rem' }}>Actually there</th>
            <th style={{ width: '13rem' }}>If it differs, why</th>
            {showDifference && <th className="num">Difference</th>}
          </tr>
        </thead>
        <tbody>
          {lines.map(({ line, index }) => {
            const delta = shopDelta(line);
            const holding = held?.(line) ?? null;
            return (
              <tr key={`${line.menuItemId}-${line.variantId ?? ''}`}>
                <td>
                  <div style={{ fontWeight: 550 }}>{line.name}</div>
                  {line.variantLabel && <div className="small dim">{line.variantLabel}</div>}
                </td>
                {showMaker && <td className="dim small">{line.consignorName ?? 'The shop'}</td>}
                {showCategory && <td className="dim small">{line.categoryName ?? '—'}</td>}
                <td className="num">{line.onHand}</td>
                <td>
                  <Input
                    type="number"
                    min="0"
                    step="1"
                    inputMode="numeric"
                    placeholder={holding ? 'held' : '—'}
                    value={holding ? '' : line.countedText ?? ''}
                    onChange={(e) => onChange(index, { countedText: e.target.value })}
                    disabled={!!holding}
                  />
                </td>
                <td>
                  {holding ? (
                    <span className="small" style={{ color: 'var(--warn)' }}>{holding}</span>
                  ) : delta !== null && delta < 0 ? (
                    <Select value={line.reason ?? 'counted'} onChange={(e) => onChange(index, { reason: e.target.value })}>
                      {reasons.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                    </Select>
                  ) : (
                    <span className="dim small">
                      {delta === null ? (showDifference ? 'Not counted' : '') : delta > 0 ? `${delta} more than expected` : 'Matches'}
                    </span>
                  )}
                </td>
                {showDifference && (
                  <td className="num">
                    {delta === null || delta === 0
                      ? <span className="dim">—</span>
                      : <Badge tone={delta < 0 ? 'danger' : 'warn'}>{delta > 0 ? `+${delta}` : delta}</Badge>}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
