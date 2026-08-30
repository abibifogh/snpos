import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, Field, Input, Modal, Notice, Spinner } from '@snpos/ui';
import {
  formatMoney, listAll, loadItemSales, loadIngredientSales, toCsv, downloadCsv,
  historyRows, historyTotals, byDay, byPerson, emptyHistoryWords, daysBetween,
} from '@snpos/core';
import type { Settings, StaffProfile, HistoryRow } from '@snpos/core';
import { humanError } from '../lib';

/** Local midnight, so "the 28th" means the 28th here rather than in UTC. */
const dayStart = (d: string) => new Date(`${d}T00:00:00`).toISOString();
const dayEnd = (d: string) => new Date(`${d}T23:59:59.999`).toISOString();
const todayStr = () => new Date().toLocaleDateString('en-CA');
const daysAgoStr = (n: number) =>
  new Date(Date.now() - n * 86_400_000).toLocaleDateString('en-CA');

/**
 * Where one thing went.
 *
 * Opened from a dish, a bottle or a craft piece, and the same panel for all
 * three because the question is the same one: how many, when, and who sold
 * them. What differs is only how the rows are found — a menu item was rung up
 * itself; an ingredient was never rung up at all and its history is the
 * history of the drinks that consume it.
 *
 * The period is asked for rather than assumed. A month is the useful default
 * for "is this worth keeping on the menu"; a fortnight is the useful one for
 * "why is this bottle emptying", and neither is right for the other.
 */
export function SalesHistory({
  kind,
  id,
  name,
  settings,
  onClose,
}: {
  /** How the rows are found. A menu item sold itself; an ingredient did not. */
  kind: 'item' | 'ingredient';
  id: string;
  name: string;
  settings: Settings | null;
  onClose: () => void;
}) {
  const [from, setFrom] = useState(daysAgoStr(30));
  const [to, setTo] = useState(todayStr());
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [throughCount, setThroughCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const money = (n: number) => (settings ? formatMoney(n, settings) : String(n));

  useEffect(() => {
    let alive = true;
    (async () => {
      setBusy(true);
      setError(null);
      try {
        const [sales, staff] = await Promise.all([
          kind === 'item'
            ? loadItemSales(id, dayStart(from), dayEnd(to))
            : loadIngredientSales(id, dayStart(from), dayEnd(to)),
          listAll<StaffProfile>('staff_profiles').catch(() => [] as StaffProfile[]),
        ]);
        if (!alive) return;

        /*
          A name, not an id. The whole point of this column is that somebody
          can go and ask a person about it, and nobody can be asked by their
          user id. An id with no profile is shown as it is rather than as
          "Unknown", because an id at least narrows it down.
        */
        const names = new Map<string, string>();
        for (const p of staff) {
          if (p.user_id) names.set(p.user_id, p.display_name);
          names.set(p.$id, p.display_name);
        }
        const nameOf = (who?: string) => (who ? names.get(who) ?? who : 'Not recorded');

        setThroughCount(kind === 'ingredient' ? (sales.throughItems ?? []).length : null);
        setRows(historyRows(sales.lines, sales.orders, nameOf));
      } catch (e) {
        if (alive) setError(humanError(e));
      } finally {
        if (alive) setBusy(false);
      }
    })();
    return () => { alive = false; };
  }, [kind, id, from, to]);

  const totals = useMemo(() => historyTotals(rows ?? []), [rows]);
  const days = useMemo(() => byDay(rows ?? []), [rows]);
  const people = useMemo(() => byPerson(rows ?? []), [rows]);
  const busiest = useMemo(
    () => days.reduce((best, d) => (best && best.qty >= d.qty ? best : d), days[0]),
    [days],
  );

  const download = () => {
    const csv = toCsv(
      ['When', 'Order', 'What', 'Quantity', 'Value', 'Sold by', 'Order status', 'Payment', 'Voided'],
      (rows ?? []).map((r) => [
        new Date(r.at).toLocaleString(),
        r.orderNo,
        r.name,
        r.qty,
        // The raw figure, not the formatted one. A spreadsheet cannot add up a
        // column of currency symbols.
        r.value / 100,
        r.soldBy,
        r.status.toLowerCase(),
        r.paymentStatus,
        r.voided ? 'yes' : '',
      ]),
    );
    downloadCsv(`${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${from}-to-${to}.csv`, csv);
  };

  return (
    <Modal
      title={`${name} · sales history`}
      onClose={onClose}
      footer={
        <>
          <Button
            variant="ghost"
            onClick={download}
            disabled={!rows || rows.length === 0}
          >
            Download
          </Button>
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      <div className="row" style={{ gap: '0.75rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="From">
          <Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        </Field>
        <Field label="To">
          <Input type="date" value={to} min={from} max={todayStr()} onChange={(e) => setTo(e.target.value)} />
        </Field>
        {/* The periods somebody actually asks for, so the common case is one
            tap rather than two date pickers. */}
        <div className="row" style={{ gap: '0.35rem', paddingBottom: '0.35rem' }}>
          {[
            ['Today', 0], ['7 days', 7], ['30 days', 30], ['90 days', 90], ['This year', 365],
          ].map(([label, n]) => (
            <Button
              key={String(label)}
              size="sm"
              variant="ghost"
              onClick={() => { setFrom(daysAgoStr(n as number)); setTo(todayStr()); }}
            >
              {label}
            </Button>
          ))}
        </div>
      </div>

      {/* An ingredient is never rung up. Said plainly, once, so nobody reads
          this as a list of times somebody sold a bottle of tonic. */}
      {kind === 'ingredient' && throughCount !== null && (
        <p className="small dim" style={{ marginBottom: 0 }}>
          {throughCount === 0
            ? 'Nothing on the menu is set to use this, so there is nothing to show. Until a drink says how much '
              + 'of it each one uses, no sale can be traced back to this shelf.'
            : `This is not sold on its own — below is every sale of the ${throughCount === 1 ? 'drink' : `${throughCount} drinks`} that use it.`}
        </p>
      )}

      {error && <div style={{ margin: '1rem 0' }}><Notice>{error}</Notice></div>}

      {busy && !rows ? (
        <div style={{ padding: '2rem', textAlign: 'center' }}><Spinner /></div>
      ) : rows && rows.length === 0 ? (
        <p className="small dim">{emptyHistoryWords(daysBetween(from, to))}</p>
      ) : rows ? (
        <>
          <div className="row" style={{ gap: '0.75rem', flexWrap: 'wrap', margin: '1rem 0' }}>
            <Card>
              <div className="small dim">Sold</div>
              <div style={{ fontSize: '1.4rem', fontWeight: 650 }}>{totals.qty}</div>
              <div className="small dim">on {totals.bills} {totals.bills === 1 ? 'bill' : 'bills'}</div>
            </Card>
            <Card>
              <div className="small dim">Worth</div>
              <div style={{ fontSize: '1.4rem', fontWeight: 650 }}>{money(totals.value)}</div>
            </Card>
            {/* Only where there is something to say. A card reading zero on
                every screen is a card that stops being read. */}
            {totals.unpaidQty > 0 && (
              <Card>
                <div className="small dim">Not paid for</div>
                <div style={{ fontSize: '1.4rem', fontWeight: 650 }}>{totals.unpaidQty}</div>
                <div className="small dim">{money(totals.unpaidValue)} outstanding</div>
              </Card>
            )}
            {totals.voidedQty > 0 && (
              <Card>
                <div className="small dim">Rung up then voided</div>
                <div style={{ fontSize: '1.4rem', fontWeight: 650 }}>{totals.voidedQty}</div>
              </Card>
            )}
            {busiest && (
              <Card>
                <div className="small dim">Best day</div>
                <div style={{ fontSize: '1.4rem', fontWeight: 650 }}>{busiest.qty}</div>
                <div className="small dim">{new Date(`${busiest.day}T12:00:00`).toLocaleDateString()}</div>
              </Card>
            )}
          </div>

          {people.length > 1 && (
            <>
              <h3 style={{ margin: '1.2rem 0 0.4rem' }}>Who sold it</h3>
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Who</th><th className="num">Sold</th><th className="num">Worth</th></tr></thead>
                  <tbody>
                    {people.map((p) => (
                      <tr key={p.who}>
                        <td>{p.who}</td>
                        <td className="num">{p.qty}</td>
                        <td className="num dim">{money(p.value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <h3 style={{ margin: '1.2rem 0 0.4rem' }}>Every sale</h3>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Order</th>
                  <th>What</th>
                  <th className="num">Qty</th>
                  <th className="num">Value</th>
                  <th>Sold by</th>
                  <th>Paid</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.lineId} style={r.voided ? { opacity: 0.55 } : undefined}>
                    <td className="small">{new Date(r.at).toLocaleString()}</td>
                    <td style={{ fontWeight: 550 }}>{r.orderNo}</td>
                    <td className="small">
                      {r.name}
                      {/* Kept and marked rather than dropped: "rung up and then
                          taken off" is a different fact from "never rung up",
                          and it is the more interesting of the two. */}
                      {r.voided && <Badge tone="warn">Voided</Badge>}
                    </td>
                    <td className="num">{r.qty}</td>
                    <td className="num dim">{money(r.value)}</td>
                    <td className="small">{r.soldBy}</td>
                    <td>
                      {r.paymentStatus === 'paid'
                        ? <Badge tone="ok">paid</Badge>
                        : <Badge tone="warn">{r.paymentStatus}</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </Modal>
  );
}
