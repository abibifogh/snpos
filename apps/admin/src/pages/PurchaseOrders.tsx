import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, Field, Input, Modal, Notice, Segmented, Select, Spinner, Textarea, useToast } from '@snpos/ui';
import { humanError } from '../lib';
import {
  loadPurchaseOrders, loadOrderables, savePurchaseOrder, markOrderSent, askToEmailOrder, cancelPurchaseOrder,
  suggestions, suggestLine, orderTotal, poLineTotal, orderProblem, orderMessage, readLines, stillToCome,
  isEditableOrder, isOpenOrder, orderNeedsApproval, canOrderStock, PO_STATUS_WORDS,
  loadFeatures, featureConfig, formatMoney, parseMoney, toInput, dateTimeWords, downloadFile, MODULE_LABELS,
  modulesOf, SIDE_NAMES, itemsFor, newSupplierProblem, addSupplier,
  ORDER_ROLES, orderRoles, orderRolesValue, saveDropping,
} from '@snpos/core';
import type { PurchaseOrderDoc, PoLine, OrderSupplier, Ingredient, Module, Suggestion, FeatureMap } from '@snpos/core';
/* The same builder the email attaches, so the office's copy and the
   supplier's are one document. See functions/notify/src/po-pdf.js. */
import { purchaseOrderPdf } from '../../../../functions/notify/src/po-pdf.js';
import { useSession } from '../session';

type Show = 'open' | 'received' | 'all';

/**
 * Orders to suppliers.
 *
 * Opens on what is running low, already grouped by supplier and worked out
 * in the packs it is bought in, so making an order is choosing one and
 * changing what needs changing. An order is sent as a PDF, a message pasted
 * into WhatsApp, or an email; one over the owner's limit waits on Waiting
 * for you first. It is received through the spend that pays for it — pick
 * the order on the spend form and its items fill in. See purchase-orders.ts.
 *
 * Who may make and send orders is set per person on Staff ("Order stock").
 * Anybody who can open this page can read it.
 */
export function PurchaseOrdersPage() {
  const toast = useToast();
  const { settings, profile, user, refreshSettings } = useSession();
  const mayOrder = canOrderStock(profile, settings);
  const isAdmin = profile?.role === 'admin';
  const [orders, setOrders] = useState<PurchaseOrderDoc[] | null>(null);
  const [items, setItems] = useState<Ingredient[]>([]);
  const [suppliers, setSuppliers] = useState<OrderSupplier[]>([]);
  const [features, setFeatures] = useState<FeatureMap>({});
  const [error, setError] = useState<string | null>(null);
  const [show, setShow] = useState<Show>('open');
  /** The order being written or read: an existing one, or a new one's starting lines. */
  const [open, setOpen] = useState<{ order?: PurchaseOrderDoc; start?: Suggestion } | null>(null);

  const load = async () => {
    setError(null);
    try {
      const [o, what, f] = await Promise.all([
        loadPurchaseOrders('main'), loadOrderables('main'), loadFeatures().catch(() => ({} as FeatureMap)),
      ]);
      setOrders(o);
      setItems(what.items);
      setSuppliers(what.suppliers);
      setFeatures(f);
      // Keep the open order in step with what was just saved.
      setOpen((cur) => (cur?.order ? { order: o.find((x) => x.$id === cur.order!.$id) ?? cur.order } : cur));
    } catch (e) {
      setError(humanError(e));
      setOrders([]);
    }
  };
  useEffect(() => { void load(); }, []);

  const money = (n: number) => (settings ? formatMoney(n, settings) : String(n));
  /** The departments the business runs, each ordering its own stock. */
  const mods = modulesOf(settings);
  const sides = (['kitchen', 'bar', 'craft'] as Module[]).filter((m) => mods[m]);
  /** Adding to the supplier list is a manager's job, as it is under Stock. */
  const mayAddSupplier = profile?.role === 'admin' || profile?.role === 'manager';
  const lowBp = settings?.low_stock_default_bp ?? 3000;
  const limit = featureConfig(features, 'purchase_orders', 'approve_over', 100000);
  /*
    What is already on an order that has not arrived is not suggested again:
    ordering Club on Monday and seeing it suggested on Tuesday, before the
    crates came, is how it gets ordered twice.
  */
  const onOrder = useMemo(() => new Set((orders ?? [])
    .filter((o) => isOpenOrder(o.status) || o.status === 'waiting' || o.status === 'draft')
    .flatMap((o) => stillToCome(readLines(o.lines)).map((l) => l.ingredient_id))), [orders]);
  const ideas = useMemo(
    () => suggestions(items.filter((i) => !onOrder.has(i.$id)) as never, suppliers, lowBp),
    [items, suppliers, lowBp, onOrder],
  );

  const shown = (orders ?? []).filter((o) =>
    show === 'all' ? true : show === 'received' ? o.status === 'received' : !['received', 'cancelled'].includes(o.status));

  return (
    <>
      <div className="spread">
        <div>
          <h1>Purchase orders</h1>
          <p className="dim small" style={{ margin: '0.2rem 0 0', maxWidth: '64ch' }}>
            Orders to suppliers for things running low. Send one as a PDF, a message or an email. When the goods
            arrive, record the spend as usual and pick the order: its items fill in and go into stock.
            {limit > 0 && ` Orders over ${money(limit)} wait on Waiting for you before they can be sent.`}
          </p>
        </div>
        {mayOrder && <Button variant="primary" onClick={() => setOpen({})}>New order</Button>}
      </div>

      {error && <Notice>{error}</Notice>}
      {!mayOrder && (
        <Notice tone="info">You can read orders here. An admin can let your role make them, on this page, or you alone, under Staff.</Notice>
      )}
      {isAdmin && settings && <WhoOrders settings={settings} onSaved={refreshSettings} toast={toast} />}

      {mayOrder && orders && (
        <Card title={ideas.length ? `Running low (${ideas.reduce((n, g) => n + g.lines.length, 0)} items)` : 'Running low'}>
          {ideas.length === 0 ? (
            <p className="small dim" style={{ margin: 0 }}>Nothing is running low that is not already on an order.</p>
          ) : (
            <div style={{ display: 'grid', gap: '0.6rem' }}>
              <p className="small dim" style={{ margin: 0 }}>
                Worked out to bring each item back to its full level, in the packs it is bought in. Set the full
                level, pack and supplier for an item under Stock.
              </p>
              {ideas.map((g) => (
                <div key={`${g.supplierId || 'none'}|${g.module}`} className="spread" style={{ borderTop: '1px solid var(--border)', paddingTop: '0.5rem', alignItems: 'center' }}>
                  <div>
                    <strong>{g.supplierName}</strong>
                    {sides.length > 1 && <span className="small dim"> · {SIDE_NAMES[g.module as Module] ?? g.module}</span>}
                    <div className="small dim">
                      {g.lines.slice(0, 4).map((l) => `${l.name} × ${l.qty} ${l.buy_label}`).join(', ')}
                      {g.lines.length > 4 ? `, and ${g.lines.length - 4} more` : ''}
                    </div>
                  </div>
                  <div className="row" style={{ gap: '0.6rem', alignItems: 'center' }}>
                    <span className="small">{money(g.total)}</span>
                    <Button size="sm" variant="primary" onClick={() => setOpen({ start: g })}>Make this order</Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      <div style={{ margin: '1rem 0 0.6rem' }}>
        <Segmented<Show>
          value={show}
          onChange={setShow}
          ariaLabel="Which orders"
          options={[{ value: 'open', label: 'Open' }, { value: 'received', label: 'Received' }, { value: 'all', label: 'All' }]}
        />
      </div>

      <Card pad={false}>
        {orders === null ? <div className="card-pad"><Spinner /></div> : shown.length === 0 ? (
          <div className="card-pad"><p className="small dim" style={{ margin: 0 }}>No orders here.</p></div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Order</th><th>Supplier</th><th>Items</th><th className="num">Total</th><th>Status</th><th /></tr>
              </thead>
              <tbody>
                {shown.map((o) => {
                  const lines = readLines(o.lines).filter((l) => l.qty > 0);
                  const st = PO_STATUS_WORDS[o.status] ?? PO_STATUS_WORDS.draft;
                  return (
                    <tr key={o.$id}>
                      <td>
                        <strong>{o.po_no}</strong>
                        <div className="small dim">{o.$createdAt ? dateTimeWords(o.$createdAt) : ''}{o.created_by_name ? ` · ${o.created_by_name}` : ''}</div>
                      </td>
                      <td>{o.supplier_name || '-'}<div className="small dim">{MODULE_LABELS[(o.module ?? 'kitchen') as Module]}</div></td>
                      <td className="small">{lines.length}</td>
                      <td className="num">{money(o.total ?? 0)}</td>
                      <td>
                        <Badge tone={st.tone}>{st.label}</Badge>
                        {o.email_error && <div className="small" style={{ color: 'var(--danger)' }}>Email failed</div>}
                      </td>
                      <td className="num"><Button size="sm" onClick={() => setOpen({ order: o })}>Open</Button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {open && settings && (
        <OrderModal
          order={open.order}
          start={open.start}
          items={items}
          suppliers={suppliers}
          sides={sides}
          mayAddSupplier={mayAddSupplier}
          onSupplierAdded={(sup) => setSuppliers((cur) => [...cur, sup].sort((a, b) => a.name.localeCompare(b.name)))}
          limit={limit}
          mayOrder={mayOrder}
          isAdmin={isAdmin}
          userId={user?.$id ?? ''}
          userName={profile?.display_name ?? ''}
          settings={settings}
          money={money}
          onClose={() => setOpen(null)}
          onSaved={async (words, keepOpen) => {
            toast(words);
            if (!keepOpen) setOpen(null);
            await load();
          }}
          onError={(m) => toast(m, 'err')}
        />
      )}
    </>
  );
}

const ROLE_WORDS: Record<string, string> = { manager: 'Managers', cashier: 'Cashiers', waiter: 'Waiters', cook: 'Cooks' };

/**
 * Which roles may make and send orders. An admin's choice, here where the
 * orders are; one person can still be made an exception on Staff.
 */
function WhoOrders({ settings, onSaved, toast }: {
  settings: NonNullable<ReturnType<typeof useSession>['settings']>;
  onSaved: () => Promise<void>;
  toast: (m: string, t?: 'ok' | 'err') => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const roles = orderRoles(settings);
  const flip = async (role: string) => {
    const next = roles.includes(role as never) ? roles.filter((r) => r !== role) : [...roles, role];
    setBusy(role);
    try {
      const { dropped } = await saveDropping('settings', settings.$id, { po_order_roles: orderRolesValue(next) });
      if (dropped.includes('po_order_roles')) {
        toast('This database cannot keep that yet. Run Provision in GitHub Actions, then try again.', 'err');
        return;
      }
      await onSaved();
      toast(next.length ? `${next.map((r) => ROLE_WORDS[r]).join(', ')} can make orders.` : 'Only admins can make orders now.');
    } catch (e) {
      toast(humanError(e), 'err');
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card title="Who can make orders" pad>
      <p className="small dim" style={{ marginTop: 0 }}>
        Admins always can. Tick the roles that may make and send orders; one person can be made an exception
        either way under Staff, Make purchase orders. Orders over the limit still wait for approval.
      </p>
      <div className="row row-wrap" style={{ gap: '1.2rem' }}>
        {ORDER_ROLES.map((r) => (
          <label key={r} className="row" style={{ gap: '0.4rem', alignItems: 'center', cursor: 'pointer' }}>
            <input type="checkbox" checked={roles.includes(r)} disabled={!!busy} onChange={() => void flip(r)} />
            {ROLE_WORDS[r]}
          </label>
        ))}
      </div>
    </Card>
  );
}

/** One order: written, read, sent. */
function OrderModal({
  order, start, items, suppliers, sides, mayAddSupplier, onSupplierAdded,
  limit, mayOrder, isAdmin, userId, userName, settings, money, onClose, onSaved, onError,
}: {
  order?: PurchaseOrderDoc;
  start?: Suggestion;
  items: Ingredient[];
  suppliers: OrderSupplier[];
  /** The departments to order for. One order is one department's stock. */
  sides: Module[];
  mayAddSupplier: boolean;
  onSupplierAdded: (s: OrderSupplier) => void;
  limit: number;
  mayOrder: boolean;
  isAdmin: boolean;
  userId: string;
  userName: string;
  settings: NonNullable<ReturnType<typeof useSession>['settings']>;
  money: (n: number) => string;
  onClose: () => void;
  onSaved: (words: string, keepOpen?: boolean) => Promise<void>;
  onError: (m: string) => void;
}) {
  const decimals = settings.currency_decimals ?? 2;
  const editable = mayOrder && (!order || isEditableOrder(order.status));
  const [supplierId, setSupplierId] = useState(order?.supplier_id ?? start?.supplierId ?? '');
  const [lines, setLines] = useState<PoLine[]>(() => (order ? readLines(order.lines) : start?.lines ?? []));
  const [costText, setCostText] = useState<Record<number, string>>(() =>
    Object.fromEntries((order ? readLines(order.lines) : start?.lines ?? []).map((l, i) => [i, toInput(l.unit_cost, decimals)])));
  const [note, setNote] = useState(order?.note ?? '');
  const [neededBy, setNeededBy] = useState(order?.expected_on ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  /**
   * Which department this order is for, and so whose items it offers.
   *
   * It used to be read off the first item, with every side's stock in one
   * list: the bar's Club next to the kitchen's oil, and an order that mixed
   * them filed under whichever came first.
   */
  const [side, setSide] = useState<Module>(() => {
    const from = (order?.module ?? start?.module) as Module | undefined;
    return from && sides.includes(from) ? from : (from ?? sides[0] ?? 'kitchen');
  });
  const mine = useMemo(() => itemsFor(items, side), [items, side]);
  /** A supplier not on the list yet, typed in here. */
  const NEW = '__new';
  const [fresh, setFresh] = useState({ name: '', phone: '', email: '' });
  const adding = supplierId === NEW;

  const pickSide = (next: Module) => {
    if (next === side) return;
    const filled = lines.some((l) => l.ingredient_id);
    if (filled && !confirm(`Switch this order to ${SIDE_NAMES[next]}? The items on it are ${SIDE_NAMES[side]}'s, so they will be cleared.`)) return;
    setSide(next);
    if (filled) {
      setLines([{ ingredient_id: '', name: '', unit: '', buy_key: 'unit', buy_label: '', per: 1, qty: 1, unit_cost: 0, received_qty: 0 }]);
      setCostText({});
    }
  };

  const supplier = suppliers.find((s) => s.$id === supplierId);
  const total = orderTotal(lines);
  const draft = { supplier_name: adding ? fresh.name : supplier?.name ?? order?.supplier_name ?? '', lines };
  const problem = orderProblem(draft);
  const status = order?.status;

  const setLine = (i: number, patch: Partial<PoLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const pickItem = (i: number, id: string) => {
    const ing = items.find((x) => x.$id === id);
    if (!ing) return;
    const fresh = suggestLine(ing as never);
    setLine(i, fresh);
    setCostText((c) => ({ ...c, [i]: toInput(fresh.unit_cost, decimals) }));
  };
  const switchBuy = (i: number, key: 'pack' | 'unit') => {
    const l = lines[i];
    const ing = items.find((x) => x.$id === l?.ingredient_id) as (Ingredient & { pack_size?: number; pack_name?: string }) | undefined;
    if (!l || !ing) return;
    const per = key === 'pack' ? (ing.pack_size ?? 1) : 1;
    const each = Math.round((l.unit_cost / (l.per || 1)) * per);
    setLine(i, { buy_key: key, per, unit_cost: each, buy_label: key === 'pack' ? `${(ing.pack_name || 'pack').replace(/s$/, '')}s` : `${ing.unit}s` });
    setCostText((c) => ({ ...c, [i]: toInput(each, decimals) }));
  };

  const run = async (key: string, fn: () => Promise<string | undefined>, keepOpen = false) => {
    setBusy(key);
    try {
      const words = await fn();
      if (words) await onSaved(words, keepOpen);
    } catch (e) {
      onError(humanError(e));
    } finally {
      setBusy(null);
    }
  };

  const save = (submit: boolean) => run(submit ? 'submit' : 'draft', async () => {
    let to = supplier;
    let typed: { name: string; email?: string; phone?: string } | null = null;
    if (adding) {
      const why = newSupplierProblem(fresh.name, suppliers);
      if (why) throw new Error(why);
      if (mayAddSupplier) {
        // Onto the list first, so the order points at a real supplier and the
        // next order finds it.
        to = await addSupplier(fresh);
        onSupplierAdded(to);
        setSupplierId(to.$id);
      } else {
        typed = { name: fresh.name.trim(), email: fresh.email.trim(), phone: fresh.phone.trim() };
      }
    }
    if (submit && problem) throw new Error(problem);
    if (!to && !typed && !order?.supplier_name) throw new Error('Choose who the order is going to.');
    const saved = await savePurchaseOrder({
      id: order?.$id,
      venueId: 'main',
      module: side,
      supplier: to
        ? { $id: to.$id, name: to.name, email: to.email, phone: to.phone }
        : typed ?? { $id: order?.supplier_id, name: order?.supplier_name ?? '', email: order?.supplier_email, phone: order?.supplier_phone },
      lines,
      note,
      expectedOn: neededBy,
      submit,
      approveOver: limit,
      isAdmin,
      by: userId,
      byName: userName,
    });
    if (!submit) return `${saved.po_no} saved as a draft.`;
    return saved.status === 'waiting'
      ? `${saved.po_no} is over ${money(limit)}, so it waits on Waiting for you before it can be sent.`
      : `${saved.po_no} is ready to send.`;
  });

  const copy = () => run('copy', async () => {
    if (!order) return undefined;
    const text = orderMessage({ ...order, lines: readLines(order.lines) }, settings.restaurant_name, userName);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      throw new Error('This browser would not copy. Download the PDF and send that instead.');
    }
    return 'Copied. Paste it into WhatsApp or a text, then press Mark as sent.';
  }, true);

  const pdf = () => run('pdf', async () => {
    if (!order) return undefined;
    downloadFile(`${order.po_no}.pdf`, purchaseOrderPdf({ order, settings, accent: settings.primary_color ?? '#0f766e' }), 'application/pdf');
    return undefined;
  });

  const email = () => run('email', async () => {
    if (!order) return undefined;
    await askToEmailOrder(order.$id);
    return `Emailing ${order.po_no} to ${order.supplier_email}. It goes out in the next minute.`;
  }, true);

  const sent = (via: string) => run('sent', async () => {
    if (!order) return undefined;
    await markOrderSent(order.$id, via);
    return `${order.po_no} marked as sent.`;
  });

  const cancel = () => run('cancel', async () => {
    if (!order) return undefined;
    if (!confirm(`Cancel ${order.po_no}? It stays on the list, marked cancelled.`)) return undefined;
    await cancelPurchaseOrder(order.$id);
    return `${order.po_no} cancelled.`;
  });

  const title = order ? `${order.po_no} · ${order.supplier_name || 'No supplier'}` : 'New order';
  const st = order ? PO_STATUS_WORDS[order.status] : null;
  const sendable = !!order && mayOrder && (status === 'ready' || status === 'sent' || status === 'part');

  return (
    <Modal wide title={title} onClose={onClose}>
      <div style={{ display: 'grid', gap: '0.8rem' }}>
        {st && (
          <div className="row" style={{ gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <Badge tone={st.tone}>{st.label}</Badge>
            {order?.sent_at && <span className="small dim">Sent {dateTimeWords(order.sent_at)}{order.sent_via ? ` by ${order.sent_via}` : ''}</span>}
          </div>
        )}
        {status === 'waiting' && <Notice tone="info">Over {money(limit)}, so it is on Waiting for you. It can be sent once it is approved.</Notice>}
        {status === 'refused' && (
          <Notice tone="warn">Not approved{order?.decided_note ? `: “${order.decided_note}”` : ''}. Change it and press Done to ask again, or cancel it.</Notice>
        )}
        {order?.email_error && <Notice>{order.email_error}</Notice>}

        {editable ? (
          <>
            {sides.length > 1 && (
              <Field label="Department" hint="Only this department's stock is offered below. It is received into its store and paid from its books.">
                <Segmented<Module>
                  value={side}
                  onChange={pickSide}
                  ariaLabel="Which department"
                  options={sides.map((m) => ({ value: m, label: SIDE_NAMES[m] }))}
                />
              </Field>
            )}
            {mine.length === 0 && (
              <Notice tone="info">
                {SIDE_NAMES[side]} has no stock items yet. Add them under Stock, {SIDE_NAMES[side]}, and they appear here.
              </Notice>
            )}
            <Field label="Supplier" hint={supplier && !supplier.email ? 'No email address for this supplier: send it as a PDF or a message.' : undefined}>
              <Select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                <option value="">{order?.supplier_name && !supplierId ? order.supplier_name : 'Choose…'}</option>
                {suppliers.map((s) => <option key={s.$id} value={s.$id}>{s.name}</option>)}
                <option value={NEW}>+ A new supplier…</option>
              </Select>
            </Field>
            {/* Not on the list: typed here. A manager's goes onto the list
                when the order is saved; anybody else's is kept on this order
                only, for a manager to add under Stock → Suppliers. */}
            {adding && (
              <div className="grid-3" style={{ display: 'grid', gap: '0.6rem', gridTemplateColumns: 'repeat(auto-fit, minmax(12rem, 1fr))' }}>
                <Field label="Name"><Input value={fresh.name} autoFocus onChange={(e) => setFresh({ ...fresh, name: e.target.value })} /></Field>
                <Field label="Phone (optional)"><Input value={fresh.phone} inputMode="tel" onChange={(e) => setFresh({ ...fresh, phone: e.target.value })} /></Field>
                <Field label="Email (optional)" hint="Needed to email the order.">
                  <Input value={fresh.email} type="email" onChange={(e) => setFresh({ ...fresh, email: e.target.value })} />
                </Field>
                {!mayAddSupplier && (
                  <p className="small dim" style={{ margin: 0, gridColumn: '1 / -1' }}>
                    Kept on this order only. A manager can add them to the supplier list under Stock → Suppliers.
                  </p>
                )}
              </div>
            )}
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Item</th><th className="num">How many</th><th>Of</th><th className="num">Price each</th><th className="num">Total</th><th /></tr></thead>
                <tbody>
                  {lines.map((l, i) => {
                    const ing = items.find((x) => x.$id === l.ingredient_id) as (Ingredient & { pack_size?: number; pack_name?: string }) | undefined;
                    const packs = !!ing && (ing.pack_size ?? 0) > 1;
                    return (
                      <tr key={i}>
                        <td>
                          <Select value={l.ingredient_id} onChange={(e) => pickItem(i, e.target.value)}>
                            <option value="">Choose…</option>
                            {mine.map((x) => <option key={x.$id} value={x.$id}>{x.name}</option>)}
                            {/* An item from another department, on an order written before this asked. */}
                            {ing && !mine.some((x) => x.$id === ing.$id) && <option value={ing.$id}>{ing.name}</option>}
                          </Select>
                          {ing && <div className="small dim">{ing.current_qty} {ing.unit} left{ing.par_level ? `, full is ${ing.par_level}` : ''}</div>}
                        </td>
                        <td className="num" style={{ width: '6rem' }}>
                          <Input value={String(l.qty)} inputMode="decimal" onChange={(e) => setLine(i, { qty: Number(e.target.value) || 0 })} />
                        </td>
                        <td style={{ width: '9rem' }}>
                          {packs ? (
                            <Select value={l.buy_key} onChange={(e) => switchBuy(i, e.target.value as 'pack' | 'unit')}>
                              <option value="pack">{(ing.pack_name || 'pack')}s of {ing.pack_size}</option>
                              <option value="unit">{ing.unit}s</option>
                            </Select>
                          ) : <span className="small">{l.buy_label}</span>}
                        </td>
                        <td className="num" style={{ width: '8rem' }}>
                          <Input
                            value={costText[i] ?? ''}
                            inputMode="decimal"
                            onChange={(e) => {
                              setCostText((c) => ({ ...c, [i]: e.target.value }));
                              setLine(i, { unit_cost: parseMoney(e.target.value, decimals) ?? 0 });
                            }}
                          />
                        </td>
                        <td className="num">{money(poLineTotal(l))}</td>
                        <td className="num">
                          <Button size="sm" variant="ghost" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>Remove</Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="spread">
              <Button size="sm" onClick={() => setLines((ls) => [...ls, {
                ingredient_id: '', name: '', unit: '', buy_key: 'unit', buy_label: '', per: 1, qty: 1, unit_cost: 0, received_qty: 0,
              }])}>
                + Add an item
              </Button>
              <strong>Total {money(total)}</strong>
            </div>
            <div className="grid-2">
              <Field label="Needed by (optional)"><Input type="date" value={neededBy} onChange={(e) => setNeededBy(e.target.value)} /></Field>
              <Field label="Note to the supplier (optional)"><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
            </div>
            {!isAdmin && orderNeedsApproval(total, limit) && (
              <Notice tone="info">Over {money(limit)}: once done, it waits on Waiting for you before it can be sent.</Notice>
            )}
            <div className="row" style={{ gap: '0.5rem', justifyContent: 'flex-end' }}>
              <Button loading={busy === 'draft'} disabled={!!busy} onClick={() => void save(false)}>Save as draft</Button>
              <Button variant="primary" loading={busy === 'submit'} disabled={!!busy || !!problem} onClick={() => void save(true)}>
                Done{!isAdmin && orderNeedsApproval(total, limit) ? ', send for approval' : ''}
              </Button>
            </div>
          </>
        ) : order ? (
          <>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Item</th><th className="num">Ordered</th><th className="num">Arrived</th><th className="num">Price each</th><th className="num">Total</th></tr></thead>
                <tbody>
                  {readLines(order.lines).filter((l) => l.qty > 0).map((l, i) => (
                    <tr key={i}>
                      <td>{l.name}</td>
                      <td className="num">{l.qty} {l.buy_label}</td>
                      <td className="num">{l.received_qty ? `${Number(l.received_qty.toFixed(2))}` : '—'}</td>
                      <td className="num">{money(l.unit_cost)}</td>
                      <td className="num">{money(poLineTotal(l))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="spread"><span className="small dim">{order.note}</span><strong>Total {money(order.total ?? 0)}</strong></div>
          </>
        ) : null}

        {/* Sending: any of three ways, then say it has gone. */}
        {sendable && (
          <Card title="Send it">
            <div className="row" style={{ gap: '0.5rem', flexWrap: 'wrap' }}>
              <Button loading={busy === 'pdf'} disabled={!!busy} onClick={() => void pdf()}>Download PDF</Button>
              <Button loading={busy === 'copy'} disabled={!!busy} onClick={() => void copy()}>Copy as a message</Button>
              {order?.supplier_email ? (
                order.email_send_at
                  ? <span className="small dim">Emailing…</span>
                  : <Button loading={busy === 'email'} disabled={!!busy} onClick={() => void email()}>Email to {order.supplier_email}</Button>
              ) : <span className="small dim">No email address for this supplier.</span>}
            </div>
            {status === 'ready' && (
              <div className="row" style={{ gap: '0.5rem', marginTop: '0.6rem', alignItems: 'center' }}>
                <span className="small dim">Sent it another way?</span>
                <Button size="sm" disabled={!!busy} onClick={() => void sent('message')}>Mark as sent</Button>
              </div>
            )}
            <p className="small dim" style={{ marginBottom: 0 }}>
              When it arrives, record the spend as usual and choose {order?.po_no} under "For an order".
            </p>
          </Card>
        )}

        {order && mayOrder && !['received', 'cancelled', 'part'].includes(order.status) && (
          <div style={{ textAlign: 'right' }}>
            <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void cancel()}>Cancel this order</Button>
          </div>
        )}
      </div>
    </Modal>
  );
}
