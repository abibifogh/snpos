import { useEffect, useState } from 'react';
import { Badge, Button, Card, Empty, Field, Input, Select, Spinner, ExpenseModal } from '@snpos/ui';
import {
  loadOwedSpends, payOwedSpend, stillOwed, leftToPay, dueOf, payProblem, ageBuckets, daysLate,
  payFromAccounts, parseMoney, toInput, writeXlsx, XLSX_TYPE, downloadFile, humanError, MODULE_LABELS, modulesOf,
} from '@snpos/core';
import type { OwedSpend, AccountRow, Settings, Module, AgeBuckets } from '@snpos/core';

const today = () => new Date().toISOString().slice(0, 10);
const at = (d: string) => new Date(`${d}T12:00:00`);

/** The four age bands, the same on both sides of the books. */
export function AgeBands({ b, money }: { b: AgeBuckets; money: (n: number) => string }) {
  const cells: [string, number, boolean][] = [
    ['Not yet due', b.current, false], ['1–30 days', b.d30, false], ['31–60 days', b.d60, false], ['Over 60 days', b.over, b.over > 0],
  ];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(8rem, 1fr))', gap: '0.5rem', marginBottom: '0.8rem' }}>
      {cells.map(([label, v, late]) => (
        <div key={label} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '0.5rem 0.7rem' }}>
          <div className="small dim">{label}</div>
          <div style={{ fontWeight: 650, fontVariantNumeric: 'tabular-nums', color: late ? 'var(--danger, #a3271f)' : undefined }}>{money(v)}</div>
        </div>
      ))}
    </div>
  );
}

/**
 * Bills to pay: every invoice recorded as not paid yet, stock or not, by
 * when it is due. Each is paid here, in full or in parts, from the bank or
 * cash; that is when the books move it out of Accounts payable.
 */
export function BillsToPay({ venueId, userId, accounts, money, settings, onChanged, toast }: {
  venueId: string;
  userId: string;
  accounts: AccountRow[];
  money: (n: number) => string;
  settings: Settings | null;
  onChanged: () => Promise<void>;
  toast: (m: string, t?: 'ok' | 'err') => void;
}) {
  const [rows, setRows] = useState<OwedSpend[] | null>(null);
  const [paying, setPaying] = useState<string | null>(null);
  const [form, setForm] = useState({ amount: '', via: '1040', date: today(), ref: '' });
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const decimals = settings?.currency_decimals ?? 2;
  const mods = modulesOf(settings);
  const sides = (['kitchen', 'bar', 'craft'] as Module[]).filter((m) => mods[m]);
  const [side, setSide] = useState<Module>(sides[0] ?? 'kitchen');
  const from = payFromAccounts(accounts);

  const load = () => loadOwedSpends().then(setRows).catch(() => setRows([]));
  useEffect(() => { void load(); }, []);

  const owed = stillOwed(rows ?? []);
  const now = today();
  const bands = ageBuckets(owed.map((r) => ({ amount: leftToPay(r), due: dueOf(r) })), now);

  const open = (r: OwedSpend) => {
    setPaying(r.$id);
    setForm({ amount: toInput(leftToPay(r), decimals), via: from[0]?.code ?? '1040', date: today(), ref: '' });
  };

  const pay = async (r: OwedSpend) => {
    const amount = parseMoney(form.amount, decimals) ?? 0;
    setBusy(true);
    try {
      await payOwedSpend({ venueId, spend: r, via: form.via === '1040' ? 'bank' : form.via === '1000' ? 'cash' : form.via, date: at(form.date), amount, reference: form.ref, userId });
      setPaying(null);
      await load();
      await onChanged();
      toast(`${money(amount)} paid to ${r.payee || 'the supplier'}.`);
    } catch (e) {
      toast(humanError(e), 'err');
    } finally {
      setBusy(false);
    }
  };

  const exportXlsx = () => {
    const m = (n: number) => Math.round(n) / 10 ** decimals;
    const sheet = [['Supplier', 'Received', 'Due', 'Days late', 'Amount', 'Paid', 'Left to pay'],
      ...owed.map((r) => [r.payee || '', (r.$createdAt ?? '').slice(0, 10), dueOf(r), daysLate(dueOf(r), now), m(r.amount), m(r.paid_amount ?? 0), m(leftToPay(r))])];
    downloadFile(`Bills to pay ${now}.xlsx`, writeXlsx([{ name: 'Bills to pay', rows: sheet }]).buffer as ArrayBuffer, XLSX_TYPE);
  };

  return (
    <Card title={`Bills to pay${bands.total ? ` · ${money(bands.total)}` : ''}`} pad
      help={
        <>
          Rent, power, a repair or a delivery on account: anything recorded as not paid yet, until it is paid.
          Stock received as not paid yet is here too.
        </>
      }
    >
      <div className="row row-wrap" style={{ gap: '0.5rem', alignItems: 'flex-end', marginBottom: '0.8rem' }}>
        {sides.length > 1 && (
          <Field label="For">
            <Select value={side} onChange={(e) => setSide(e.target.value as Module)}>
              {sides.map((m) => <option key={m} value={m}>{MODULE_LABELS[m]}</option>)}
            </Select>
          </Field>
        )}
        <Button variant="primary" onClick={() => setAdding(true)} disabled={!settings}>Add a bill</Button>
        <Button onClick={exportXlsx} disabled={owed.length === 0}>Excel</Button>
      </div>
      <AgeBands b={bands} money={money} />
      {rows === null ? <Spinner /> : owed.length === 0 ? (
        <Empty title="Nothing owed to suppliers">Add a bill when an invoice comes in that is paid later.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Supplier</th><th>Due</th><th className="num">Amount</th><th className="num">Paid</th><th className="num">Left to pay</th><th /></tr></thead>
            <tbody>
              {owed.map((r) => {
                const late = daysLate(dueOf(r), now);
                const amount = parseMoney(form.amount, decimals) ?? 0;
                const why = paying === r.$id ? payProblem(r, form.via, amount) : null;
                return [
                  <tr key={r.$id}>
                    <td>
                      {r.payee || 'A supplier'}
                      <div className="small dim">received {(r.$createdAt ?? '').slice(0, 10)}{r.approval_status === 'pending' ? ' · not yet approved' : ''}</div>
                    </td>
                    <td>
                      {dueOf(r)}
                      {late > 0 && <div><Badge tone={late > 30 ? 'danger' : 'warn'}>{late} days late</Badge></div>}
                    </td>
                    <td className="num">{money(r.amount)}</td>
                    <td className="num dim">{r.paid_amount ? money(r.paid_amount) : '–'}</td>
                    <td className="num" style={{ fontWeight: 600 }}>{money(leftToPay(r))}</td>
                    <td className="num">
                      {paying === r.$id
                        ? <Button size="sm" variant="ghost" onClick={() => setPaying(null)}>Cancel</Button>
                        : <Button size="sm" onClick={() => open(r)}>Pay</Button>}
                    </td>
                  </tr>,
                  paying === r.$id && (
                    <tr key={`${r.$id}-pay`}>
                      <td colSpan={6}>
                        <div className="row row-wrap" style={{ gap: '0.5rem', alignItems: 'flex-end' }}>
                          <Field label="Amount paid" hint="Less than what is left pays it in part.">
                            <Input value={form.amount} inputMode="decimal" onChange={(e) => setForm({ ...form, amount: e.target.value })} />
                          </Field>
                          <Field label="Paid from">
                            <Select value={form.via} onChange={(e) => setForm({ ...form, via: e.target.value })}>
                              {from.map((a) => <option key={a.code} value={a.code}>{a.name}</option>)}
                            </Select>
                          </Field>
                          <Field label="Date"><Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></Field>
                          <Field label="Reference (optional)"><Input value={form.ref} onChange={(e) => setForm({ ...form, ref: e.target.value })} /></Field>
                          <Button variant="primary" loading={busy} disabled={busy || !!why} onClick={() => void pay(r)}>Record payment</Button>
                        </div>
                        {why && form.amount && <div className="small dim">{why}</div>}
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table>
        </div>
      )}
      {adding && settings && (
        <ExpenseModal
          bill
          desk="office"
          module={side}
          venueId={venueId || 'main'}
          shiftId=""
          settings={settings}
          userId={userId}
          onClose={() => setAdding(false)}
          onDone={(m) => {
            setAdding(false);
            toast(m);
            void load();
            void onChanged();
          }}
        />
      )}
    </Card>
  );
}
