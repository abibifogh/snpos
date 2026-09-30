import { useEffect, useState } from 'react';
import { Badge, Button, Modal, Notice, Spinner } from '@snpos/ui';
import { db, DB_ID, listAll, Query, humanError } from '../lib';
import {
  loadStaffNames, nameFrom, loadPaymentMethods, spendHistory, spendWords, downloadUrl, dateTimeWords, MODULE_LABELS,
  offWords,
} from '@snpos/core';
import type { SpendAudit, SpendHistoryRow, Settings, Module } from '@snpos/core';
import { useMoney } from '../session';

interface SpendRow {
  $id: string;
  $createdAt: string;
  $updatedAt?: string;
  venue_id?: string;
  shift_id?: string;
  module?: string;
  amount: number;
  category?: string;
  category_key?: string;
  payee?: string;
  paid_to_kind?: string;
  note?: string;
  paid_from_method_id?: string;
  imprest_float_id?: string;
  from_takings?: boolean;
  source?: string;
  receipt_file_id?: string;
  created_by?: string;
  approved_by?: string;
  approval_status?: string;
}

interface ItemRow { $id: string; name_snapshot: string; qty: number; unit_cost: number; line_total: number; stocked?: boolean }

const APPROVAL_WORDS: Record<string, string> = {
  not_required: 'Needed no approval',
  pending: 'Waiting for approval',
  approved: 'Approved',
  rejected: 'Refused',
};

/**
 * Everything about one spend: who recorded it and when, where the money came
 * from, what was bought, the receipt, whether it was approved, and every
 * change made to it since. See spend-history.ts for the changes.
 */
export function SpendDetailsModal({ expenseId, settings, onClose }: {
  expenseId: string;
  settings: Settings | null;
  onClose: () => void;
}) {
  const money = useMoney();
  const [spend, setSpend] = useState<SpendRow | null>(null);
  const [items, setItems] = useState<ItemRow[]>([]);
  const [history, setHistory] = useState<SpendHistoryRow[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [method, setMethod] = useState<{ name: string; kind?: string } | null>(null);
  const [extras, setExtras] = useState<{ shift?: string; box?: string }>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const row = await db.getDocument(DB_ID, 'shift_expenses', expenseId) as unknown as SpendRow;
        const [lines, audits, book, methods, shift, box] = await Promise.all([
          listAll<ItemRow>('expense_items', [Query.equal('expense_id', expenseId)]).catch(() => [] as ItemRow[]),
          listAll<SpendAudit>('audit_log', [Query.equal('entity_id', expenseId)]).catch(() => [] as SpendAudit[]),
          loadStaffNames(),
          loadPaymentMethods(row.venue_id ?? 'main').catch(() => []),
          row.shift_id
            ? db.getDocument(DB_ID, 'shifts', row.shift_id).then((s) => (s as unknown as { code?: string }).code ?? '').catch(() => '')
            : Promise.resolve(''),
          row.imprest_float_id
            ? db.getDocument(DB_ID, 'imprest_floats', row.imprest_float_id).then((b) => (b as unknown as { name?: string }).name ?? '').catch(() => '')
            : Promise.resolve(''),
        ]);
        const m = methods.find((x) => x.$id === row.paid_from_method_id);
        setSpend(row);
        setItems(lines);
        setNames(book);
        setMethod(m ? { name: m.name, kind: m.kind } : null);
        setExtras({ shift, box });
        setHistory(spendHistory({
          spend: row,
          audits,
          nameOf: (id) => nameFrom(book, id ?? undefined, ''),
          money,
          methodName: (id) => methods.find((x) => x.$id === id)?.name ?? id,
        }));
      } catch (e) {
        setError(humanError(e));
      }
    })();
  }, [expenseId, money]);

  const who = (id?: string) => nameFrom(names, id, '') || '—';
  const itemised = items.reduce((n, i) => n + i.line_total, 0);
  const fact = (label: string, value: React.ReactNode) => (
    <div>
      <div className="small dim">{label}</div>
      <div style={{ fontWeight: 550 }}>{value}</div>
    </div>
  );

  return (
    <Modal
      wide
      title={spend ? `${spend.category_key || spend.category || 'Spend'} · ${money(spend.amount)}` : 'Spend'}
      onClose={onClose}
      footer={<Button onClick={onClose}>Close</Button>}
    >
      {error && <Notice>{error}</Notice>}
      {!spend ? (!error && <Spinner />) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(11rem, 1fr))', gap: '0.9rem', marginBottom: '1rem' }}>
            {fact('Recorded by', who(spend.created_by))}
            {fact('Recorded', dateTimeWords(spend.$createdAt))}
            {fact('Shift', extras.shift || (spend.shift_id ? '—' : 'Not on a shift'))}
            {fact('Side', MODULE_LABELS[(spend.module ?? 'kitchen') as Module])}
            {fact('Paid to', spend.payee || '—')}
            {fact('Paid by', method?.name ?? 'Not recorded')}
            {fact('Came out of', extras.box || spendWords(spend, [], method?.kind).source)}
            {fact('Approval', (
              <>
                <Badge tone={spend.approval_status === 'rejected' ? 'danger' : spend.approval_status === 'pending' ? 'warn' : 'ok'}>
                  {APPROVAL_WORDS[spend.approval_status ?? 'not_required'] ?? spend.approval_status}
                </Badge>
                {spend.approved_by && <span className="small dim"> by {who(spend.approved_by)}</span>}
              </>
            ))}
            {fact('Receipt', spend.receipt_file_id
              ? <a href={downloadUrl(spend.receipt_file_id, 'receipt', settings)} target="_blank" rel="noreferrer">View the photo</a>
              : <Badge tone="warn">None</Badge>)}
          </div>

          {spend.note && <p style={{ marginTop: 0 }}><span className="dim">Note: </span>&ldquo;{spend.note}&rdquo;</p>}

          <h3 style={{ marginBottom: '0.3rem' }}>What was bought</h3>
          {items.length > 0 && itemised !== spend.amount && (
            <Notice tone="warn">
              {offWords(itemised - spend.amount, money)}
              {itemised < spend.amount && ' In the books that part is charged to the spend’s category; press Edit on Spends to itemise it or correct the total.'}
            </Notice>
          )}
          {items.length === 0 ? (
            <p className="small dim" style={{ marginTop: 0 }}>Nothing itemised: recorded as one amount.</p>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>What</th><th className="num">How many</th><th className="num">Each</th><th className="num">Paid</th></tr></thead>
                <tbody>
                  {items.map((i) => (
                    <tr key={i.$id}>
                      <td>
                        {i.name_snapshot}
                        {i.stocked === false && <div className="small dim">not stocked, used up in the buying</div>}
                      </td>
                      <td className="num">{i.qty}</td>
                      <td className="num dim">{money(i.unit_cost)}</td>
                      <td className="num">{money(i.line_total)}</td>
                    </tr>
                  ))}
                  <tr>
                    <td colSpan={3} style={{ fontWeight: 650 }}>Itemised</td>
                    <td className="num" style={{ fontWeight: 650 }}>{money(itemised)}</td>
                  </tr>
                  {/* The part of the spend no line accounts for, said as a
                      line of its own so the two figures visibly add up. */}
                  {itemised !== spend.amount && (
                    <>
                      <tr>
                        <td colSpan={3} style={{ fontWeight: 650 }}>{itemised < spend.amount ? 'Not itemised' : 'Itemised beyond the spend'}</td>
                        <td className="num" style={{ fontWeight: 650 }}>{money(Math.abs(spend.amount - itemised))}</td>
                      </tr>
                      <tr>
                        <td colSpan={3} className="dim">The spend says</td>
                        <td className="num dim">{money(spend.amount)}</td>
                      </tr>
                    </>
                  )}
                </tbody>
              </table>
            </div>
          )}

          <h3 style={{ marginBottom: '0.3rem' }}>History</h3>
          <div className="table-wrap">
            <table className="data">
              <tbody>
                {history.map((h) => (
                  <tr key={h.id}>
                    <td className="small dim" style={{ whiteSpace: 'nowrap', width: '1%' }}>{dateTimeWords(h.at)}</td>
                    <td>
                      <strong>{h.what}</strong> <span className="dim">by {h.who}</span>
                      {h.changes.map((c) => <div key={c} className="small">{c}</div>)}
                      {h.reason && <div className="small dim">&ldquo;{h.reason}&rdquo;</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small dim" style={{ marginBottom: 0 }}>
            Changes are kept from when this history was added; anything changed before then shows here only as it is now.
          </p>
        </>
      )}
    </Modal>
  );
}
