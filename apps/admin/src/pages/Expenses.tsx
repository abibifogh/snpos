import { useEffect, useRef, useState } from 'react';
import { Button, Card, Empty, Field, Input, Modal, Notice, Select, Spinner, Textarea, Badge, useToast } from '@snpos/ui';
import { db, DB_ID, ID, listAll, humanError } from '../lib';
import { formatMoney, parseMoney, toInput, uploadFile, downloadUrl, deleteFile } from '@snpos/core';
import type { Doc } from '@snpos/core';
import { useSession } from '../session';

interface Expense extends Doc {
  venue_id: string;
  shift_id?: string;
  category: string;
  payee?: string;
  amount: number;
  paid_from_method_id: string;
  note?: string;
  receipt_file_id?: string;
  created_by: string;
  approval_status: string;
}

interface PaymentMethod extends Doc { name: string; kind: string; enabled: boolean; venue_id: string }
interface VenueRow extends Doc { name: string }

const CATEGORIES = [
  'Supplies', 'Transport', 'Utilities', 'Repairs & maintenance',
  'Staff advances', 'Petty cash', 'Other',
];

/** Receipts may be photographed or scanned, so accept images and PDFs. */
const RECEIPT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;

export function ExpensesPage() {
  const { settings, user } = useSession();
  const toast = useToast();
  const decimals = settings?.currency_decimals ?? 2;
  const fileInput = useRef<HTMLInputElement>(null);

  const [rows, setRows] = useState<Expense[] | null>(null);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [venues, setVenues] = useState<VenueRow[]>([]);
  const [editing, setEditing] = useState<Partial<Expense> | null>(null);
  const [amountText, setAmountText] = useState('');
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const [e, m, v] = await Promise.all([
      listAll<Expense>('shift_expenses'),
      listAll<PaymentMethod>('payment_methods'),
      listAll<VenueRow>('venues'),
    ]);
    setRows(e.sort((a, b) => b.$createdAt.localeCompare(a.$createdAt)));
    setMethods(m.filter((x) => x.enabled));
    setVenues(v);
  };
  useEffect(() => { load().catch((err) => setError(humanError(err))); }, []);

  const open = (row?: Expense) => {
    setEditing(
      row ?? {
        venue_id: venues[0]?.$id ?? 'main',
        category: CATEGORIES[0],
        payee: '',
        note: '',
        paid_from_method_id: methods[0]?.$id ?? '',
        approval_status: 'pending',
      },
    );
    setAmountText(toInput(row?.amount ?? 0, decimals));
    setError(null);
  };

  const attach = async (file: File) => {
    if (!RECEIPT_TYPES.includes(file.type)) {
      setError('Attach a photo (JPG, PNG or WebP) or a PDF.');
      return;
    }
    if (file.size > MAX_RECEIPT_BYTES) {
      setError(`That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 10 MB.`);
      return;
    }
    setUploading(true);
    setError(null);
    try {
      // Receipts are uploaded manager-readable, never public — see uploadFile.
      const { fileId } = await uploadFile(file, 'receipt', settings);
      setEditing((x) => (x ? { ...x, receipt_file_id: fileId } : x));
    } catch (e) {
      setError(humanError(e));
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const save = async () => {
    const amount = parseMoney(amountText, decimals);
    if (amount === null || amount <= 0) { setError('Enter the amount spent, for example 45.00'); return; }
    if (!editing?.paid_from_method_id) { setError('Choose how it was paid.'); return; }

    setBusy(true);
    setError(null);
    try {
      const payload = {
        venue_id: editing.venue_id ?? 'main',
        shift_id: editing.shift_id ?? '',
        category: editing.category ?? 'Other',
        payee: editing.payee ?? '',
        amount,
        paid_from_method_id: editing.paid_from_method_id,
        note: editing.note ?? '',
        receipt_file_id: editing.receipt_file_id ?? '',
        created_by: user?.$id ?? '',
        approval_status: editing.approval_status ?? 'pending',
      };
      if (editing.$id) await db.updateDocument(DB_ID, 'shift_expenses', editing.$id, payload);
      else await db.createDocument(DB_ID, 'shift_expenses', ID.unique(), payload);
      setEditing(null);
      await load();
      toast('Expense recorded');
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (row: Expense) => {
    if (!confirm(`Delete this ${settings ? formatMoney(row.amount, settings) : ''} expense? This cannot be undone.`)) return;
    try {
      if (row.receipt_file_id) await deleteFile(row.receipt_file_id, 'receipt', settings).catch(() => undefined);
      await db.deleteDocument(DB_ID, 'shift_expenses', row.$id);
      await load();
      toast('Deleted');
    } catch (e) {
      toast(humanError(e), 'err');
    }
  };

  const methodName = (id: string) => methods.find((m) => m.$id === id)?.name ?? '—';

  return (
    <>
      <div className="spread">
        <h1>Expenses</h1>
        <Button variant="primary" onClick={() => open()} disabled={methods.length === 0}>Record expense</Button>
      </div>

      <p className="dim small" style={{ marginTop: 0 }}>
        Money paid out — supplies, transport, repairs. Attach the receipt as a photo or PDF; receipts are visible to
        managers and admins only, never to customers or other staff.
      </p>

      {error && !editing && <Notice>{error}</Notice>}

      <Card pad={false}>
        {!rows ? (
          <div className="card-pad"><Spinner /></div>
        ) : rows.length === 0 ? (
          <Empty title="No expenses recorded">Record what you spend and it lands in the accounts and the shift close.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Category</th>
                  <th>Paid to</th>
                  <th>Method</th>
                  <th className="num">Amount</th>
                  <th>Receipt</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.$id}>
                    <td className="dim small">{new Date(r.$createdAt).toLocaleDateString()}</td>
                    <td>{r.category}</td>
                    <td className="dim">{r.payee || '—'}</td>
                    <td className="dim small">{methodName(r.paid_from_method_id)}</td>
                    <td className="num">{settings ? formatMoney(r.amount, settings) : r.amount}</td>
                    <td>
                      {r.receipt_file_id ? (
                        <a href={downloadUrl(r.receipt_file_id, 'receipt', settings)} target="_blank" rel="noreferrer">
                          View
                        </a>
                      ) : (
                        <Badge tone="warn">None</Badge>
                      )}
                    </td>
                    <td className="num">
                      <Button size="sm" variant="ghost" onClick={() => open(r)}>Edit</Button>
                      <Button size="sm" variant="ghost" onClick={() => remove(r)}>Delete</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editing && (
        <Modal
          title={editing.$id ? 'Edit expense' : 'Record expense'}
          onClose={() => setEditing(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
              <Button variant="primary" onClick={save} loading={busy}>Save</Button>
            </>
          }
        >
          {error && <div style={{ marginBottom: '1rem' }}><Notice>{error}</Notice></div>}

          <div className="grid-2">
            <Field label="Category">
              <Select value={editing.category ?? ''} onChange={(e) => setEditing({ ...editing, category: e.target.value })}>
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            </Field>
            <Field label={`Amount (${settings?.currency_symbol ?? ''})`}>
              <Input value={amountText} inputMode="decimal" autoFocus onChange={(e) => setAmountText(e.target.value)} />
            </Field>
            <Field label="Paid to" hint="Supplier, driver, whoever received the money.">
              <Input value={editing.payee ?? ''} onChange={(e) => setEditing({ ...editing, payee: e.target.value })} />
            </Field>
            <Field label="Paid from">
              <Select
                value={editing.paid_from_method_id ?? ''}
                onChange={(e) => setEditing({ ...editing, paid_from_method_id: e.target.value })}
              >
                {methods.map((m) => <option key={m.$id} value={m.$id}>{m.name}</option>)}
              </Select>
            </Field>
          </div>

          {venues.length > 1 && (
            <Field label="Venue">
              <Select value={editing.venue_id ?? ''} onChange={(e) => setEditing({ ...editing, venue_id: e.target.value })}>
                {venues.map((v) => <option key={v.$id} value={v.$id}>{v.name}</option>)}
              </Select>
            </Field>
          )}

          <Field label="Note">
            <Textarea value={editing.note ?? ''} onChange={(e) => setEditing({ ...editing, note: e.target.value })} />
          </Field>

          <Field label="Receipt" hint="A photo or PDF. Visible to managers and admins only.">
            <div className="row">
              <Button size="sm" type="button" loading={uploading} onClick={() => fileInput.current?.click()}>
                {editing.receipt_file_id ? 'Replace receipt' : 'Attach receipt'}
              </Button>
              {editing.receipt_file_id && (
                <>
                  <a
                    className="small"
                    href={downloadUrl(editing.receipt_file_id, 'receipt', settings)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    View attached
                  </a>
                  <Button
                    size="sm"
                    variant="ghost"
                    type="button"
                    onClick={async () => {
                      const id = editing.receipt_file_id as string;
                      setEditing({ ...editing, receipt_file_id: '' });
                      await deleteFile(id, 'receipt', settings).catch(() => undefined);
                    }}
                  >
                    Remove
                  </Button>
                </>
              )}
            </div>
            <input
              ref={fileInput}
              type="file"
              accept="image/jpeg,image/png,image/webp,application/pdf"
              style={{ display: 'none' }}
              onChange={(e) => e.target.files?.[0] && attach(e.target.files[0])}
            />
          </Field>
        </Modal>
      )}
    </>
  );
}
