import { useEffect, useMemo, useState } from 'react';
import { Card, Empty, Notice, Spinner, Badge } from '@snpos/ui';
import { listAll, humanError } from '../lib';
import { formatMoney, loadConsignors, balancesByConsignor } from '@snpos/core';
import type { Consignor, ConsignorPayout } from '@snpos/core';
import { useSession } from '../session';

/**
 * Who is waiting to be paid, and what has been paid already.
 *
 * Two lists on one page because they answer one question a week apart: on
 * payday, who; afterwards, did it go. Splitting them means checking a payment
 * went out is a different screen from making it, and the gap is where a maker
 * gets missed twice running.
 *
 * Nothing is paid from here. The shop sends the money the way it always does
 * and records that it did — the same rule the whole system follows. Recording
 * happens inside a statement, so nobody ever pays a figure they have not seen
 * the workings for.
 */
export function PayoutsPage() {
  const { settings } = useSession();
  const money = (n: number) => (settings ? formatMoney(n, settings) : String(n));

  const [consignors, setConsignors] = useState<Consignor[] | null>(null);
  const [owed, setOwed] = useState<Record<string, number>>({});
  const [payouts, setPayouts] = useState<ConsignorPayout[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const [people, balances, paid] = await Promise.all([
        loadConsignors(),
        balancesByConsignor(),
        listAll<ConsignorPayout>('consignor_payouts'),
      ]);
      setConsignors(people);
      setOwed(balances);
      setPayouts(paid.sort((a, b) => b.paid_at.localeCompare(a.paid_at)));
    })().catch((e) => setError(humanError(e)));
  }, []);

  const nameOf = useMemo(
    () => Object.fromEntries((consignors ?? []).map((c) => [c.$id, c.name])),
    [consignors],
  );

  // Anything owed, most first. Somebody with nothing outstanding is not a row
  // to skim past on payday — they are not on the list.
  const waiting = useMemo(
    () =>
      (consignors ?? [])
        .map((c) => ({ consignor: c, balance: owed[c.$id] ?? 0 }))
        .filter((r) => r.balance > 0)
        .sort((a, b) => b.balance - a.balance),
    [consignors, owed],
  );

  if (consignors === null) return <Spinner />;

  const total = waiting.reduce((sum, r) => sum + r.balance, 0);

  return (
    <div>
      <div className="page-head">
        <h1>Payouts</h1>
      </div>

      {error && <Notice tone="err">{error}</Notice>}

      <Card title="Waiting to be paid">
        <div className="stat-row">
          <div className="stat">
            <div className="label">People</div>
            <div className="value">{waiting.length}</div>
          </div>
          <div className="stat">
            <div className="label">Owed altogether</div>
            <div className="value">{money(total)}</div>
          </div>
        </div>

        {waiting.length === 0 ? (
          <Empty title="Nobody is owed anything">
            Balances appear here as work sells. Every figure is added up from the sales and payments on
            record, so it can always be shown line by line.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Pay by</th>
                  <th className="num">Owed</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {waiting.map(({ consignor, balance }) => (
                  <tr key={consignor.$id}>
                    <td>
                      {consignor.name}
                      {!consignor.active && <Badge> No longer consigning</Badge>}
                    </td>
                    <td className="dim small">
                      {consignor.payout_method ?? 'momo'}
                      {consignor.payout_details ? ` · ${consignor.payout_details}` : ' · no number on file'}
                    </td>
                    <td className="num" style={{ fontWeight: 650 }}>{money(balance)}</td>
                    <td className="row-actions">
                      {/* Straight to their statement rather than a pay button
                          here. Paying a figure without the workings beside it
                          is how a wrong one gets paid twice. */}
                      <a href={`#/consignors`} className="linkish">Open statement</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="small dim" style={{ marginBottom: 0 }}>
          Somebody who has stopped consigning can still be owed money, so they stay on this list until they
          are paid.
        </p>
      </Card>

      <Card title="Already paid">
        {payouts.length === 0 ? (
          <Empty title="No payments recorded yet">
            Record one from inside a consignor's statement, where the figure and its workings are on the
            same screen.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>To</th>
                  <th>When</th>
                  <th>How</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {payouts.slice(0, 100).map((p) => (
                  <tr key={p.$id} style={p.status === 'reversed' ? { opacity: 0.5 } : undefined}>
                    <td><code>{p.reference}</code></td>
                    <td>{nameOf[p.consignor_id] ?? 'Unknown'}</td>
                    <td className="small">{new Date(p.paid_at).toLocaleDateString()}</td>
                    <td className="dim small">
                      {p.method}
                      {p.transaction_ref ? ` · ${p.transaction_ref}` : ''}
                    </td>
                    <td className="num">
                      {money(p.amount)}
                      {p.status === 'reversed' && <Badge tone="danger"> Reversed</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
