import { useEffect, useState } from 'react';
import { Card, Empty, Notice, Spinner, Badge, Modal, Button } from '@snpos/ui';
import { listAll, humanError, Query } from '../lib';
import { formatMoney, byStaff, destinationLabel } from '@snpos/core';
import type { Doc, CashHandover } from '@snpos/core';
import { useSession } from '../session';
import { SideFilter, onSide, narrowSide, type Side } from '../components/SideFilter';

interface Shift extends Doc {
  venue_id: string;
  code: string;
  module?: 'kitchen' | 'craft';
  status: 'open' | 'closing' | 'closed';
  opened_by: string;
  opened_at: string;
  closed_at?: string;
  opening_floats: string;
  expected?: string;
  counted?: string;
  variance?: string;
  variance_note?: string;
  sales_total: number;
  expense_total: number;
  covers: number;
}

interface PaymentMethod extends Doc { name: string }
interface Expense extends Doc {
  shift_id?: string;
  amount: number;
  category: string;
  category_key?: string;
  payee?: string;
  note?: string;
  from_takings?: boolean;
}

/** One thing bought on a shop run, under the expense that paid for it. */
interface ExpenseItem extends Doc {
  expense_id: string;
  name_snapshot: string;
  qty: number;
  unit_cost: number;
  line_total: number;
  stocked?: boolean;
}

const parseMap = (raw?: string): Record<string, number> => {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, number>;
  } catch {
    return {};
  }
};

export function ShiftsPage() {
  const { settings, profile } = useSession();
  const [rows, setRows] = useState<Shift[] | null>(null);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  /**
   * The expense being opened, and what was actually bought with it.
   *
   * "Supplies, four hundred and eighty" is where the question starts, not
   * where it ends: a shop run is a list of things, and the whole point of
   * itemising one at the till was so somebody could read it afterwards. Loaded
   * when it is asked for rather than for every expense on every shift, because
   * most of them are never opened.
   */
  const [openExpense, setOpenExpense] = useState<Expense | null>(null);
  const [expenseItems, setExpenseItems] = useState<ExpenseItem[] | null>(null);

  const openLines = async (e: Expense) => {
    setOpenExpense(e);
    setExpenseItems(null);
    setExpenseItems(
      await listAll<ExpenseItem>('expense_items', [Query.equal('expense_id', e.$id)]).catch(() => []),
    );
  };
  const [handovers, setHandovers] = useState<CashHandover[]>([]);
  const [detail, setDetail] = useState<Shift | null>(null);
  const [side, setSide] = useState<Side>('all');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const [s, m, e, h] = await Promise.all([
        listAll<Shift>('shifts'),
        listAll<PaymentMethod>('payment_methods'),
        listAll<Expense>('shift_expenses'),
        listAll<CashHandover>('cash_handovers').catch(() => [] as CashHandover[]),
      ]);
      setRows(s.sort((a, b) => b.opened_at.localeCompare(a.opened_at)));
      setMethods(m);
      setExpenses(e);
      setHandovers(h);
    })().catch((err) => setError(humanError(err)));
  }, []);

  const methodName = (id: string) => methods.find((m) => m.$id === id)?.name ?? id;
  const tolerance = settings?.cash_variance_tolerance ?? 500;

  // Their side, not the whole business's. See narrowSide.
  const mine = narrowSide(side, profile, settings);
  const shown = (rows ?? []).filter((s) => onSide(s, mine));

  const totalVariance = (s: Shift) =>
    Object.values(parseMap(s.variance)).reduce((a, b) => a + b, 0);

  if (error) return <Notice>{error}</Notice>;

  return (
    <>
      <div className="page-head">
        <h1>Shifts</h1>
        <SideFilter value={side} onChange={setSide} settings={settings} profile={profile} />
      </div>
      <p className="dim small" style={{ marginTop: 0 }}>
        Shifts are opened and closed on the terminal, by whoever is on the till. This is the record of what happened, 
        what was expected in each drawer, what was actually counted, and the difference.
      </p>

      <Card pad={false}>
        {!rows ? (
          <div className="card-pad"><Spinner /></div>
        ) : shown.length === 0 ? (
          <Empty title={rows.length === 0 ? 'No shifts yet' : 'No shifts on that side'}>
            {rows.length === 0
              ? 'Open the first one from the terminal app when you start trading.'
              : 'Each side of the business opens and closes its own shift. Nothing has been opened on this one yet.'}
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Shift</th>
                  <th>Opened</th>
                  <th>Closed</th>
                  <th className="num">Sales</th>
                  <th className="num">Difference</th>
                  <th>Status</th>
                  {side === 'all' && <th>Side</th>}
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((s) => {
                  const diff = totalVariance(s);
                  return (
                    <tr key={s.$id}>
                      <td style={{ fontWeight: 550 }}>{s.code}</td>
                      <td className="dim small">{new Date(s.opened_at).toLocaleString()}</td>
                      <td className="dim small">{s.closed_at ? new Date(s.closed_at).toLocaleString() : '-'}</td>
                      <td className="num">{settings ? formatMoney(s.sales_total, settings) : s.sales_total}</td>
                      <td className="num">
                        {s.status === 'closed' ? (
                          diff === 0 ? (
                            <Badge tone="ok">Balanced</Badge>
                          ) : (
                            <Badge tone={Math.abs(diff) > tolerance ? 'danger' : 'warn'}>
                              {diff > 0 ? '+' : ''}
                              {settings ? formatMoney(diff, settings) : diff}
                            </Badge>
                          )
                        ) : (
                          ', '
                        )}
                      </td>
                      <td>{s.status === 'open' ? <Badge tone="ok">Open</Badge> : <Badge>Closed</Badge>}</td>
                      {/* Named only when both are on screen together. A column
                          that always says the same word is a column of noise. */}
                      {side === 'all' && (
                        <td className="dim small">{(s.module ?? 'kitchen') === 'craft' ? 'Craft shop' : 'Kitchen'}</td>
                      )}
                      <td className="num">
                        <Button size="sm" variant="ghost" onClick={() => setDetail(s)}>Details</Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {detail && (
        <Modal title={`Shift ${detail.code}`} onClose={() => setDetail(null)}>
          <div className="grid-2">
            <div>
              <h3>Opened</h3>
              <p className="small dim">{new Date(detail.opened_at).toLocaleString()}</p>
            </div>
            <div>
              <h3>Closed</h3>
              <p className="small dim">{detail.closed_at ? new Date(detail.closed_at).toLocaleString() : 'Still open'}</p>
            </div>
          </div>

          <h3 style={{ marginTop: '1rem' }}>Cash reconciliation</h3>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Method</th><th className="num">Float</th><th className="num">Expected</th><th className="num">Counted</th><th className="num">Difference</th></tr>
              </thead>
              <tbody>
                {Object.keys({ ...parseMap(detail.opening_floats), ...parseMap(detail.expected) }).map((id) => {
                  const diff = parseMap(detail.variance)[id] ?? 0;
                  return (
                    <tr key={id}>
                      <td>{methodName(id)}</td>
                      <td className="num dim">{settings ? formatMoney(parseMap(detail.opening_floats)[id] ?? 0, settings) : 0}</td>
                      <td className="num">{settings ? formatMoney(parseMap(detail.expected)[id] ?? 0, settings) : 0}</td>
                      <td className="num">{settings ? formatMoney(parseMap(detail.counted)[id] ?? 0, settings) : 0}</td>
                      <td className="num">
                        {diff === 0 ? (
                          <span className="dim">-</span>
                        ) : (
                          <Badge tone={Math.abs(diff) > tolerance ? 'danger' : 'warn'}>
                            {diff > 0 ? '+' : ''}
                            {settings ? formatMoney(diff, settings) : diff}
                          </Badge>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {Math.abs(totalVariance(detail)) > tolerance && (
            <Notice tone="warn">
              This shift is outside your tolerance of {settings ? formatMoney(tolerance, settings) : tolerance}. One
              bad count is a mistake; the same person repeatedly short is a pattern worth looking at.
            </Notice>
          )}

          {/* Who ended with what.
              The reconciliation above is about the drawer; this is about
              people. A shift is not a person; three can work one, take money
              in turn and leave at different times, so "what did Ama end with?"
              is a question the close cannot answer and this can. */}
          <h3 style={{ marginTop: '1rem' }}>Cash handed over</h3>
          {handovers.filter((h) => h.shift_id === detail.$id).length === 0 ? (
            <p className="small dim">
              Nobody recorded handing cash over on this shift. Staff record it themselves from the till, under
              "Hand over cash".
            </p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th>Who</th><th className="num">Handed over</th><th>To</th><th>When</th></tr>
                </thead>
                <tbody>
                  {byStaff(handovers.filter((h) => h.shift_id === detail.$id)).map((line) => (
                    <tr key={line.staffId}>
                      <td>{line.name}</td>
                      <td className="num" style={{ fontWeight: 650 }}>
                        {settings ? formatMoney(line.handedOver, settings) : line.handedOver}
                      </td>
                      <td className="small dim">
                        {/* Every trip, not just the total. Two trips to the
                            safe and one trip of twice the size are different
                            evenings, and only one of them is worth a question. */}
                        {line.entries
                          .filter((e) => e.status !== 'corrected')
                          .map((e) => e.received_by_name || destinationLabel(e.destination))
                          .join(', ')}
                      </td>
                      <td className="small dim">
                        {line.entries
                          .filter((e) => e.status !== 'corrected')
                          .map((e) => new Date(e.handed_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
                          .join(', ')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h3 style={{ marginTop: '1rem' }}>Expenses in this shift</h3>
          {expenses.filter((e) => e.shift_id === detail.$id).length === 0 ? (
            <p className="small dim">None recorded.</p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <tbody>
                  {expenses
                    .filter((e) => e.shift_id === detail.$id)
                    .map((e) => (
                      <tr key={e.$id}>
                        <td>
                          {e.category_key || e.category}
                          {e.payee && <div className="small dim">{e.payee}</div>}
                          {/* The one thing about an expense that changes what
                              the drawer was counted against. */}
                          {e.from_takings === false && <div className="small dim">from petty cash</div>}
                        </td>
                        <td className="num">{settings ? formatMoney(e.amount, settings) : e.amount}</td>
                        <td style={{ width: '1%' }}>
                          <Button size="sm" variant="ghost" onClick={() => void openLines(e)}>Details</Button>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </Modal>
      )}

      {/*
        What one expense was actually spent on.
        
        A shop run is a list of things, and itemising it at the till was done so
        somebody could read it back. Until now the only way to see that list was
        the admin expenses page, which meant leaving the shift you were looking
        at and finding the same row again.
      */}
      {openExpense && (
        <Modal
          title={`${openExpense.category_key || openExpense.category} · ${settings ? formatMoney(openExpense.amount, settings) : openExpense.amount}`}
          onClose={() => setOpenExpense(null)}
          footer={<Button onClick={() => setOpenExpense(null)}>Close</Button>}
        >
          {openExpense.payee && <p className="small dim" style={{ marginTop: 0 }}>Paid to {openExpense.payee}</p>}
          {openExpense.note && <p className="small">{openExpense.note}</p>}

          {expenseItems === null ? (
            <Spinner />
          ) : expenseItems.length === 0 ? (
            <p className="small dim">
              Nothing was itemised on this one. Plenty of spending has nothing to list — a taxi, a gas refill, a
              repair — and it was recorded as a single amount.
            </p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr><th>What</th><th className="num">How many</th><th className="num">Each</th><th className="num">Paid</th></tr>
                </thead>
                <tbody>
                  {expenseItems.map((i) => (
                    <tr key={i.$id}>
                      <td>
                        {i.name_snapshot}
                        {/* An overhead is used up in the buying and never
                            reached a shelf, which is worth saying beside the
                            things that did. */}
                        {i.stocked === false && <div className="small dim">not stocked, used up in the buying</div>}
                      </td>
                      <td className="num">{i.qty}</td>
                      <td className="num dim">{settings ? formatMoney(i.unit_cost, settings) : i.unit_cost}</td>
                      <td className="num">{settings ? formatMoney(i.line_total, settings) : i.line_total}</td>
                    </tr>
                  ))}
                  <tr>
                    <td colSpan={3} style={{ fontWeight: 650 }}>Itemised</td>
                    <td className="num" style={{ fontWeight: 650 }}>
                      {settings
                        ? formatMoney(expenseItems.reduce((s2, i) => s2 + i.line_total, 0), settings)
                        : expenseItems.reduce((s2, i) => s2 + i.line_total, 0)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
