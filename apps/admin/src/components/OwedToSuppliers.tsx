import { useEffect, useState } from 'react';
import { Button, Card, Field, Input, Select } from '@snpos/ui';
import {
  loadOwedSpends, payOwedSpend, stillOwed, owedBySupplier, payProblem, PAY_VIA_WORDS,
  dateWords, humanError,
} from '@snpos/core';
import type { OwedSpend, PayVia } from '@snpos/core';

const today = () => new Date().toISOString().slice(0, 10);
const at = (d: string) => new Date(`${d}T12:00:00`);

/**
 * Stock received and not yet paid for, and paying it.
 *
 * Each row is a delivery Receive stock recorded as "not paid yet". Paying it
 * here is what moves the books: owed to suppliers down, the bank or the
 * cash down. See owed-spends.ts.
 */
export function OwedToSuppliers({ userId, venueId, money, onChanged, toast }: {
  userId: string;
  venueId: string;
  money: (n: number) => string;
  onChanged: () => Promise<void>;
  toast: (m: string, t?: 'ok' | 'err') => void;
}) {
  const [rows, setRows] = useState<OwedSpend[] | null>(null);
  const [form, setForm] = useState<Record<string, { via: PayVia; date: string; ref: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = () => loadOwedSpends().then(setRows).catch(() => setRows([]));
  useEffect(() => { void load(); }, []);

  const owed = stillOwed(rows ?? []);
  // Nothing on account and never was: nothing to show.
  if (rows !== null && owed.length === 0) return null;

  const by = owedBySupplier(rows ?? []);
  const total = by.reduce((n, b) => n + b.amount, 0);

  return (
    <Card title={`Owed to suppliers${total ? ` · ${money(total)}` : ''}`} pad>
      <p className="small dim" style={{ marginTop: 0 }}>
        Stock received as not paid yet. Record each payment when it is made: that is when the books take it out of
        the bank or the cash.
        {by.length > 1 && <> {by.map((b) => `${b.payee} ${money(b.amount)}`).join(' · ')}.</>}
      </p>
      {owed.map((s) => {
        const f = form[s.$id] ?? { via: 'bank' as PayVia, date: today(), ref: '' };
        const why = payProblem(s, f.via);
        return (
          <div key={s.$id} style={{ borderTop: '1px solid var(--border)', padding: '0.6rem 0', display: 'grid', gap: '0.4rem' }}>
            <div>
              <strong>{money(s.amount)}</strong> to {s.payee || 'a supplier'}
              <span className="small dim"> · received {s.$createdAt ? dateWords(s.$createdAt) : ''}</span>
              {s.approval_status === 'pending' && <span className="small dim"> · not yet approved</span>}
            </div>
            <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <Field label="Paid">
                <Select value={f.via} onChange={(e) => setForm({ ...form, [s.$id]: { ...f, via: e.target.value as PayVia } })}>
                  {(Object.keys(PAY_VIA_WORDS) as PayVia[]).map((v) => <option key={v} value={v}>{PAY_VIA_WORDS[v]}</option>)}
                </Select>
              </Field>
              <Field label="Date">
                <Input type="date" value={f.date} onChange={(e) => setForm({ ...form, [s.$id]: { ...f, date: e.target.value } })} />
              </Field>
              <Field label="Reference (optional)">
                <Input value={f.ref} onChange={(e) => setForm({ ...form, [s.$id]: { ...f, ref: e.target.value } })} />
              </Field>
              <Button
                variant="primary"
                loading={busy === s.$id}
                disabled={!!busy || !!why}
                onClick={() => void (async () => {
                  setBusy(s.$id);
                  try {
                    await payOwedSpend({ venueId, spend: s, via: f.via, date: at(f.date), reference: f.ref, userId });
                    await load();
                    await onChanged();
                    toast(`${money(s.amount)} paid to ${s.payee || 'the supplier'}.`);
                  } catch (e) {
                    toast(humanError(e), 'err');
                  } finally {
                    setBusy(null);
                  }
                })()}
              >
                Record payment
              </Button>
            </div>
          </div>
        );
      })}
    </Card>
  );
}
