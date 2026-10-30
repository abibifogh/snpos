import { useMemo, useState } from 'react';
import { Badge, Button, Card, Field, Input, Select } from '@snpos/ui';
import {
  moneyAccounts, payFromAccounts, moneyKindOf, MONEY_KIND_WORDS, addMoneyAccount, postTransfer, moneyTransferProblem,
  newMoneyAccountProblem, totalsByAccount, parseMoney, humanError,
} from '@snpos/core';
import type { AccountRow, MoneyAccountKind } from '@snpos/core';
import type { Lines } from './BookReports';

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Bank and cash accounts: every account money sits in, what each holds,
 * adding another bank or the MoMo wallet, and moving money between them.
 * Each new account can be reconciled against its own statement.
 */
export function BankAccounts({ accounts, lines, money, decimals, venueId, userId, isOwner, onChanged, toast }: {
  accounts: AccountRow[]; lines: Lines; money: (n: number) => string; decimals: number;
  venueId: string; userId: string; isOwner: boolean;
  onChanged: () => Promise<void>; toast: (m: string, t?: 'ok' | 'err') => void;
}) {
  const held = moneyAccounts(accounts);
  const totals = useMemo(() => totalsByAccount(lines), [lines]);
  const balance = (code: string) => { const t = totals.get(code); return t ? t.debit - t.credit : 0; };
  const movable = payFromAccounts(accounts);

  const [name, setName] = useState('');
  const [kind, setKind] = useState<MoneyAccountKind>('bank');
  const [move, setMove] = useState({ from: movable[0]?.code ?? '', to: movable[1]?.code ?? '', amount: '', date: today(), note: '' });
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (key: string, work: () => Promise<string>) => {
    setBusy(key);
    try {
      const words = await work();
      await onChanged();
      toast(words);
    } catch (e) {
      toast(humanError(e), 'err');
    } finally {
      setBusy(null);
    }
  };

  const amount = parseMoney(move.amount, decimals) ?? 0;
  const moveWhy = moneyTransferProblem(move.from, move.to, amount);
  const addWhy = newMoneyAccountProblem(name, accounts);

  return (
    <>
      <Card title="Bank and cash accounts" pad
        help={
          <>
            Every account money sits in. Each bank account and the MoMo merchant wallet is its own account, with its own
            balance, and can be reconciled against its own statement under Reconcile.
          </>
        }
      >
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Account</th><th>Kind</th><th className="num">Holds</th></tr></thead>
            <tbody>
              {held.map((a) => (
                <tr key={a.code}>
                  <td>{a.code} {a.name}</td>
                  <td><Badge>{MONEY_KIND_WORDS[moneyKindOf(a) ?? 'cash']}</Badge></td>
                  <td className="num" style={{ fontWeight: 600 }}>{money(balance(a.code))}</td>
                </tr>
              ))}
              <tr>
                <td style={{ fontWeight: 650 }}>All together</td><td />
                <td className="num" style={{ fontWeight: 650 }}>{money(held.reduce((n, a) => n + balance(a.code), 0))}</td>
              </tr>
            </tbody>
          </table>
        </div>
        {isOwner && (
          <div className="row row-wrap" style={{ gap: '0.5rem', alignItems: 'flex-end', marginTop: '0.8rem' }}>
            <Field label="Add an account">
              <Input value={name} placeholder="e.g. Second bank ··4471" onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Kind">
              <Select value={kind} onChange={(e) => setKind(e.target.value as MoneyAccountKind)}>
                <option value="bank">Bank account</option>
                <option value="momo">MoMo wallet</option>
                <option value="cash">Cash</option>
              </Select>
            </Field>
            <Button
              variant="primary"
              loading={busy === 'add'}
              disabled={!!busy || !!addWhy}
              onClick={() => void run('add', async () => {
                const code = await addMoneyAccount({ name, kind, accounts });
                setName('');
                return `${name.trim()} added as account ${code}.`;
              })}
            >
              Add
            </Button>
            {name && addWhy && <span className="small dim">{addWhy}</span>}
          </div>
        )}
      </Card>

      <Card title="Move money between accounts" pad
        help={
          <>
            Cash paid into the bank, the MoMo wallet emptied to the bank, money moved between two banks. Nothing is
            earned or spent; it only moves.
          </>
        }
      >
        <div className="row row-wrap" style={{ gap: '0.5rem', alignItems: 'flex-end' }}>
          <Field label="From">
            <Select value={move.from} onChange={(e) => setMove({ ...move, from: e.target.value })}>
              {movable.map((a) => <option key={a.code} value={a.code}>{a.name}</option>)}
            </Select>
          </Field>
          <Field label="To">
            <Select value={move.to} onChange={(e) => setMove({ ...move, to: e.target.value })}>
              {movable.map((a) => <option key={a.code} value={a.code}>{a.name}</option>)}
            </Select>
          </Field>
          <Field label="Amount"><Input value={move.amount} inputMode="decimal" onChange={(e) => setMove({ ...move, amount: e.target.value })} /></Field>
          <Field label="Date"><Input type="date" value={move.date} onChange={(e) => setMove({ ...move, date: e.target.value })} /></Field>
          <Field label="Note (optional)"><Input value={move.note} onChange={(e) => setMove({ ...move, note: e.target.value })} /></Field>
          <Button
            variant="primary"
            loading={busy === 'move'}
            disabled={!!busy || !!moveWhy}
            onClick={() => void run('move', async () => {
              await postTransfer(venueId || 'main', { from: move.from, to: move.to, amount, date: new Date(`${move.date}T12:00:00`), note: move.note, userId });
              setMove({ ...move, amount: '', note: '' });
              return `${money(amount)} moved.`;
            })}
          >
            Record the transfer
          </Button>
        </div>
        {move.amount && moveWhy && <div className="small dim">{moveWhy}</div>}
      </Card>
    </>
  );
}
