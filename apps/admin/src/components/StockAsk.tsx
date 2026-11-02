import { useEffect, useState } from 'react';
import { Button, Input, Notice, Spinner } from '@snpos/ui';
import {
  loadStockRequest, requestPlans, orderFromRequest, declineStockRequest, draftPlans, suggestLine,
  qtyWords, leftWords, loadFeatures, featureConfig,
} from '@snpos/core';
import type { AskLine, OrderableItem, OrderSupplier, StockRequest } from '@snpos/core';
import { humanError } from '../lib';

/**
 * What the kitchen or the bar asked for, opened under its row on Approvals.
 *
 * Grouped as the orders it would make, one per supplier, priced at what was
 * last paid, with every amount open to change before the drafts are made.
 * "Not now" needs a reason, because the person who asked sees it. See
 * stock-requests.ts.
 */
export function StockAskPanel({ requestId, userId, userName, isAdmin, money, startDeclining = false, onDone }: {
  requestId: string;
  userId: string;
  userName?: string;
  isAdmin: boolean;
  money: (n: number) => string;
  /** Opened from "Not now", with the reason box already up. */
  startDeclining?: boolean;
  onDone: (words: string) => void;
}) {
  const [request, setRequest] = useState<StockRequest | null>(null);
  const [lines, setLines] = useState<AskLine[]>([]);
  const [items, setItems] = useState<OrderableItem[]>([]);
  const [suppliers, setSuppliers] = useState<OrderSupplier[]>([]);
  const [limit, setLimit] = useState(100000);
  const [declining, setDeclining] = useState(startDeclining);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await loadStockRequest(requestId);
        const got = await requestPlans(r.venue_id, r.lines);
        const features = await loadFeatures().catch(() => ({}));
        setRequest(r);
        setLines(r.lines);
        setItems(got.items);
        setSuppliers(got.suppliers);
        setLimit(featureConfig(features, 'purchase_orders', 'approve_over', 100000));
      } catch (e) {
        setError(humanError(e));
      }
    })();
  }, [requestId]);

  if (error && !request) return <Notice>{error}</Notice>;
  if (!request) return <Spinner />;

  const plans = draftPlans(lines, items, suppliers, suggestLine);
  const total = plans.reduce((n, p) => n + p.total, 0);
  const setQty = (id: string, qty: number) =>
    setLines((ls) => ls.map((l) => (l.ingredient_id === id ? { ...l, qty: Math.max(0, qty) } : l)));
  const asked = new Map(request.lines.map((l) => [l.ingredient_id, l]));

  const make = async () => {
    setBusy(true);
    setError(null);
    try {
      const { orders } = await orderFromRequest({ request, lines, approveOver: limit, isAdmin, by: userId, byName: userName });
      onDone(`${orders} draft order${orders === 1 ? '' : 's'} made, under Stock › Purchase orders. The ${request.side} sees "Ordered".`);
    } catch (e) {
      setError(humanError(e));
      setBusy(false);
    }
  };

  const decline = async () => {
    if (!reason.trim()) { setError('Say why, so whoever asked knows what to do next.'); return; }
    setBusy(true);
    setError(null);
    try {
      await declineStockRequest({ id: request.$id, by: userId, byName: userName, reason });
      onDone(`Sent back to the ${request.side} with your reason. Nothing was ordered.`);
    } catch (e) {
      setError(humanError(e));
      setBusy(false);
    }
  };

  return (
    <div className="stack" style={{ display: 'grid', gap: '0.9rem', padding: '0.4rem 0' }}>
      {error && <Notice>{error}</Notice>}
      {plans.map((p) => (
        <div key={p.supplier?.$id ?? 'none'} style={{ display: 'grid', gap: '0.35rem' }}>
          <div className="spread">
            <strong>{p.supplier?.name ?? 'No supplier set'}</strong>
            <span className="small dim">{p.total > 0 ? `about ${money(p.total)}` : 'no price on file'}</span>
          </div>
          <div className="table-wrap">
            <table className="data">
              <tbody>
                {p.lines.map((l) => {
                  const a = asked.get(l.ingredient_id);
                  return (
                    <tr key={l.ingredient_id || l.name}>
                      <td>
                        {l.name}
                        {a && <div className="small dim">{leftWords(a)} when asked</div>}
                      </td>
                      <td style={{ width: '9rem' }}>
                        <Input
                          type="number"
                          min={0}
                          step={1}
                          value={l.qty}
                          aria-label={`How many ${l.buy_label} of ${l.name}`}
                          onChange={(e) => setQty(l.ingredient_id, Math.round(Number(e.target.value) || 0))}
                        />
                      </td>
                      <td className="small dim">{l.buy_label}{a && a.qty !== l.qty ? ` (asked for ${qtyWords(a)})` : ''}</td>
                      <td className="num">{l.unit_cost > 0 ? money(Math.round(l.qty * l.unit_cost)) : '-'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
      {lines.some((l) => l.qty === 0) && (
        <p className="small dim" style={{ margin: 0 }}>Anything set to 0 is left off the orders.</p>
      )}
      {(request.note ?? '').trim() && (
        <div><strong>Note from the {request.side}</strong><p className="small" style={{ margin: '0.2rem 0 0', whiteSpace: 'pre-wrap' }}>“{request.note}”</p></div>
      )}
      <div className="spread" style={{ flexWrap: 'wrap', gap: '0.6rem' }}>
        <span className="small dim">{total > 0 ? `About ${money(total)} at the last prices paid.` : ''} Drafts, so each is checked and sent from Purchase orders as usual.</span>
        <div className="row" style={{ gap: '0.4rem' }}>
          <Button variant="ghost" disabled={busy} onClick={() => setDeclining((d) => !d)}>Not now…</Button>
          <Button variant="primary" loading={busy && !declining} disabled={plans.length === 0} onClick={() => void make()}>
            Make {plans.length} order{plans.length === 1 ? '' : 's'}
          </Button>
        </div>
      </div>
      {declining && (
        <div style={{ display: 'grid', gap: '0.5rem' }}>
          <Input
            autoFocus
            value={reason}
            placeholder="For example: the market run is Thursday, ask again Wednesday night."
            aria-label="Why not now"
            onChange={(e) => setReason(e.target.value)}
          />
          <div><Button loading={busy && declining} onClick={() => void decline()}>Send back to the {request.side}</Button></div>
        </div>
      )}
    </div>
  );
}
