import { useEffect, useState } from 'react';
import { Button, Card, Field, Input, Notice, Select } from '@snpos/ui';
import {
  loadCashMoves, confirmBanked, bankFromSafe, awaitingBank, safeBalance, bankingProblem,
  parseMoney, toInput, dateTimeWords, humanError,
} from '@snpos/core';
import type { CashMove } from '@snpos/core';

const today = () => new Date().toISOString().slice(0, 10);
const at = (d: string) => new Date(`${d}T12:00:00`);

/**
 * Cash to the bank, confirmed with the slip.
 *
 * Two queues, both from the close's answer to "where is the cash going?":
 * cash taken to the bank, waiting for somebody here to say it arrived, and
 * cash sitting in the safe, waiting to be paid in. Confirming is what moves
 * the books — cash on hand down, bank up — dated the day it was paid in.
 * See cash-away.ts.
 */
export function CashToBank({ venueId, userId, money, decimals, onChanged, toast, banks = [] }: {
  /** The bank accounts and wallets it can go into. One or none: the bank account. */
  banks?: { code: string; name: string }[];
  venueId: string;
  userId: string;
  money: (n: number) => string;
  decimals: number;
  onChanged: () => Promise<void>;
  toast: (m: string, t?: 'ok' | 'err') => void;
}) {
  const [moves, setMoves] = useState<CashMove[] | null>(null);
  const [text, setText] = useState<Record<string, { amount: string; date: string; ref: string }>>({});
  const [safe, setSafe] = useState({ amount: '', date: today(), ref: '', by: '' });
  const [busy, setBusy] = useState<string | null>(null);
  const [into, setInto] = useState('1040');
  const choose = banks.length > 1 && (
    <Field label="Paid into">
      <Select value={into} onChange={(e) => setInto(e.target.value)}>
        {banks.map((b) => <option key={b.code} value={b.code}>{b.name}</option>)}
      </Select>
    </Field>
  );

  const load = () => loadCashMoves(venueId).then(setMoves).catch(() => setMoves([]));
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [venueId]);

  const pending = awaitingBank(moves ?? []);
  const inSafe = safeBalance(moves ?? []);
  const field = (m: CashMove) => text[m.$id] ?? { amount: toInput(m.amount, decimals), date: today(), ref: '' };

  const run = async (key: string, work: () => Promise<void>, done: string) => {
    setBusy(key);
    try {
      await work();
      await load();
      await onChanged();
      toast(done);
    } catch (e) {
      toast(humanError(e), 'err');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card title="Cash to the bank" pad>
      <p className="small dim" style={{ marginTop: 0 }}>
        Each close says how much cash went into the safe or to the bank. Confirm it here when the bank slip is in
        hand: that is when the books move it from cash on hand into the bank.
      </p>
      {moves === null ? null : pending.length === 0 && inSafe <= 0 ? (
        <p className="small" style={{ margin: 0 }}>Nothing waiting. No cash is in the safe or on its way to the bank.</p>
      ) : null}

      {pending.map((m) => {
        const f = field(m);
        const amount = parseMoney(f.amount, decimals) ?? 0;
        const why = bankingProblem(amount);
        return (
          <div key={m.$id} style={{ borderTop: '1px solid var(--border)', padding: '0.6rem 0', display: 'grid', gap: '0.4rem' }}>
            <div>
              <strong>{money(m.amount)}</strong> taken to the bank
              {m.shift_code ? ` from ${m.shift_code}` : ''}{m.taken_by ? ` by ${m.taken_by}` : ''}
              <span className="small dim"> · {m.$createdAt ? dateTimeWords(m.$createdAt) : ''}</span>
            </div>
            <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <Field label="Amount paid in">
                <Input value={f.amount} inputMode="decimal" onChange={(e) => setText({ ...text, [m.$id]: { ...f, amount: e.target.value } })} />
              </Field>
              <Field label="Date">
                <Input type="date" value={f.date} onChange={(e) => setText({ ...text, [m.$id]: { ...f, date: e.target.value } })} />
              </Field>
              <Field label="Slip reference (optional)">
                <Input value={f.ref} onChange={(e) => setText({ ...text, [m.$id]: { ...f, ref: e.target.value } })} />
              </Field>
              {choose}
              <Button
                variant="primary"
                loading={busy === m.$id}
                disabled={!!busy || !!why}
                onClick={() => void run(m.$id, () => confirmBanked({
                  venueId, move: m, amount, date: at(f.date), reference: f.ref, userId, bankCode: into,
                }), `${money(amount)} confirmed in the bank.`)}
              >
                Confirm banked
              </Button>
            </div>
            {amount > 0 && amount !== m.amount && (
              <Notice tone="warn">That is {money(Math.abs(m.amount - amount))} {amount < m.amount ? 'less' : 'more'} than was taken. Say why on the close, or ask whoever took it.</Notice>
            )}
          </div>
        );
      })}

      {inSafe > 0 && (() => {
        const amount = parseMoney(safe.amount, decimals) ?? 0;
        const why = bankingProblem(amount, inSafe);
        return (
          <div style={{ borderTop: '1px solid var(--border)', padding: '0.6rem 0', display: 'grid', gap: '0.4rem' }}>
            <div>The safe holds <strong>{money(inSafe)}</strong> from closes.</div>
            <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <Field label="Banked from the safe">
                <Input value={safe.amount} inputMode="decimal" placeholder={toInput(inSafe, decimals)} onChange={(e) => setSafe({ ...safe, amount: e.target.value })} />
              </Field>
              <Field label="Date">
                <Input type="date" value={safe.date} onChange={(e) => setSafe({ ...safe, date: e.target.value })} />
              </Field>
              <Field label="Slip reference (optional)">
                <Input value={safe.ref} onChange={(e) => setSafe({ ...safe, ref: e.target.value })} />
              </Field>
              <Field label="Who took it (optional)">
                <Input value={safe.by} onChange={(e) => setSafe({ ...safe, by: e.target.value })} />
              </Field>
              {choose}
              <Button
                variant="primary"
                loading={busy === 'safe'}
                disabled={!!busy || !!why}
                onClick={() => void run('safe', async () => {
                  await bankFromSafe({ venueId, amount, date: at(safe.date), reference: safe.ref, takenBy: safe.by, userId, bankCode: into });
                  setSafe({ amount: '', date: today(), ref: '', by: '' });
                }, `${money(amount)} banked from the safe.`)}
              >
                Record it
              </Button>
            </div>
            {safe.amount && why && <span className="small dim">{why}</span>}
          </div>
        );
      })()}
    </Card>
  );
}
