import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Badge, Button, Card, Field, Input, Modal, Notice, Segmented, Select, Spinner, Textarea, useToast, ExpenseModal, InfoTip } from '@snpos/ui';
import { humanError } from '../lib';
import {
  loadPurchaseOrders, loadOrderables, savePurchaseOrder, markOrderSent, askToEmailOrder, cancelPurchaseOrder,
  suggestions, suggestLine, orderTotal, poLineTotal, orderProblem, orderMessage, readLines, stillToCome,
  isEditableOrder, isOpenOrder, orderNeedsApproval, canOrderStock, PO_STATUS_WORDS,
  loadFeatures, featureConfig, formatMoney, dateTimeWords, downloadFile, MODULE_LABELS,
  modulesOf, SIDE_NAMES, itemsFor, newSupplierProblem, addSupplier, parseUnitPrice, unitPriceInput, parseQty,
  ORDER_ROLES, orderRoles, orderRolesValue, saveDropping, canOpen,
  paidFromFloat, floatOrderProblem, unmatchedLines, lineForItem, downloadUrl, brandColour } from '@snpos/core';
import type { PurchaseOrderDoc, PoLine, OrderSupplier, Ingredient, Module, Suggestion, FeatureMap, Settings } from '@snpos/core';
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
 *
 * An order can also arrive from Insight, the group hub: something a float
 * holder there has already bought and paid for. It lands as a draft to be
 * checked, each line given its stock item, and received; it is never sent
 * and never waits for approval. See docs/21-insight-floats.md.
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
  /** `?show=<id>` opens that order, as Insight's links do. */
  const [params, setParams] = useSearchParams();
  const showId = params.get('show');
  /** The order being written or read: an existing one, or a new one's starting lines. */
  const [open, setOpen] = useState<{ order?: PurchaseOrderDoc; start?: Suggestion } | null>(null);
  /**
   * The order whose delivery is being recorded, on the till's own spend form
   * with the order already picked. The same form, so a delivery booked here
   * reaches the shelf and the books exactly as one booked at a till does.
   */
  const [receiving, setReceiving] = useState<PurchaseOrderDoc | null>(null);
  /** Recording a spend here is the Spending page's permission. */
  const mayReceive = canOpen('expenses', profile, settings);

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
  useEffect(() => {
    if (!showId || !orders) return;
    const o = orders.find((x) => x.$id === showId);
    if (o) setOpen({ order: o });
    // Once: closing it should not open it again.
    setParams((p) => { p.delete('show'); return p; }, { replace: true });
  }, [showId, orders, setParams]);

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
          <h1>
            Purchase orders
            <InfoTip>
              Orders to suppliers for things running low. Send one as a PDF, a message or an email. When the goods
              arrive, press Record the delivery on the order, or record the spend at a till and pick the order: its
              items fill in and go into stock.
              {limit > 0 && ` Orders over ${money(limit)} wait on Approvals before they can be sent.`}
            </InfoTip>
          </h1>
        </div>
        {mayOrder && <Button variant="primary" onClick={() => setOpen({})}>New order</Button>}
      </div>

      {error && <Notice>{error}</Notice>}
      {!mayOrder && (
        <Notice tone="info">You can read orders here. An admin can let your role make them, on this page, or you alone, under Staff.</Notice>
      )}
      {isAdmin && settings && <WhoOrders settings={settings} onSaved={refreshSettings} toast={toast} />}

      {mayOrder && orders && (
        <Card title={ideas.length ? `Running low (${ideas.reduce((n, g) => n + g.lines.length, 0)} items)` : 'Running low'}
          help={
            <>
              Worked out to bring each item back to its full level, in the packs it is bought in. Set the full
              level, pack and supplier for an item under Stock.
            </>
          }
        >
          {ideas.length === 0 ? (
            <p className="small dim" style={{ margin: 0 }}>Nothing is running low that is not already on an order.</p>
          ) : (
            <div style={{ display: 'grid', gap: '0.6rem' }}>
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
                        {paidFromFloat(o) && <> <Badge tone="default">From Insight</Badge></>}
                        <div className="small dim">{o.$createdAt ? dateTimeWords(o.$createdAt) : ''}{o.created_by_name ? ` · ${o.created_by_name}` : ''}</div>
                      </td>
                      <td>{o.supplier_name || '-'}<div className="small dim">{MODULE_LABELS[(o.module ?? 'kitchen') as Module]}</div></td>
                      <td className="small">{lines.length}</td>
                      <td className="num">{money(o.total ?? 0)}</td>
                      <td>
                        <Badge tone={st.tone}>{st.label}</Badge>
                        {o.email_error && <div className="small" style={{ color: 'var(--danger)' }}>Email failed</div>}
                      </td>
                      <td className="num">
                        <div className="row" style={{ gap: '0.4rem', justifyContent: 'flex-end' }}>
                          {mayReceive && isOpenOrder(o.status) && (
                            <Button size="sm" variant="primary" onClick={() => setReceiving(o)}>Record the delivery</Button>
                          )}
                          <Button size="sm" onClick={() => setOpen({ order: o })}>Open</Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {receiving && settings && (
        <ExpenseModal
          receive
          desk="office"
          module={(receiving.module ?? 'kitchen') as Module}
          venueId={receiving.venue_id || 'main'}
          shiftId=""
          settings={settings as Settings}
          userId={user?.$id ?? ''}
          forOrder={receiving.$id}
          onClose={() => setReceiving(null)}
          onDone={(m) => {
            setReceiving(null);
            toast(m);
            void load();
          }}
        />
      )}

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
          onReceive={mayReceive ? (o) => { setOpen(null); setReceiving(o); } : undefined}
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
    <Card title="Who can make orders" pad
      help={
        <>
          Admins always can. Tick the roles that may make and send orders; one person can be made an exception
          either way under Staff, Make purchase orders. Orders over the limit still wait for approval.
        </>
      }
    >
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
  limit, mayOrder, isAdmin, userId, userName, settings, money, onClose, onSaved, onError, onReceive,
}: {
  /** Record the delivery for this order, where the person may record spending. */
  onReceive?: (o: PurchaseOrderDoc) => void;
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
  /** A unit price as written: whole pesewas as money, a finer one with its extra places. */
  const priceEach = (n: number) => (Number.isInteger(n) ? money(n) : `${settings.currency_symbol ?? ''}${unitPriceInput(n, decimals)}`);
  const editable = mayOrder && (!order || isEditableOrder(order.status));
  /** Bought out of a float in Insight and already paid: checked and received, never sent. */
  const float = paidFromFloat(order);
  const [supplierId, setSupplierId] = useState(order?.supplier_id ?? start?.supplierId ?? '');
  const [lines, setLines] = useState<PoLine[]>(() => (order ? readLines(order.lines) : start?.lines ?? []));
  /**
   * What is typed in each line's How many and Price each, beside the line.
   *
   * Kept as text while it is typed, so "1." and "0.35" can be typed at all:
   * a box that turned each keystroke into a number and back dropped the
   * point before the next digit arrived. One entry per line, removed with it,
   * so taking a line out never moves another line's price onto its neighbour.
   */
  const [text, setText] = useState<{ qty: string; cost: string }[]>(() =>
    (order ? readLines(order.lines) : start?.lines ?? []).map((l) => ({ qty: String(l.qty), cost: unitPriceInput(l.unit_cost, decimals) })));
  const setTextAt = (i: number, patch: Partial<{ qty: string; cost: string }>) =>
    setText((t) => t.map((x, j) => (j === i ? { ...x, ...patch } : x)));
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
      setText([{ qty: '1', cost: '' }]);
    }
  };

  const supplier = suppliers.find((s) => s.$id === supplierId);
  const total = orderTotal(lines);
  const draft = { supplier_name: adding ? fresh.name : supplier?.name ?? order?.supplier_name ?? '', lines };
  const problem = float ? floatOrderProblem(lines) ?? orderProblem(draft) : orderProblem(draft);
  const toPick = float ? unmatchedLines(lines).length : 0;
  const status = order?.status;

  const setLine = (i: number, patch: Partial<PoLine>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const pickItem = (i: number, id: string) => {
    const ing = items.find((x) => x.$id === id);
    if (!ing) return;
    // From a float: what was bought and paid stays; only what it is changes.
    if (float) { setLine(i, lineForItem(lines[i], ing as never)); return; }
    const fresh = suggestLine(ing as never);
    setLine(i, fresh);
    setTextAt(i, { qty: String(fresh.qty), cost: unitPriceInput(fresh.unit_cost, decimals) });
  };
  const switchBuy = (i: number, key: 'pack' | 'unit') => {
    const l = lines[i];
    const ing = items.find((x) => x.$id === l?.ingredient_id) as (Ingredient & { pack_size?: number; pack_name?: string }) | undefined;
    if (!l || !ing) return;
    const per = key === 'pack' ? (ing.pack_size ?? 1) : 1;
    const label = key === 'pack' ? `${(ing.pack_name || 'pack').replace(/s$/, '')}s` : `${ing.unit}s`;
    // From a float the price of one is what was paid over how many, whichever
    // they are counted in, so it does not move.
    if (float) { setLine(i, { buy_key: key, per, buy_label: label }); return; }
    // Kept to the same two extra places a typed price has, so a per-unit
    // price worked back from a pack keeps its fraction of a pesewa.
    const each = Math.round((l.unit_cost / (l.per || 1)) * per * 100) / 100;
    setLine(i, { buy_key: key, per, unit_cost: each, buy_label: key === 'pack' ? `${(ing.pack_name || 'pack').replace(/s$/, '')}s` : `${ing.unit}s` });
    setTextAt(i, { cost: unitPriceInput(each, decimals) });
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
        to = await addSupplier({ venueId: 'main', ...fresh });
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
      alreadyPaid: float,
    });
    if (!submit) return `${saved.po_no} saved as a draft.`;
    if (float) {
      // Checked: straight on to receiving it, where the person may.
      if (onReceive) { onReceive(saved); return `${saved.po_no} checked. Record what came in.`; }
      return `${saved.po_no} checked and ready to receive, at a till or here.`;
    }
    return saved.status === 'waiting'
      ? `${saved.po_no} is over ${money(limit)}, so it waits on Approvals before it can be sent. The admins are being emailed.`
      : `${saved.po_no} is ready to send. The admins are being emailed.`;
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
    downloadFile(`${order.po_no}.pdf`, purchaseOrderPdf({ order, settings, accent: brandColour(settings.primary_color) }), 'application/pdf');
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
  const sendable = !!order && mayOrder && !float && (status === 'ready' || status === 'sent' || status === 'part');

  return (
    <Modal wide title={title} onClose={onClose}>
      <div style={{ display: 'grid', gap: '0.8rem' }}>
        {st && (
          <div className="row" style={{ gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <Badge tone={st.tone}>{st.label}</Badge>
            {order?.sent_at && <span className="small dim">Sent {dateTimeWords(order.sent_at)}{order.sent_via ? ` by ${order.sent_via}` : ''}</span>}
          </div>
        )}
        {status === 'waiting' && <Notice tone="info">Over {money(limit)}, so it is on Approvals. It can be sent once it is approved.</Notice>}
        {status === 'refused' && (
          <Notice tone="warn">Not approved{order?.decided_note ? `: “${order.decided_note}”` : ''}. Change it and press Done to ask again, or cancel it.</Notice>
        )}
        {order?.email_error && <Notice>{order.email_error}</Notice>}
        {/* Where it came from and who paid, from Insight's own words. */}
        {order && float && (
          <Notice tone="info">
            <div>From Insight: {[order.insight_from, order.insight_ref].filter(Boolean).join(' · ') || 'a float'}</div>
            <div>Paid from: {order.insight_from || 'a float'}, in Insight. Not from a drawer, a box or the bank.</div>
            {order.receipt_file_id && (
              <div>
                <a href={downloadUrl(order.receipt_file_id, 'receipt', settings)} target="_blank" rel="noreferrer">See the receipt</a>
              </div>
            )}
          </Notice>
        )}
        {editable && float && toPick > 0 && (
          <Notice tone="warn">
            {toPick === 1 ? 'One line' : `${toPick} lines`} did not match a stock item by name. Choose the item for{' '}
            {toPick === 1 ? 'it' : 'each'} below, and how it is bought, before it can be received.
          </Notice>
        )}

        {editable ? (
          <>
            {sides.length > 1 && !float && (
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
                          {float && l.bought_as && <div className="small dim">On the receipt: {l.bought_as}</div>}
                        </td>
                        <td className="num" style={{ width: '6rem' }}>
                          <Input
                            value={text[i]?.qty ?? String(l.qty)}
                            inputMode="decimal"
                            onChange={(e) => {
                              setTextAt(i, { qty: e.target.value });
                              setLine(i, { qty: parseQty(e.target.value) ?? 0 });
                            }}
                          />
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
                            value={text[i]?.cost ?? ''}
                            inputMode="decimal"
                            placeholder="0.00"
                            onChange={(e) => {
                              setTextAt(i, { cost: e.target.value });
                              setLine(i, { unit_cost: parseUnitPrice(e.target.value, decimals) ?? 0 });
                            }}
                          />
                        </td>
                        <td className="num">{money(poLineTotal(l))}</td>
                        <td className="num">
                          <Button size="sm" variant="ghost" onClick={() => { setLines((ls) => ls.filter((_, j) => j !== i)); setText((t) => t.filter((_, j) => j !== i)); }}>Remove</Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="spread">
              <Button size="sm" onClick={() => {
                setLines((ls) => [...ls, {
                  ingredient_id: '', name: '', unit: '', buy_key: 'unit', buy_label: '', per: 1, qty: 1, unit_cost: 0, received_qty: 0,
                }]);
                setText((t) => [...t, { qty: '1', cost: '' }]);
              }}>
                + Add an item
              </Button>
              <strong>Total {money(total)}</strong>
            </div>
            {float ? (
              <Field label="Note"><Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
            ) : (
              <div className="grid-2">
                <Field label="Needed by (optional)"><Input type="date" value={neededBy} onChange={(e) => setNeededBy(e.target.value)} /></Field>
                <Field label="Note to the supplier (optional)"><Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
              </div>
            )}
            {!float && !isAdmin && orderNeedsApproval(total, limit) && (
              <Notice tone="info">Over {money(limit)}: once done, it waits on Approvals before it can be sent.</Notice>
            )}
            <div className="row" style={{ gap: '0.5rem', justifyContent: 'flex-end' }}>
              <Button loading={busy === 'draft'} disabled={!!busy} onClick={() => void save(false)}>Save as draft</Button>
              {float ? (
                <Button variant="primary" loading={busy === 'submit'} disabled={!!busy || !!problem} onClick={() => void save(true)}>
                  Checked, receive it
                </Button>
              ) : (
                <Button variant="primary" loading={busy === 'submit'} disabled={!!busy || !!problem} onClick={() => void save(true)}>
                  Done{!isAdmin && orderNeedsApproval(total, limit) ? ', send for approval' : ''}
                </Button>
              )}
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
                      <td className="num">{priceEach(l.unit_cost)}</td>
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
          <Card title="Send it"
            help={
              <>
                When it arrives, press Record the delivery below, or record the spend at a till and choose{' '}
                {order?.po_no} under "For an order".
              </>
            }
          >
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
          </Card>
        )}

        {/* The goods have come: the till's spend form, with this order picked. */}
        {order && onReceive && isOpenOrder(order.status) && (
          <Card title="It has arrived"
            help={
              <>
                Records the spend that pays for it. What is still to come fills in; change anything that came
                differently, and say how it was paid, or that it has not been paid yet.
              </>
            }
          >
            <Button variant="primary" disabled={!!busy} onClick={() => onReceive(order)}>Record the delivery</Button>
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
