import { useEffect, useMemo, useState } from 'react';
import {
  Button, Card, Empty, Field, Input, Modal, Notice, Select, Spinner, Textarea, Toggle, Badge, useToast,
} from '@snpos/ui';
import { db, DB_ID, ID, humanError } from '../lib';
import {
  formatMoney, parseMoney, toInput,
  loadConsignors, balancesByConsignor, ledgerFor, buildStatement, recordPayout, nextReference,
  buildStatementHtml, openPrintable,
} from '@snpos/core';
import type { Consignor, LedgerEntry, Statement, Settings } from '@snpos/core';
import { useSession } from '../session';

/**
 * The people whose work the shop sells, and what it owes them.
 *
 * The balance on every row is summed from the ledger rather than stored. That
 * is the whole design of the consignment side and it shows up here first: a
 * number somebody can edit is a number that eventually disagrees with the
 * maker's own notebook, and in that argument the shop has no evidence.
 */
export function ConsignorsPage() {
  const toast = useToast();
  const { settings, user } = useSession();
  const decimals = settings?.currency_decimals ?? 2;
  const money = (n: number) => (settings ? formatMoney(n, settings) : String(n));

  const [rows, setRows] = useState<Consignor[] | null>(null);
  const [owed, setOwed] = useState<Record<string, number>>({});
  const [editing, setEditing] = useState<Partial<Consignor> | null>(null);
  const [rateText, setRateText] = useState('30');
  const [statementFor, setStatementFor] = useState<Consignor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showInactive, setShowInactive] = useState(false);

  const load = async () => {
    const [list, balances] = await Promise.all([loadConsignors(), balancesByConsignor()]);
    setRows(list);
    setOwed(balances);
  };
  useEffect(() => { load().catch((e) => setError(humanError(e))); }, []);

  const visible = useMemo(
    () => (rows ?? []).filter((c) => showInactive || c.active),
    [rows, showInactive],
  );

  const totalOwed = useMemo(
    () => (rows ?? []).reduce((sum, c) => sum + Math.max(0, owed[c.$id] ?? 0), 0),
    [rows, owed],
  );

  const open = (row?: Consignor) => {
    setEditing(
      row ?? {
        code: '',
        name: '',
        commission_bp: settings?.default_commission_bp ?? 3000,
        payout_method: 'momo',
        active: true,
      },
    );
    // Shown as a percentage because that is how the conversation happens. Stored
    // in basis points because 33.5% is a real rate and floating-point money is
    // not.
    setRateText(String((row?.commission_bp ?? settings?.default_commission_bp ?? 3000) / 100));
    setError(null);
  };

  const save = async () => {
    if (!editing?.name?.trim()) { setError('Give the consignor a name.'); return; }
    const rate = Number(rateText);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
      setError('The commission has to be between 0 and 100 percent.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const payload = {
        venue_id: editing.venue_id ?? 'main',
        // Short and human, because it goes on the label tied to every piece and
        // gets read out over a phone. Made from the name if nobody gives one.
        code: (editing.code || suggestCode(editing.name)).toUpperCase().slice(0, 24),
        name: editing.name.trim(),
        phone: editing.phone?.trim() ?? '',
        email: editing.email?.trim() ?? '',
        address: editing.address?.trim() ?? '',
        commission_bp: Math.round(rate * 100),
        payout_method: editing.payout_method ?? 'momo',
        payout_details: editing.payout_details?.trim() ?? '',
        agreement_start: editing.agreement_start || undefined,
        agreement_end: editing.agreement_end || undefined,
        notes: editing.notes?.trim() ?? '',
        active: editing.active ?? true,
      };
      if (editing.$id) await db.updateDocument(DB_ID, 'consignors', editing.$id, payload);
      else await db.createDocument(DB_ID, 'consignors', ID.unique(), payload);
      await load();
      setEditing(null);
      toast('Saved');
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  if (rows === null) return <Spinner />;

  return (
    <div>
      <div className="page-head">
        <h1>Consignors</h1>
        <Button variant="primary" onClick={() => open()}>Add a consignor</Button>
      </div>

      {error && <Notice tone="err">{error}</Notice>}

      <Card>
        <div className="stat-row">
          <div className="stat">
            <div className="label">People</div>
            <div className="value">{(rows ?? []).filter((c) => c.active).length}</div>
          </div>
          <div className="stat">
            <div className="label">Owed altogether</div>
            <div className="value">{money(totalOwed)}</div>
          </div>
        </div>
        <p className="small dim" style={{ marginBottom: 0 }}>
          Every balance here is added up from the sales and payments on record, not stored anywhere.
          It can always be shown line by line, open a statement to see exactly where a figure came from.
        </p>
      </Card>

      <Card>
        <Toggle checked={showInactive} onChange={setShowInactive} label="Include people no longer consigning" />

        {visible.length === 0 ? (
          <Empty title="No consignors yet">
            Add the people who leave work with you to be sold. Each one gets their own commission rate
            and their own statement.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Name</th>
                  <th>Commission</th>
                  <th className="num">Owed</th>
                  <th>Pay by</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {visible.map((c) => {
                  const balance = owed[c.$id] ?? 0;
                  return (
                    <tr key={c.$id}>
                      <td><code>{c.code}</code></td>
                      <td>
                        {c.name}
                        {!c.active && <Badge> Inactive</Badge>}
                        {c.phone && <div className="dim small">{c.phone}</div>}
                      </td>
                      <td>{(c.commission_bp / 100).toFixed(c.commission_bp % 100 ? 1 : 0)}%</td>
                      {/* Nothing owed and money owed read differently at a
                          glance, which is the only thing this column is for. */}
                      <td className="num" style={balance > 0 ? { fontWeight: 650 } : { opacity: 0.55 }}>
                        {money(balance)}
                      </td>
                      <td className="dim small">
                        {c.payout_method ?? 'momo'}
                        {c.payout_details ? ` · ${c.payout_details}` : ''}
                      </td>
                      <td className="row-actions">
                        <Button onClick={() => setStatementFor(c)}>Statement</Button>
                        <Button onClick={() => open(c)}>Edit</Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editing && (
        <Modal
          title={editing.$id ? `Edit ${editing.name}` : 'Add a consignor'}
          onClose={() => setEditing(null)}
          footer={
            <>
              <Button onClick={() => setEditing(null)}>Cancel</Button>
              <Button variant="primary" onClick={save} loading={busy}>Save</Button>
            </>
          }
        >
          {error && <Notice tone="err">{error}</Notice>}

          <Field label="Name">
            <Input value={editing.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
          </Field>
          <Field
            label="Short code"
            hint="Goes on the label tied to each piece, and gets read out over the phone. Left blank, one is made from the name."
          >
            <Input
              value={editing.code ?? ''}
              placeholder={editing.name ? suggestCode(editing.name) : 'AKO'}
              onChange={(e) => setEditing({ ...editing, code: e.target.value.toUpperCase() })}
            />
          </Field>

          <div className="grid-2">
            <Field label="Phone">
              <Input value={editing.phone ?? ''} onChange={(e) => setEditing({ ...editing, phone: e.target.value })} />
            </Field>
            <Field label="Email" hint="Where their statement goes.">
              <Input
                type="email"
                value={editing.email ?? ''}
                onChange={(e) => setEditing({ ...editing, email: e.target.value })}
              />
            </Field>
          </div>

          <Field
            label="Commission you keep (%)"
            hint="What the shop keeps from each sale. The rest is theirs. This rate is saved onto every sale as it happens, so changing it here never rewrites what somebody has already earned."
          >
            <Input inputMode="decimal" value={rateText} onChange={(e) => setRateText(e.target.value)} />
          </Field>

          <div className="grid-2">
            <Field label="Pay them by">
              <Select
                value={editing.payout_method ?? 'momo'}
                onChange={(e) =>
                  setEditing({ ...editing, payout_method: e.target.value as Consignor['payout_method'] })
                }
              >
                <option value="momo">Mobile money</option>
                <option value="cash">Cash</option>
                <option value="bank">Bank transfer</option>
                <option value="other">Something else</option>
              </Select>
            </Field>
            <Field label="Number or account">
              <Input
                value={editing.payout_details ?? ''}
                onChange={(e) => setEditing({ ...editing, payout_details: e.target.value })}
              />
            </Field>
          </div>

          <Field label="Notes">
            <Textarea
              rows={3}
              value={editing.notes ?? ''}
              onChange={(e) => setEditing({ ...editing, notes: e.target.value })}
            />
          </Field>

          <Toggle
            checked={editing.active ?? true}
            onChange={(v) => setEditing({ ...editing, active: v })}
            label="Still consigning"
          />
          <p className="small dim" style={{ marginBottom: 0 }}>
            Turning this off only hides them from the day-to-day lists. Their sales, statements and anything
            still owed stay exactly where they are, somebody who has stopped bringing work in is usually still
            waiting to be paid.
          </p>
        </Modal>
      )}

      {statementFor && settings && (
        <StatementModal
          consignor={statementFor}
          money={money}
          decimals={decimals}
          settings={settings}
          userId={user?.$id ?? ''}
          onClose={() => setStatementFor(null)}
          onPaid={async (m) => { await load(); toast(m); }}
        />
      )}
    </div>
  );
}

/** Initials, roughly. Enough to be recognisable and short enough for a label. */
function suggestCode(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return words.slice(0, 3).map((w) => w[0]).join('').toUpperCase();
}

const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);
const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * One consignor's statement, and the way to settle it.
 *
 * The two live together because they are one job: somebody opens this to find
 * out what is owed and then pays it. Splitting them across two screens is how a
 * payout gets recorded against the wrong period.
 */
function StatementModal({
  consignor, money, decimals, userId, settings, onClose, onPaid,
}: {
  consignor: Consignor;
  money: (n: number) => string;
  decimals: number;
  userId: string;
  settings: Settings;
  onClose: () => void;
  onPaid: (message: string) => Promise<void>;
}) {
  const [entries, setEntries] = useState<LedgerEntry[] | null>(null);
  const [from, setFrom] = useState(iso(startOfMonth(new Date())));
  const [to, setTo] = useState(iso(new Date()));
  const [paying, setPaying] = useState(false);
  const [payText, setPayText] = useState('');
  const [payRef, setPayRef] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    ledgerFor(consignor.$id).then(setEntries).catch((e) => setError(humanError(e)));
  }, [consignor.$id]);

  const statement: Statement<Consignor> | null = useMemo(() => {
    if (!entries) return null;
    return buildStatement(consignor, entries, new Date(from), new Date(to));
  }, [entries, consignor, from, to]);

  /**
   * What is owed today, not what was owed at the end of the chosen period.
   *
   * A payout settles the real balance. Paying the closing figure of a window
   * that ended last Tuesday would leave out everything sold since, and nobody
   * looking at a statement expects the "pay" button to mean "pay what you owed
   * a week ago".
   */
  const owedNow = useMemo(
    () => (entries ?? []).reduce((sum, e) => sum + e.amount, 0),
    [entries],
  );

  const startPaying = async () => {
    setPaying(true);
    setPayText(toInput(Math.max(0, owedNow), decimals));
    setPayRef(await nextReference('consignor_payouts', 'PAY').catch(() => 'PAY-0001'));
  };

  const pay = async () => {
    const amount = parseMoney(payText, decimals);
    if (amount === null || amount <= 0) { setError('Enter what you are paying.'); return; }
    if (amount > owedNow) {
      setError(`That is more than the ${money(owedNow)} owed. Correct the amount, or record an adjustment first.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await recordPayout({
        venueId: consignor.venue_id ?? 'main',
        consignor,
        amount,
        method: consignor.payout_method ?? 'momo',
        reference: payRef,
        periodStart: new Date(from).toISOString(),
        periodEnd: new Date(to).toISOString(),
        userId,
      });
      setEntries(await ledgerFor(consignor.$id));
      setPaying(false);
      await onPaid(`${money(amount)} recorded as paid to ${consignor.name}`);
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      wide
      title={`Statement · ${consignor.name}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          {/* A document, not the screen.
              window.print() printed the whole admin app, sidebar and all, which
              is not something anybody would hand to a maker. This builds the
              statement on its own page and prints that. */}
          <Button
            onClick={() =>
              statement && settings &&
              openPrintable(
                buildStatementHtml({ statement, settings, owedNow }),
                `Statement ${consignor.code}`,
              )
            }
            disabled={!statement}
          >
            Print or save as PDF
          </Button>
          {!paying && owedNow > 0 && (
            <Button variant="primary" onClick={startPaying}>Record a payment</Button>
          )}
        </>
      }
    >
      {error && <Notice tone="err">{error}</Notice>}

      <div className="grid-2">
        <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>

      {statement === null ? (
        <Spinner />
      ) : (
        <>
          <div className="stat-row">
            <div className="stat">
              <div className="label">Sold</div>
              <div className="value">{statement.soldCount}</div>
            </div>
            <div className="stat">
              <div className="label">They sold for</div>
              <div className="value">{money(statement.grossSales)}</div>
            </div>
            <div className="stat">
              <div className="label">Shop kept</div>
              <div className="value">{money(statement.commissionKept)}</div>
            </div>
            <div className="stat">
              <div className="label">They earned</div>
              <div className="value">{money(statement.earned)}</div>
            </div>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>What</th>
                  <th className="num">Qty</th>
                  <th className="num">Sold for</th>
                  <th className="num">Shop kept</th>
                  <th className="num">Theirs</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td colSpan={5} className="dim">Owed at {new Date(from).toLocaleDateString()}</td>
                  <td className="num">{money(statement.openingBalance)}</td>
                </tr>
                {statement.lines.length === 0 && (
                  <tr><td colSpan={6} className="dim">Nothing between these dates.</td></tr>
                )}
                {statement.lines.map((l, i) => (
                  <tr key={i}>
                    <td className="small">{new Date(l.at).toLocaleDateString()}</td>
                    <td>
                      {l.description}
                      {l.kind !== 'sale' && <Badge> {l.kind}</Badge>}
                    </td>
                    <td className="num">{l.qty || ''}</td>
                    <td className="num">{l.gross ? money(l.gross) : ''}</td>
                    <td className="num">{l.commission ? money(l.commission) : ''}</td>
                    <td className="num" style={l.amount < 0 ? { opacity: 0.7 } : undefined}>
                      {money(l.amount)}
                    </td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={5} style={{ fontWeight: 650 }}>
                    Owed at {new Date(to).toLocaleDateString()}
                  </td>
                  <td className="num" style={{ fontWeight: 650 }}>{money(statement.closingBalance)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* The figure that matters for paying is today's, and it is not always
              the closing figure above, anything sold since the chosen end date
              is owed too. Said plainly rather than left to be worked out. */}
          {Math.round(owedNow) !== Math.round(statement.closingBalance) && (
            <p className="small dim">
              Owed right now, including anything after {new Date(to).toLocaleDateString()}:{' '}
              <strong>{money(owedNow)}</strong>
            </p>
          )}

          {paying && (
            <Card title={`Record a payment to ${consignor.name}`}>
              <p className="small dim">
                This writes down that you paid them. It does not move any money, send the{' '}
                {consignor.payout_method === 'cash' ? 'cash' : consignor.payout_method ?? 'mobile money'}
                {consignor.payout_details ? ` to ${consignor.payout_details}` : ''} the usual way, then record it here.
              </p>
              <div className="grid-2">
                <Field label="Amount">
                  <Input inputMode="decimal" value={payText} onChange={(e) => setPayText(e.target.value)} />
                </Field>
                <Field label="Reference">
                  <Input value={payRef} onChange={(e) => setPayRef(e.target.value)} />
                </Field>
              </div>
              <div className="row">
                <Button onClick={() => setPaying(false)}>Cancel</Button>
                <Button variant="primary" onClick={pay} loading={busy}>Record it</Button>
              </div>
            </Card>
          )}
        </>
      )}
    </Modal>
  );
}
