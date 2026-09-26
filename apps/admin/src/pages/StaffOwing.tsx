import { Fragment, useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, Empty, Field, Input, Modal, Notice, Segmented, Select, Spinner, useToast } from '@snpos/ui';
import { humanError } from '../lib';
import {
  loadStaffCharges, loadSettlements, settleCharge, owingByPerson, owingTotals, chargeLeft, settleProblem, foundAmount,
  SETTLE_WORDS, loadOpenShifts, loadPaymentMethods, parseMoney, toInput, dateTimeWords, waitedWords, MODULE_LABELS,
} from '@snpos/core';
import type { StaffCharge, StaffSettlement, SettleKind, Module } from '@snpos/core';
import { useSession, useMoney } from '../session';

type Show = 'owed' | 'settled' | 'all';
type OpenShift = { $id: string; code?: string; module?: string };

/**
 * Count differences charged to a person, and what has been done about each.
 *
 * A charge is made from a short line on Waiting for you: the shelf is put
 * right there and then, and what the missing stock was worth is owed here
 * until it is paid in cash, taken from pay, found, or written off. The rules
 * are in core, see staff-charges.ts.
 */
export function StaffOwingPage() {
  const { user, profile } = useSession();
  const money = useMoney();
  const toast = useToast();
  const isAdmin = profile?.role === 'admin';

  const [charges, setCharges] = useState<StaffCharge[] | null>(null);
  const [settlements, setSettlements] = useState<StaffSettlement[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [show, setShow] = useState<Show>('owed');
  const [openPerson, setOpenPerson] = useState<string | null>(null);
  const [settling, setSettling] = useState<StaffCharge | null>(null);

  const load = async () => {
    setError(null);
    try {
      const rows = await loadStaffCharges('main');
      setCharges(rows);
      setSettlements(await loadSettlements(rows.map((c) => c.$id)));
    } catch (e) {
      setError(humanError(e));
      setCharges([]);
    }
  };
  useEffect(() => { void load(); }, []);

  const monthStart = useMemo(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
  }, []);
  const totals = charges ? owingTotals(charges, settlements, monthStart) : null;
  const shown = (charges ?? []).filter((c) =>
    show === 'all' ? true : show === 'owed' ? chargeLeft(c) > 0 : chargeLeft(c) === 0);
  const people = owingByPerson(shown);
  const now = Date.now();

  return (
    <>
      <div className="spread">
        <div>
          <h1>Staff owing</h1>
          <p className="dim small" style={{ margin: '0.2rem 0 0' }}>
            Count differences charged to a person, and what has been done about each. Charge a short line from
            Waiting for you.
          </p>
        </div>
        <Segmented<Show>
          value={show}
          onChange={setShow}
          ariaLabel="Which charges"
          options={[{ value: 'owed', label: 'Still owed' }, { value: 'settled', label: 'Settled' }, { value: 'all', label: 'All' }]}
        />
      </div>

      {error && <Notice>{error}</Notice>}

      {totals && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(12rem, 1fr))', gap: '1rem', margin: '1rem 0' }}>
          <Card><div className="small dim">Still owed</div><div style={{ fontSize: '1.6rem', fontWeight: 700 }}>{money(totals.owed)}</div></Card>
          <Card><div className="small dim">People owing</div><div style={{ fontSize: '1.6rem', fontWeight: 700 }}>{totals.people}</div></Card>
          <Card><div className="small dim">Put right this month</div><div style={{ fontSize: '1.6rem', fontWeight: 700 }}>{money(totals.putRightThisMonth)}</div></Card>
        </div>
      )}

      <Card pad={false}>
        {!charges ? <Spinner /> : people.length === 0 ? (
          <Empty title={show === 'owed' ? 'Nobody owes anything' : 'Nothing here'}>
            A short line on a count can be charged to a person from Waiting for you.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Person</th><th>Oldest open</th><th className="num">Charged</th><th className="num">Put right</th><th className="num">Still owed</th></tr>
              </thead>
              <tbody>
                {people.map((p) => {
                  const open = openPerson === p.personId;
                  return (
                    <Fragment key={p.personId}>
                      <tr>
                        <td>
                          <button type="button" className="linky" onClick={() => setOpenPerson(open ? null : p.personId)} style={{ fontWeight: 600 }}>
                            {open ? '▾' : '▸'} {p.name}
                          </button>
                          <div className="small dim">
                            {p.open > 0 && `${p.open} open`}{p.open > 0 && p.settledCount > 0 && ', '}{p.settledCount > 0 && `${p.settledCount} settled`}
                          </div>
                        </td>
                        <td className="small dim">{p.oldestOpen ? waitedWords(now - Date.parse(p.oldestOpen)) : '—'}</td>
                        <td className="num">{money(p.charged)}</td>
                        <td className="num">{money(p.settled)}</td>
                        <td className="num" style={{ fontWeight: 650 }}>{money(p.left)}</td>
                      </tr>
                      {open && (
                        <tr>
                          <td colSpan={5} style={{ background: 'var(--surface-2, rgba(0,0,0,0.02))' }}>
                            <table className="data">
                              <thead>
                                <tr><th>Charged</th><th>What</th><th>From</th><th className="num">Charged</th><th className="num">Put right</th><th className="num">Left</th><th>State</th><th /></tr>
                              </thead>
                              <tbody>
                                {p.charges.map((c) => {
                                  const done = settlements.filter((s) => s.charge_id === c.$id);
                                  const left = chargeLeft(c);
                                  return (
                                    <tr key={c.$id}>
                                      <td className="small dim">{dateTimeWords(c.charged_at)}</td>
                                      <td>
                                        <strong>{c.item_name}</strong> × {c.qty}
                                        <div className="small dim">at {money(c.unit_price)}, {c.price_basis === 'cost' ? 'cost' : c.price_basis === 'custom' ? 'a price set by hand' : 'selling price'}</div>
                                        {c.note && <div className="small dim">&ldquo;{c.note}&rdquo;</div>}
                                      </td>
                                      <td className="small dim">
                                        {c.source === 'shop_count' ? 'Shop stocktake' : `${MODULE_LABELS[(c.module ?? 'bar') as Module]} count`}
                                      </td>
                                      <td className="num">{money(c.amount)}</td>
                                      <td className="num">{money(c.amount - left)}</td>
                                      <td className="num" style={{ fontWeight: 600 }}>{money(left)}</td>
                                      <td>
                                        {left === 0 ? (
                                          <Badge tone="ok">{done.length === 1 ? SETTLE_WORDS[done[0]!.kind] : 'Settled'}</Badge>
                                        ) : left < c.amount ? <Badge tone="warn">Part put right</Badge> : <Badge tone="danger">Open</Badge>}
                                      </td>
                                      <td className="num">
                                        {left > 0 && (isAdmin
                                          ? <Button size="sm" variant="primary" onClick={() => setSettling(c)}>Put right</Button>
                                          : <span className="small dim">An admin records this</span>)}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {settling && (
        <SettleModal
          charge={settling}
          history={settlements.filter((s) => s.charge_id === settling.$id)}
          isAdmin={isAdmin}
          userId={user?.$id ?? ''}
          money={money}
          onClose={() => setSettling(null)}
          onDone={async (words) => {
            setSettling(null);
            toast(words);
            await load();
          }}
        />
      )}
    </>
  );
}

function SettleModal({ charge, history, isAdmin, userId, money, onClose, onDone }: {
  charge: StaffCharge;
  history: StaffSettlement[];
  isAdmin: boolean;
  userId: string;
  money: (n: number) => string;
  onClose: () => void;
  onDone: (words: string) => Promise<void>;
}) {
  const left = chargeLeft(charge);
  const [kind, setKind] = useState<SettleKind>('cash');
  const [amountText, setAmountText] = useState(toInput(left));
  const [qtyText, setQtyText] = useState('');
  const [note, setNote] = useState('');
  const [shifts, setShifts] = useState<OpenShift[] | null>(null);
  const [shiftId, setShiftId] = useState('');
  const [cashMethod, setCashMethod] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const sides: Module[] = ['bar', 'kitchen', 'craft'];
      const [open, methods] = await Promise.all([
        Promise.all(sides.map((m) => loadOpenShifts('main', m).catch(() => []))).then((a) => a.flat()),
        loadPaymentMethods('main').catch(() => []),
      ]);
      const unique = [...new Map(open.map((s) => [s.$id, s])).values()] as OpenShift[];
      setShifts(unique);
      // Where the charge came from first: the bar's drawer for a bar count.
      setShiftId((unique.find((s) => (s.module ?? 'kitchen') === charge.module) ?? unique[0])?.$id ?? '');
      setCashMethod(methods.find((m) => m.kind === 'cash')?.$id ?? '');
    })();
  }, [charge.module]);

  const qty = Number(qtyText);
  const amount = kind === 'found' ? foundAmount(Number.isFinite(qty) ? qty : 0, charge.unit_price, left) : parseMoney(amountText) ?? 0;
  const problem = settleProblem({ kind, amount, left, isAdmin, note, qtyFound: kind === 'found' ? qty : undefined, charged: charge.qty })
    ?? (kind === 'cash' && !shiftId ? 'No shift is open, so there is no drawer to put the cash in. Open one first.' : null)
    ?? (kind === 'cash' && !cashMethod ? 'There is no cash payment method to count it under.' : null);

  const save = async () => {
    if (problem) { setError(problem); return; }
    setBusy(true);
    setError(null);
    try {
      const done = await settleCharge({
        venueId: 'main', chargeId: charge.$id, kind, amount,
        qtyFound: kind === 'found' ? qty : undefined,
        shiftId: kind === 'cash' ? shiftId : undefined,
        methodId: kind === 'cash' ? cashMethod : undefined,
        note, userId, isAdmin,
      });
      await onDone(`${SETTLE_WORDS[kind]}: ${money(done.settled)}. ${done.left > 0 ? `${money(done.left)} still owed.` : 'Nothing left owed.'}`);
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  const option = (k: SettleKind, words: string) => (
    <label className="row" style={{ alignItems: 'flex-start', gap: '0.6rem', padding: '0.6rem 0.8rem', border: '1px solid var(--line, #d5dbe0)', borderRadius: 10, cursor: 'pointer', background: kind === k ? 'var(--accent-soft, #eef6f3)' : undefined }}>
      <input type="radio" name="settle-kind" checked={kind === k} onChange={() => { setKind(k); setError(null); }} style={{ marginTop: '0.25rem' }} />
      <span><strong>{SETTLE_WORDS[k]}</strong><div className="small dim">{words}</div></span>
    </label>
  );

  return (
    <Modal
      title={`Put right · ${charge.person_name}`}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!!problem} onClick={() => void save()}>
            {kind === 'found' ? `Record ${Number.isFinite(qty) && qty > 0 ? qty : ''} found` : `Record ${money(amount)} ${SETTLE_WORDS[kind].toLowerCase()}`}
          </Button>
        </>
      )}
    >
      <p style={{ marginTop: 0 }}>
        {charge.item_name} × {charge.qty}, {dateTimeWords(charge.charged_at)}. <strong>{money(left)}</strong> still owed.
      </p>
      <div style={{ display: 'grid', gap: '0.5rem' }}>
        {option('cash', 'Goes into the drawer of an open shift, so that drawer expects it at close.')}
        {option('pay', 'Kept back from their pay. Nothing goes into a drawer.')}
        {option('found', 'Some turned up. They go back on the shelf and are taken off what is owed.')}
        {isAdmin && option('written_off', 'The business takes the loss. Say why.')}
      </div>

      <div style={{ marginTop: '0.8rem', display: 'grid', gap: '0.6rem' }}>
        {kind === 'found' ? (
          <Field label="How many turned up" hint={qty > 0 ? `${money(amount)} off what is owed.` : `Up to ${charge.qty}.`}>
            <Input value={qtyText} inputMode="decimal" onChange={(e) => { setQtyText(e.target.value); setError(null); }} />
          </Field>
        ) : (
          <Field label="Amount" hint={amount > 0 && amount < left ? `${money(left - amount)} left after this.` : undefined}>
            <Input value={amountText} inputMode="decimal" onChange={(e) => { setAmountText(e.target.value); setError(null); }} />
          </Field>
        )}
        {kind === 'cash' && (
          <Field label="Into which drawer">
            {shifts === null ? <Spinner /> : shifts.length === 0 ? (
              <span className="small dim">No shift is open.</span>
            ) : (
              <Select value={shiftId} onChange={(e) => setShiftId(e.target.value)}>
                {shifts.map((s) => (
                  <option key={s.$id} value={s.$id}>{MODULE_LABELS[(s.module ?? 'kitchen') as Module]} · {s.code ?? s.$id}</option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <Field label={kind === 'written_off' ? 'Why' : 'Note (optional)'}>
          <Input value={note} onChange={(e) => { setNote(e.target.value); setError(null); }} />
        </Field>
      </div>

      {error && <Notice>{error}</Notice>}

      <h3 style={{ marginBottom: '0.3rem' }}>History</h3>
      <div className="small">
        <div>{dateTimeWords(charge.charged_at)} · Charged · {charge.qty} × {money(charge.unit_price)} · {money(charge.amount)}</div>
        {history.map((h) => (
          <div key={h.$id}>
            {dateTimeWords(h.recorded_at)} · {SETTLE_WORDS[h.kind]}{h.kind === 'found' && h.qty_found ? ` (${h.qty_found})` : ''} · {money(h.amount)}
            {h.note && <span className="dim"> · &ldquo;{h.note}&rdquo;</span>}
          </div>
        ))}
      </div>
    </Modal>
  );
}
