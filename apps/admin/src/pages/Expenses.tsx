import { useEffect, useRef, useState } from 'react';
import { Button, Card, Empty, Field, Input, Modal, Notice, Select, Spinner, Textarea, Badge, useToast } from '@snpos/ui';
import { db, DB_ID, ID, listAll, humanError } from '../lib';
import {
  formatMoney, parseMoney, toInput, uploadFile, downloadUrl, deleteFile, receiveStock, Query,
  PAID_TO_KINDS, payeeLabel as sharedPayeeLabel, legacyExpenseCategory as legacyFor,
  isPostableExpenseAccount, expenseMethods, modulesOf,
} from '@snpos/core';
import type { Doc, Ingredient, PaidToKind } from '@snpos/core';
import { KeyedListManager, useKeyedList, nameForKey } from '../components/KeyedList';
import { AccountsManager } from '../components/AccountsManager';
import { useSession } from '../session';
import { SideFilter, onSide, type Side } from '../components/SideFilter';

interface Expense extends Doc {
  venue_id: string;
  shift_id?: string;
  category: string;
  category_key?: string;
  payee?: string;
  paid_to_kind?: 'supplier' | 'staff' | 'open_market' | 'other';
  module?: 'kitchen' | 'craft';
  supplier_id?: string;
  paid_to_staff_id?: string;
  amount: number;
  paid_from_method_id: string;
  note?: string;
  receipt_file_id?: string;
  created_by: string;
  approval_status: string;
}

interface ExpenseItem extends Doc {
  expense_id: string;
  ingredient_id: string;
  name_snapshot: string;
  qty: number;
  unit_cost: number;
  line_total: number;
  stocked: boolean;
}

interface PaymentMethod extends Doc { name: string; kind: string; enabled: boolean; venue_id: string }
interface VenueRow extends Doc { name: string }
interface Supplier extends Doc { name: string; active: boolean }
interface Staff extends Doc { display_name: string; active: boolean }
interface AccountRow extends Doc { code: string; name: string; type: string }

/** A line being entered, before it becomes an expense_item. */
interface DraftItem {
  ingredient_id: string;
  qtyText: string;
  costText: string;
}

/** Receipts may be photographed or scanned, so accept images and PDFs. */
const RECEIPT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;

export function ExpensesPage() {
  const { settings, user } = useSession();
  const toast = useToast();
  const decimals = settings?.currency_decimals ?? 2;
  const fileInput = useRef<HTMLInputElement>(null);

  const [tab, setTab] = useState<'expenses' | 'categories' | 'accounts'>('expenses');
  const [rows, setRows] = useState<Expense[] | null>(null);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [side, setSide] = useState<Side>('all');
  const mods = modulesOf(settings);
  const [venues, setVenues] = useState<VenueRow[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const { rows: categories, reload: reloadCategories } = useKeyedList('expense_categories');

  const [editing, setEditing] = useState<Partial<Expense> | null>(null);
  const [amountText, setAmountText] = useState('');
  const [draftItems, setDraftItems] = useState<DraftItem[]>([]);
  const [savedItems, setSavedItems] = useState<ExpenseItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const [e, m, v, s, p, i, a] = await Promise.all([
      listAll<Expense>('shift_expenses'),
      listAll<PaymentMethod>('payment_methods'),
      listAll<VenueRow>('venues'),
      listAll<Supplier>('suppliers'),
      listAll<Staff>('staff_profiles'),
      listAll<Ingredient>('ingredients'),
      listAll<AccountRow>('accounts'),
    ]);
    setRows(e.sort((a2, b) => b.$createdAt.localeCompare(a2.$createdAt)));
    // The same restriction the kitchen form obeys. An admin recording a shop
    // run after the fact is recording the same event, and a rule that only
    // holds on one of the two screens is not a rule.
    setMethods(expenseMethods(m.filter((x) => x.enabled), settings ?? undefined));
    setVenues(v);
    setSuppliers(s.filter((x) => x.active !== false).sort((a2, b) => a2.name.localeCompare(b.name)));
    setStaff(p.filter((x) => x.active !== false).sort((a2, b) => a2.display_name.localeCompare(b.display_name)));
    setIngredients(i.filter((x) => x.active).sort((a2, b) => a2.name.localeCompare(b.name)));
    // Expense lines only, minus the two the system fills in by itself. See
    // isPostableExpenseAccount — offering "Food sales" as a destination for a
    // gas refill is offering a way to make the books wrong.
    setAccounts(a.filter(isPostableExpenseAccount).sort((a2, b) => a2.code.localeCompare(b.code)));
  };
  useEffect(() => { load().catch((err) => setError(humanError(err))); }, []);


  const open = async (row?: Expense) => {
    setEditing(
      row ?? {
        venue_id: venues[0]?.$id ?? 'main',
        category_key: categories?.[0]?.key ?? 'other',
        paid_to_kind: 'supplier',
        payee: '',
        note: '',
        paid_from_method_id: methods[0]?.$id ?? '',
        approval_status: 'pending',
      },
    );
    // Blank for a new expense, not "0.00". A pre-filled zero has to be cleared
    // before anything can be typed, and on a phone that means a long-press and
    // a select-all — so what actually gets recorded is 250.00 turned into
    // 0.00250 by somebody in a hurry.
    setAmountText(row ? toInput(row.amount, decimals) : '');
    setDraftItems([]);
    setError(null);

    // Lines already recorded against this expense are shown but not re-entered:
    // stock was raised for them once and must not be raised again.
    setSavedItems(
      row
        ? await listAll<ExpenseItem>('expense_items', [Query.equal('expense_id', row.$id)]).catch(() => [])
        : [],
    );
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

  /**
   * The category the stock lines imply.
   *
   * Ingredients each name what buying them counts as, so listing what was
   * bought is usually enough to say what the money was. Only claimed when
   * every line agrees — a trip that bought rice and a new gas bottle is two
   * categories, and guessing one of them would be worse than asking.
   */
  const impliedCategory = (() => {
    const keys = draftItems
      .filter((d) => d.ingredient_id)
      .map((d) => ingredients.find((i) => i.$id === d.ingredient_id)?.expense_category_key)
      .filter(Boolean) as string[];
    if (keys.length === 0) return null;
    return keys.every((k) => k === keys[0]) ? keys[0] : null;
  })();

  // Follow the stock lines as they are typed. Only ever moves the category to
  // what the ingredients say; never blanks a choice somebody made by hand.
  useEffect(() => {
    if (impliedCategory && editing && editing.category_key !== impliedCategory) {
      setEditing((e) => (e ? { ...e, category_key: impliedCategory } : e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [impliedCategory]);

  /** What the itemised lines add up to, for comparing against the total paid. */
  const draftTotal = draftItems.reduce((sum, d) => {
    const qty = Number(d.qtyText || 0);
    const cost = parseMoney(d.costText, decimals) ?? 0;
    return sum + Math.round(qty * cost);
  }, 0);

  const save = async () => {
    const amount = parseMoney(amountText, decimals);
    if (amount === null || amount <= 0) { setError('Enter the amount spent, for example 45.00'); return; }
    if (!editing?.paid_from_method_id) { setError('Choose how it was paid.'); return; }
    if (!editing.category_key) { setError('Choose a category.'); return; }

    const filled = draftItems.filter((d) => d.ingredient_id && Number(d.qtyText) > 0);
    for (const d of filled) {
      if (parseMoney(d.costText, decimals) === null) {
        setError('One of the stock lines does not have a valid unit cost.');
        return;
      }
    }

    setBusy(true);
    setError(null);
    try {
      const kind = editing.paid_to_kind ?? 'other';
      const payload = {
        venue_id: editing.venue_id ?? 'main',
        shift_id: editing.shift_id ?? '',
        // The old fixed column, kept valid; category_key is the real answer.
        category: legacyFor(editing.category_key),
        category_key: editing.category_key,
        paid_to_kind: kind,
        supplier_id: kind === 'supplier' ? editing.supplier_id ?? '' : '',
        paid_to_staff_id: kind === 'staff' ? editing.paid_to_staff_id ?? '' : '',
        payee: payeeLabel(kind, editing),
        amount,
        paid_from_method_id: editing.paid_from_method_id,
        // Which side's books this comes out of. Defaults to the kitchen for a
        // business that runs one side, where the question has one answer.
        module: editing.module ?? 'kitchen',
        note: editing.note ?? '',
        receipt_file_id: editing.receipt_file_id ?? '',
        created_by: user?.$id ?? '',
        approval_status: editing.approval_status ?? 'pending',
      };
      const expenseId = editing.$id
        ? (await db.updateDocument(DB_ID, 'shift_expenses', editing.$id, payload)).$id
        : (await db.createDocument(DB_ID, 'shift_expenses', ID.unique(), payload)).$id;

      // Each line is written, then delivered into stock. Recording it and
      // raising the stock are one action from the user's point of view, so a
      // line that fails to stock says so rather than being quietly dropped.
      let stockFailures = 0;
      for (const d of filled) {
        const ing = ingredients.find((i) => i.$id === d.ingredient_id);
        if (!ing) continue;
        const qty = Number(d.qtyText);
        const unitCost = parseMoney(d.costText, decimals) ?? ing.base_unit_cost;
        try {
          await db.createDocument(DB_ID, 'expense_items', ID.unique(), {
            expense_id: expenseId,
            ingredient_id: ing.$id,
            name_snapshot: ing.name,
            qty,
            unit_cost: unitCost,
            line_total: Math.round(qty * unitCost),
            stocked: true,
          });
          await receiveStock({
            venueId: payload.venue_id,
            ingredient: ing,
            qty,
            unitCost,
            refType: 'expense',
            refId: expenseId,
            shiftId: payload.shift_id,
            createdBy: user?.$id ?? '',
            note: payload.payee ? `Bought from ${payload.payee}` : 'Expense',
          });
        } catch {
          stockFailures += 1;
        }
      }

      setEditing(null);
      await load();
      toast(
        stockFailures > 0
          ? `Expense saved, but ${stockFailures} stock line${stockFailures > 1 ? 's' : ''} did not go through`
          : filled.length
            ? `Expense recorded and ${filled.length} item${filled.length > 1 ? 's' : ''} added to stock`
            : 'Expense recorded',
        stockFailures > 0 ? 'err' : 'ok',
      );
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (row: Expense) => {
    if (!confirm(`Delete this ${settings ? formatMoney(row.amount, settings) : ''} expense? Stock already added from it stays where it is — remove that separately if it was wrong.`)) return;
    try {
      if (row.receipt_file_id) await deleteFile(row.receipt_file_id, 'receipt', settings).catch(() => undefined);
      const items = await listAll<ExpenseItem>('expense_items', [Query.equal('expense_id', row.$id)]).catch(() => []);
      await Promise.all(items.map((i) => db.deleteDocument(DB_ID, 'expense_items', i.$id).catch(() => undefined)));
      await db.deleteDocument(DB_ID, 'shift_expenses', row.$id);
      await load();
      toast('Deleted');
    } catch (e) {
      toast(humanError(e), 'err');
    }
  };

  const methodName = (id: string) => methods.find((m) => m.$id === id)?.name ?? '—';

  /** A readable "paid to", worked out the same way the kitchen works it out. */
  function payeeLabel(kind: PaidToKind, e: Partial<Expense>): string {
    return sharedPayeeLabel(kind, {
      supplierName: suppliers.find((s) => s.$id === e.supplier_id)?.name,
      staffName: staff.find((s) => s.$id === e.paid_to_staff_id)?.display_name,
      payee: e.payee,
    });
  }

  return (
    <>
      <div className="spread">
        <h1>Expenses</h1>
        {tab === 'expenses' && <SideFilter value={side} onChange={setSide} settings={settings} />}
        {tab === 'expenses' && (
          <Button variant="primary" onClick={() => void open()} disabled={methods.length === 0}>
            Record expense
          </Button>
        )}
      </div>

      <div className="row" style={{ gap: '0.4rem' }}>
        <Button size="sm" variant={tab === 'expenses' ? 'primary' : 'default'} onClick={() => setTab('expenses')}>
          Expenses
        </Button>
        <Button size="sm" variant={tab === 'categories' ? 'primary' : 'default'} onClick={() => setTab('categories')}>
          Categories
        </Button>
        <Button size="sm" variant={tab === 'accounts' ? 'primary' : 'default'} onClick={() => setTab('accounts')}>
          Accounts
        </Button>
      </div>

      {tab === 'accounts' ? (
        <AccountsManager />
      ) : tab === 'categories' ? (
        <KeyedListManager
          collection="expense_categories"
          singular="category"
          accounts={accounts.map((a) => ({ code: a.code, name: a.name }))}
          onChanged={reloadCategories}
          hint="Your own list. Each one posts to a line of the accounts, which is what decides where the money shows up in Reports. Nothing there that fits? Add it under the Accounts tab. Rename freely; expenses already filed under a category stay with it."
        />
      ) : (
        <>
          <p className="dim small" style={{ marginTop: 0 }}>
            Money paid out — supplies, transport, repairs. Attach the receipt as a photo or PDF; receipts are visible
            to managers and admins only, never to customers or other staff.
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
                    {rows.filter((r) => onSide(r, side)).map((r) => (
                      <tr key={r.$id}>
                        <td className="dim small">{new Date(r.$createdAt).toLocaleDateString()}</td>
                        <td>{nameForKey(categories, r.category_key || r.category)}</td>
                        <td className="dim">
                          {r.payee || '—'}
                          {r.paid_to_kind === 'open_market' && <div className="small dim">Open market</div>}
                          {r.paid_to_kind === 'staff' && <div className="small dim">Staff</div>}
                        </td>
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
                          <Button size="sm" variant="ghost" onClick={() => void open(r)}>Edit</Button>
                          <Button size="sm" variant="ghost" onClick={() => remove(r)}>Delete</Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}

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
            {/* Hidden once the stock lines answer it. Each ingredient already
                carries its category, set when it was added, so asking again
                invites a second and different answer for the same purchase.
                Still asked when there is nothing listed — a taxi or a repair
                has no ingredient to take the answer from. */}
            <Field
              label="Category"
              hidden={!!impliedCategory}
              hint={
                categories && categories.length === 0
                  ? 'None set up — add some under the Categories tab.'
                  : undefined
              }
            >
              <Select
                value={editing.category_key ?? ''}
                onChange={(e) => setEditing({ ...editing, category_key: e.target.value })}
              >
                {(categories ?? []).filter((c) => c.active !== false).map((c) => (
                  <option key={c.key} value={c.key}>{c.name}</option>
                ))}
              </Select>
            </Field>
            <Field label={`Amount (${settings?.currency_symbol ?? ''})`}>
              <Input value={amountText} inputMode="decimal" autoFocus onChange={(e) => setAmountText(e.target.value)} />
            </Field>
            <Field label="Paid to" hint="Not every purchase has a supplier behind it.">
              <Select
                value={editing.paid_to_kind ?? 'supplier'}
                onChange={(e) => setEditing({ ...editing, paid_to_kind: e.target.value as Expense['paid_to_kind'] })}
              >
                {PAID_TO_KINDS.map((k) => <option key={k.v} value={k.v}>{k.l}</option>)}
              </Select>
            </Field>
            {mods.kitchen && mods.craft && (
              <Field label="Which side" hint="Whose books this comes out of.">
                <Select
                  value={editing.module ?? 'kitchen'}
                  onChange={(e) => setEditing({ ...editing, module: e.target.value as 'kitchen' | 'craft' })}
                >
                  <option value="kitchen">Kitchen</option>
                  <option value="craft">Craft shop</option>
                </Select>
              </Field>
            )}
            <Field
              label="Paid from"
              hint={methods.length === 1 ? 'Expenses are set to cash only under Settings.' : undefined}
            >
              <Select
                value={editing.paid_from_method_id ?? ''}
                onChange={(e) => setEditing({ ...editing, paid_from_method_id: e.target.value })}
                disabled={methods.length === 1}
              >
                {methods.map((m) => <option key={m.$id} value={m.$id}>{m.name}</option>)}
              </Select>
            </Field>
          </div>

          {editing.paid_to_kind === 'supplier' && (
            <Field label="Which supplier" hint="Add and edit suppliers under Stock → Suppliers.">
              <Select
                value={editing.supplier_id ?? ''}
                onChange={(e) => setEditing({ ...editing, supplier_id: e.target.value })}
              >
                <option value="">— choose —</option>
                {suppliers.map((s) => <option key={s.$id} value={s.$id}>{s.name}</option>)}
              </Select>
            </Field>
          )}

          {editing.paid_to_kind === 'staff' && (
            <Field label="Which member of staff" hint="For money handed to someone to go and buy, or a staff advance.">
              <Select
                value={editing.paid_to_staff_id ?? ''}
                onChange={(e) => setEditing({ ...editing, paid_to_staff_id: e.target.value })}
              >
                <option value="">— choose —</option>
                {staff.map((s) => <option key={s.$id} value={s.$id}>{s.display_name}</option>)}
              </Select>
            </Field>
          )}

          {(editing.paid_to_kind === 'open_market' || editing.paid_to_kind === 'other') && (
            <Field
              label="Name"
              hint={editing.paid_to_kind === 'open_market' ? 'The market or stall, if it is worth recording. Leave blank for just "Open market".' : 'Whoever received the money.'}
            >
              <Input value={editing.payee ?? ''} onChange={(e) => setEditing({ ...editing, payee: e.target.value })} />
            </Field>
          )}

          {venues.length > 1 && (
            <Field label="Venue">
              <Select value={editing.venue_id ?? ''} onChange={(e) => setEditing({ ...editing, venue_id: e.target.value })}>
                {venues.map((v) => <option key={v.$id} value={v.$id}>{v.name}</option>)}
              </Select>
            </Field>
          )}

          <StockLines
            ingredients={ingredients}
            saved={savedItems}
            draft={draftItems}
            setDraft={setDraftItems}
            decimals={decimals}
            symbol={settings?.currency_symbol ?? ''}
            draftTotal={draftTotal}
            paidTotal={parseMoney(amountText, decimals) ?? 0}
            money={(n) => (settings ? formatMoney(n, settings) : String(n))}
          />

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

/**
 * What was bought, if it was stock.
 *
 * Optional on purpose: a taxi fare has no ingredients. But when the money did
 * buy rice and tomatoes, listing them here means the shopping trip and the
 * stock delivery are one piece of work instead of two, and nobody has to
 * remember to go and type the same numbers into Stock afterwards.
 */
function StockLines({
  ingredients,
  saved,
  draft,
  setDraft,
  decimals,
  symbol,
  draftTotal,
  paidTotal,
  money,
}: {
  ingredients: Ingredient[];
  saved: { $id: string; name_snapshot: string; qty: number; line_total: number }[];
  draft: DraftItem[];
  setDraft: (f: (d: DraftItem[]) => DraftItem[]) => void;
  decimals: number;
  symbol: string;
  draftTotal: number;
  paidTotal: number;
  money: (n: number) => string;
}) {
  const setLine = (i: number, patch: Partial<DraftItem>) =>
    setDraft((d) => d.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));

  const unitOf = (id: string) => ingredients.find((x) => x.$id === id)?.unit ?? '';

  return (
    <Field
      label="Stock bought"
      hint={
        ingredients.length === 0
          ? 'No ingredients set up yet. Add them under Stock, and you will be able to list them here.'
          : 'Optional. Anything you list is added to stock straight away, so you do not have to enter it twice.'
      }
    >
      {saved.length > 0 && (
        <div className="small dim" style={{ marginBottom: '0.5rem' }}>
          Already added to stock from this expense:{' '}
          {saved.map((s) => `${s.qty} × ${s.name_snapshot}`).join(', ')}. Adding more below adds to stock again.
        </div>
      )}

      {draft.length > 0 && (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Ingredient</th>
                <th style={{ width: '6.5rem' }}>Quantity</th>
                <th style={{ width: '8rem' }}>Cost per unit ({symbol})</th>
                <th style={{ width: '2.5rem' }} />
              </tr>
            </thead>
            <tbody>
              {draft.map((d, i) => (
                <tr key={i}>
                  <td>
                    <Select value={d.ingredient_id} onChange={(e) => {
                      const ing = ingredients.find((x) => x.$id === e.target.value);
                      setLine(i, {
                        ingredient_id: e.target.value,
                        // Prefill what you last paid; overwrite it if the price moved.
                        costText: ing ? toInput(ing.base_unit_cost, decimals) : d.costText,
                      });
                    }}>
                      <option value="">— choose —</option>
                      {ingredients.map((x) => <option key={x.$id} value={x.$id}>{x.name}</option>)}
                    </Select>
                  </td>
                  <td>
                    <div className="row" style={{ gap: '0.3rem' }}>
                      <Input
                        type="number"
                        step="any"
                        min="0"
                        value={d.qtyText}
                        onChange={(e) => setLine(i, { qtyText: e.target.value })}
                      />
                      <span className="small dim">{unitOf(d.ingredient_id)}</span>
                    </div>
                  </td>
                  <td>
                    <Input value={d.costText} inputMode="decimal" onChange={(e) => setLine(i, { costText: e.target.value })} />
                  </td>
                  <td className="num">
                    <Button size="sm" variant="ghost" type="button" onClick={() => setDraft((x) => x.filter((_, idx) => idx !== i))}>
                      ✕
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="row" style={{ marginTop: '0.5rem' }}>
        <Button
          size="sm"
          type="button"
          disabled={ingredients.length === 0}
          onClick={() => setDraft((d) => [...d, { ingredient_id: '', qtyText: '', costText: '' }])}
        >
          Add stock item
        </Button>
        {draft.length > 0 && (
          <span className="small dim">
            Lines come to {money(draftTotal)}
            {paidTotal > 0 && draftTotal !== paidTotal && ` · you entered ${money(paidTotal)} paid`}
          </span>
        )}
      </div>

      {draft.length > 0 && paidTotal > 0 && draftTotal > paidTotal && (
        <div style={{ marginTop: '0.5rem' }}>
          <Notice tone="warn">
            The items add up to more than the amount paid. That is allowed — part of a delivery may be on credit — but
            it is worth a second look.
          </Notice>
        </div>
      )}
    </Field>
  );
}
