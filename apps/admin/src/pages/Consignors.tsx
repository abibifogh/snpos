import { useEffect, useMemo, useState } from 'react';
import {
  Button, Card, Empty, Field, Input, Modal, Notice, Select, Spinner, Textarea, Toggle, Badge, useToast,
} from '@snpos/ui';
import { db, DB_ID, ID, humanError } from '../lib';
import { listAll, Query } from '@snpos/core';
import {
  formatMoney, parseMoney, toInput,
  loadConsignors, balancesByConsignor, ledgerFor, buildStatement, recordPayout, nextReference,
  buildStatementHtml, openPrintable, rateFor, flatFor, dueFor, onHandFor,
  owedBreakdown, labelForKind, makerCode, hasShelf,
} from '@snpos/core';
import type {
  Consignor, LedgerEntry, Statement, Settings, ConsignmentIntake, MenuItem, ProductVariant, UnsoldLine,
  OwedLine,
} from '@snpos/core';
import { useSession } from '../session';
import { MakerUpload } from '../components/MakerUpload';

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
  const [uploading, setUploading] = useState(false);
  const decimals = settings?.currency_decimals ?? 2;
  const money = (n: number) => (settings ? formatMoney(n, settings) : String(n));

  const [rows, setRows] = useState<Consignor[] | null>(null);
  const [owed, setOwed] = useState<Record<string, number>>({});
  const [editing, setEditing] = useState<Partial<Consignor> | null>(null);
  const [rateText, setRateText] = useState('30');
  /**
   * Which kind of agreement this is.
   *
   * Not every deal is a share. "Two cedis a basket, whatever you sell it for"
   * is a real agreement and expressing it as a percentage makes it a different
   * number at every price, which is exactly the confusion a written rate is
   * meant to remove. Stored as one field or the other, never both.
   */
  const [rateMode, setRateMode] = useState<'percent' | 'amount'>('percent');
  const [statementFor, setStatementFor] = useState<Consignor | null>(null);
  /** The consignor whose owed figure is being taken apart. */
  const [breakdownFor, setBreakdownFor] = useState<Consignor | null>(null);
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
    // Shown as a percentage because that is how the conversation usually
    // happens. Stored in basis points because 33.5% is a real rate and
    // floating-point money is not.
    const flat = row?.commission_flat ?? 0;
    setRateMode(flat > 0 ? 'amount' : 'percent');
    setRateText(
      flat > 0
        ? toInput(flat, decimals)
        : String((row?.commission_bp ?? settings?.default_commission_bp ?? 3000) / 100),
    );
    setError(null);
  };

  const save = async () => {
    if (!editing?.name?.trim()) { setError('Give the consignor a name.'); return; }

    let commissionBp = editing.commission_bp ?? settings?.default_commission_bp ?? 3000;
    let commissionFlat = 0;
    if (rateMode === 'amount') {
      const flat = parseMoney(rateText, decimals);
      if (flat === null || flat <= 0) { setError('Enter what the shop keeps on each piece.'); return; }
      commissionFlat = flat;
    } else {
      const rate = Number(rateText);
      if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
        setError('The commission has to be between 0 and 100 percent.');
        return;
      }
      commissionBp = Math.round(rate * 100);
    }

    setBusy(true);
    setError(null);
    try {
      const payload = {
        venue_id: editing.venue_id ?? 'main',
        // Short and human, because it goes on the label tied to every piece and
        // gets read out over a phone. Made from the name if nobody gives one.
        code: (editing.code || makerCode(editing.name)).toUpperCase().slice(0, 24),
        name: editing.name.trim(),
        phone: editing.phone?.trim() ?? '',
        email: editing.email?.trim() ?? '',
        address: editing.address?.trim() ?? '',
        commission_bp: commissionBp,
        // Zero means "the percentage applies". One field or the other, never
        // both, so nothing has to guess which was meant.
        commission_flat: commissionFlat,
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
        <div className="row" style={{ gap: '0.5rem' }}>
          {/* A shop opening its doors already has thirty of these written down
              somewhere, and the alternative is thirty forms and four commission
              rates typed wrongly. */}
          <Button onClick={() => setUploading(true)}>Upload a list</Button>
          <Button variant="primary" onClick={() => open()}>Add a consignor</Button>
        </div>
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
                      <td>
                        {(c.commission_flat ?? 0) > 0
                          ? `${money(c.commission_flat as number)} a piece`
                          : `${(c.commission_bp / 100).toFixed(c.commission_bp % 100 ? 1 : 0)}%`}
                      </td>
                      {/* Nothing owed and money owed read differently at a
                          glance, which is the only thing this column is for.
                          And the figure opens: "where did that come from" is
                          the question anybody looking at a number on a list
                          has, and a statement for a date range is the wrong
                          answer — a range can leave out the very entry that
                          explains it. */}
                      <td className="num">
                        <button
                          type="button"
                          className="link-figure"
                          onClick={() => setBreakdownFor(c)}
                          style={balance > 0 ? { fontWeight: 650 } : { opacity: 0.55 }}
                          title="What makes up this figure"
                        >
                          {money(balance)}
                        </button>
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
              placeholder={editing.name ? makerCode(editing.name) : 'AKO'}
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

          {/* Two ways of saying the same thing, and a shop uses both. The
              choice is in front of the box rather than hidden behind a
              percentage that has to be recalculated for every price. */}
          <Field
            label="What the shop keeps"
            hint="Saved onto every sale as it happens, so changing it here never rewrites what somebody has already earned."
          >
            <div className="row" style={{ gap: '0.4rem', alignItems: 'center' }}>
              <Select
                value={rateMode}
                style={{ flex: 1 }}
                onChange={(e) => {
                  const mode = e.target.value as 'percent' | 'amount';
                  setRateMode(mode);
                  // Blank rather than carried across. 30 means thirty percent
                  // in one mode and thirty pesewas in the other, and a figure
                  // that quietly changes meaning is how somebody agrees to the
                  // wrong terms.
                  setRateText(mode === 'percent' ? '30' : '');
                }}
              >
                <option value="percent">A share of each sale (%)</option>
                <option value="amount">A fixed amount per piece ({settings?.currency_symbol ?? ''})</option>
              </Select>
              <Input
                inputMode="decimal"
                style={{ width: '7rem' }}
                value={rateText}
                onChange={(e) => setRateText(e.target.value)}
              />
            </div>
          </Field>
          <p className="small dim" style={{ marginTop: '-0.4rem' }}>
            {rateMode === 'percent'
              ? 'The rest of each sale is theirs.'
              : 'The shop keeps this much per piece sold, whatever it sells for. Never more than the sale itself.'}
          </p>

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

      {uploading && settings && (
        <MakerUpload
          venueId="main"
          existing={rows ?? []}
          settings={settings}
          onClose={() => setUploading(false)}
          onDone={async (message) => {
            await load();
            toast(message);
          }}
        />
      )}

      {breakdownFor && settings && (
        <OwedBreakdown
          consignor={breakdownFor}
          settings={settings}
          onClose={() => setBreakdownFor(null)}
          onStatement={() => { setStatementFor(breakdownFor); setBreakdownFor(null); }}
        />
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

/**
 * One block of a statement: a heading, four columns, and a total.
 *
 * Written once because the four blocks are the same shape and a statement
 * whose sections are laid out four slightly different ways is a statement
 * somebody reads wrongly. Empty sections say so rather than disappearing: a
 * maker who brought nothing in this month wants to see that stated, not to
 * wonder whether the page failed to load.
 */
function StatementSection({
  title, head, rows, foot,
}: {
  title: string;
  head: [string, string, string, string];
  rows: [string, string, string, string][];
  foot: [string, string, string, string] | null;
}) {
  return (
    <>
      <h3 style={{ margin: '1.1rem 0 0.35rem', fontSize: '0.95rem' }}>{title}</h3>
      {rows.length === 0 ? (
        <p className="small dim" style={{ margin: 0 }}>Nothing in this period.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{head[0]}</th><th>{head[1]}</th>
                <th className="num">{head[2]}</th><th className="num">{head[3]}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td className="small">{r[0]}</td>
                  <td>{r[1]}</td>
                  <td className="num">{r[2]}</td>
                  <td className="num">{r[3]}</td>
                </tr>
              ))}
              {foot && (
                <tr style={{ fontWeight: 650 }}>
                  <td colSpan={2}>{foot[0]}</td>
                  <td className="num">{foot[2]}</td>
                  <td className="num">{foot[3]}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
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
  const [intakes, setIntakes] = useState<ConsignmentIntake[]>([]);
  const [unsold, setUnsold] = useState<UnsoldLine[]>([]);
  // Today, both ends, like every other date range in the admin app.
  const [from, setFrom] = useState(iso(new Date()));
  const [to, setTo] = useState(iso(new Date()));
  const [paying, setPaying] = useState(false);
  const [payText, setPayText] = useState('');
  const [payRef, setPayRef] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    ledgerFor(consignor.$id).then(setEntries).catch((e) => setError(humanError(e)));

    /**
     * The half of a statement that is not money.
     *
     * Deliveries and unsold stock never touch the balance, so they are not
     * ledger entries, but a page that only shows what sold cannot answer "so
     * what happened to the other eleven baskets", which is the question that
     * actually gets asked. Loaded alongside rather than folded into the
     * ledger, so the balance stays a sum of the ledger and nothing else.
     */
    (async () => {
      const [deliveries, products] = await Promise.all([
        listAll<ConsignmentIntake>('consignment_intakes', [Query.equal('consignor_id', consignor.$id)]),
        listAll<MenuItem>('menu_items', [Query.equal('consignor_id', consignor.$id)]),
      ]);
      setIntakes(deliveries);

      /*
        What is still standing on the shelf, and only that.

        A service is not unsold stock — there is nothing of it in the shop. Its
        count is meaningless and, before it could be marked as work, would
        have been a growing negative dragged into a real valuation. See
        craft-services.
      */
      const live = products.filter((p) => p.active !== false && hasShelf(p));
      const variants = live.length
        ? await listAll<ProductVariant>('product_variants', [
            Query.equal('menu_item_id', live.map((p) => p.$id)),
          ]).catch(() => [] as ProductVariant[])
        : [];

      const rows: UnsoldLine[] = [];
      for (const p of live) {
        const mine = variants.filter((v) => v.menu_item_id === p.$id);
        const qty = onHandFor(p, mine);
        if (qty <= 0) continue;
        const bp = rateFor(p, consignor, settings);
        const flat = flatFor(p, consignor);
        // With sizes each one has its own price, so the value is summed size by
        // size rather than taken off a price the shop never charges.
        const value = mine.filter((v) => v.active).length
          ? mine.filter((v) => v.active).reduce((n, v) => n + dueFor(v.price, bp, flat) * (v.on_hand ?? 0), 0)
          : dueFor(p.price, bp, flat) * qty;
        rows.push({ name: p.name, qty, value });
      }
      setUnsold(rows.sort((a, b) => a.name.localeCompare(b.name)));
    })().catch(() => undefined);
  }, [consignor.$id]);

  const statement: Statement<Consignor> | null = useMemo(() => {
    if (!entries) return null;
    return buildStatement(consignor, entries, new Date(from), new Date(to), { intakes, unsold });
  }, [entries, consignor, from, to, intakes, unsold]);

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
      // The payment is written here; the line that moves the balance is written
      // by the server, because nothing in a browser may write to the ledger.
      // This waits a few seconds for that rather than reporting a payment whose
      // effect has not landed.
      const { postedToLedger } = await recordPayout({
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
      await onPaid(
        postedToLedger
          ? `${money(amount)} recorded as paid to ${consignor.name}`
          : `${money(amount)} recorded. The balance is still catching up, reopen this in a minute.`,
      );
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
      {/* The dates open on today. A statement is usually wanted for the month,
          so that is one tap rather than two date pickers. */}
      <div className="row row-wrap" style={{ gap: '0.4rem', marginBottom: '0.8rem' }}>
        <Button size="sm" onClick={() => { setFrom(iso(startOfMonth(new Date()))); setTo(iso(new Date())); }}>
          This month
        </Button>
        <Button
          size="sm"
          onClick={() => {
            const first = startOfMonth(new Date());
            const lastMonth = new Date(first);
            lastMonth.setMonth(lastMonth.getMonth() - 1);
            setFrom(iso(startOfMonth(lastMonth)));
            // The day before this month began, which is the last day of the
            // one before it however many days that month happened to have.
            setTo(iso(new Date(first.getTime() - 86400_000)));
          }}
        >
          Last month
        </Button>
      </div>

      {statement === null ? (
        <Spinner />
      ) : (
        <>
          {/* Four questions in the order a maker asks them: what did I bring
              you, what has sold, what have you paid me, what is left. The
              shop's own margin is not among them, it was agreed at intake and
              signed for on the delivery slip, and repeating it beside every
              line turns a settlement into a fresh negotiation. */}
          <div className="stat-row">
            <div className="stat">
              <div className="label">Brought in</div>
              <div className="value">{statement.broughtIn.pieces}</div>
            </div>
            <div className="stat">
              <div className="label">Sold</div>
              <div className="value">{statement.soldCount}</div>
            </div>
            <div className="stat">
              <div className="label">They earned</div>
              <div className="value">{money(statement.earned)}</div>
            </div>
            <div className="stat">
              <div className="label">Still to sell</div>
              <div className="value">{statement.unsold.pieces}</div>
            </div>
          </div>

          <StatementSection
            title="What they brought in"
            head={['Date', 'Delivery', 'Pieces', 'Worth to them']}
            rows={statement.broughtIn.lines.map((l) => [
              new Date(l.at).toLocaleDateString(), l.reference, String(l.pieces),
              l.value ? money(l.value) : '',
            ])}
            foot={[
              `${statement.broughtIn.pieces} piece${statement.broughtIn.pieces === 1 ? '' : 's'}`,
              '', '', money(statement.broughtIn.value),
            ]}
          />

          <StatementSection
            title="What has sold"
            head={['Date', 'Piece', 'Qty', 'Theirs']}
            rows={statement.sold.map((l) => [
              new Date(l.at).toLocaleDateString(), l.description, l.qty ? String(l.qty) : '', money(l.amount),
            ])}
            foot={[
              `${statement.soldCount} piece${statement.soldCount === 1 ? '' : 's'}`,
              '', '', money(statement.earned),
            ]}
          />

          <StatementSection
            title="What they have been paid"
            head={['Date', 'How', '', 'Paid']}
            rows={statement.payments.map((l) => [
              new Date(l.at).toLocaleDateString(), l.description, '', money(Math.abs(l.amount)),
            ])}
            foot={['Paid in this period', '', '', money(statement.paidOut)]}
          />

          {statement.other.length > 0 && (
            <StatementSection
              title="Adjustments"
              head={['Date', 'What', '', 'Amount']}
              rows={statement.other.map((l) => [
                new Date(l.at).toLocaleDateString(), l.description, '', money(l.amount),
              ])}
              foot={null}
            />
          )}

          <StatementSection
            title="Still to sell"
            head={['Piece', '', 'Left', 'Worth to them']}
            rows={statement.unsold.lines.map((l) => [l.name, '', String(l.qty), money(l.value)])}
            foot={[
              `${statement.unsold.pieces} piece${statement.unsold.pieces === 1 ? '' : 's'} on the shelf`,
              '', '', money(statement.unsold.value),
            ]}
          />

          <div className="table-wrap" style={{ marginTop: '1rem' }}>
            <table>
              <tbody>
                <tr>
                  <td>Owed at {new Date(from).toLocaleDateString()}</td>
                  <td className="num">{money(statement.openingBalance)}</td>
                </tr>
                <tr>
                  <td>Earned in this period</td>
                  <td className="num">{money(statement.earned)}</td>
                </tr>
                {statement.adjustments !== 0 && (
                  <tr><td>Adjustments</td><td className="num">{money(statement.adjustments)}</td></tr>
                )}
                <tr>
                  <td>Paid to them</td>
                  <td className="num">{statement.paidOut ? `− ${money(statement.paidOut)}` : money(0)}</td>
                </tr>
                <tr>
                  <td style={{ fontWeight: 650 }}>Owed at {new Date(to).toLocaleDateString()}</td>
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

/**
 * What makes up the figure on the list.
 *
 * Every entry there has ever been, newest first, with a running balance — and
 * the balance on the top row equals the number that was clicked, by
 * construction rather than by coincidence, because both are the same sum.
 *
 * Deliberately not a date range. The statement already does periods, and a
 * range is the wrong answer to "where did that come from": it can exclude the
 * very entry that explains the figure, and then the two screens disagree with
 * nothing to say which is right.
 */
function OwedBreakdown({
  consignor, settings, onClose, onStatement,
}: {
  consignor: Consignor;
  settings: Settings;
  onClose: () => void;
  onStatement: () => void;
}) {
  const [entries, setEntries] = useState<LedgerEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const money = (n: number) => formatMoney(n, settings);

  useEffect(() => {
    ledgerFor(consignor.$id).then(setEntries).catch((e) => setError(humanError(e)));
  }, [consignor.$id]);

  const { lines, balance } = useMemo(() => owedBreakdown(entries ?? []), [entries]);

  return (
    <Modal
      wide
      title={`What ${consignor.name} is owed`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onStatement}>Open the statement</Button>
          <Button variant="primary" onClick={onClose}>Close</Button>
        </>
      }
    >
      {error && <Notice>{error}</Notice>}
      {!entries ? <Spinner /> : lines.length === 0 ? (
        <Empty title="Nothing on their account yet">
          Entries appear here as their work sells, and when they are paid.
        </Empty>
      ) : (
        <>
          <div className="spread" style={{ marginBottom: '0.7rem' }}>
            <span className="dim small">{lines.length} entries, oldest {new Date(lines[lines.length - 1].entry.entry_at).toLocaleDateString()}</span>
            <span style={{ fontSize: '1.3rem', fontWeight: 650 }}>{money(balance)}</span>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>When</th><th>What</th><th>Detail</th>
                  <th className="num">Amount</th><th className="num">Owed after</th>
                </tr>
              </thead>
              <tbody>
                {lines.map(({ entry, runningBalance }: OwedLine, i: number) => (
                  <tr key={`${entry.entry_at}-${i}`}>
                    <td className="dim small">{new Date(entry.entry_at).toLocaleDateString()}</td>
                    <td>
                      <Badge tone={entry.amount < 0 ? 'ok' : 'default'}>{labelForKind(entry.kind)}</Badge>
                    </td>
                    <td className="small dim">{entry.description || '—'}</td>
                    {/* A payout reduces what is owed, and reads as a negative
                        here. Signed rather than coloured alone: a column of
                        figures where only the colour differs is one somebody
                        misreads on a phone, in sunlight, in a hurry. */}
                    <td className="num" style={entry.amount < 0 ? { color: 'var(--ok, #3f8f5f)' } : undefined}>
                      {entry.amount < 0 ? `−${money(Math.abs(entry.amount))}` : money(entry.amount)}
                    </td>
                    <td className="num dim">{money(runningBalance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small dim" style={{ marginBottom: 0 }}>
            Every entry there has ever been, so the running balance on the top row is the figure on the list.
            The statement covers a period and can be printed for them.
          </p>
        </>
      )}
    </Modal>
  );
}
