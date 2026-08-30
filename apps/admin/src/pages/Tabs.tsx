import { useEffect, useMemo, useState } from 'react';
import {
  Badge, Button, Empty, Field, Input, Modal, Notice, Spinner, Textarea, useToast,
} from '@snpos/ui';
import { humanError } from '../lib';
import {
  formatMoney, parseMoney,
  loadTabs, ordersOnTab, paidOnOrders, openTab, closeTab, reopenTab, unpostOrder,
  tabOwing, tabSummaryWords, tabIsOpen, displayOrderNo, MODULE_LABELS,
} from '@snpos/core';
import type { Tab, Order, Module } from '@snpos/core';
import { useSession } from '../session';

/**
 * Running accounts, and what is on them.
 *
 * A tab is the business lending money, which is why opening one is management's
 * and not a cashier's: whoever can open a tab is deciding who is good for it.
 * Putting an order ON an open tab is the other half, and that happens at a
 * counter with a customer waiting, so anybody on the floor may do it.
 *
 * Settling is deliberately NOT done here. Recording payment against the bills
 * is what settles a tab, and that goes through the ordinary payment path so
 * the money lands in a shift and gets counted like every other cedi. A tab
 * that closed its own orders would take the takings with it.
 */
export function TabsPage() {
  const { settings, profile, user } = useSession();
  const toast = useToast();
  const decimals = settings?.currency_decimals ?? 2;
  const money = (n: number) => (settings ? formatMoney(n, settings) : String(n));
  const me = profile?.user_id ?? profile?.$id ?? user?.$id ?? '';

  const [tabs, setTabs] = useState<Tab[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showClosed, setShowClosed] = useState(false);

  /** Orders and what has been paid on them, per tab, loaded as they are opened. */
  const [onTab, setOnTab] = useState<Record<string, { orders: Order[]; paid: Record<string, number> }>>({});
  const [open, setOpen] = useState<Tab | null>(null);

  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', reference: '', contact: '', phone: '', note: '', limit: '' });

  const [closing, setClosing] = useState<Tab | null>(null);
  const [closeNote, setCloseNote] = useState('');

  const load = async () => {
    try {
      setTabs(await loadTabs('main'));
      setError(null);
    } catch (e) {
      setError(humanError(e));
      setTabs([]);
    }
  };

  useEffect(() => { void load(); }, []);

  const openDetail = async (tab: Tab) => {
    setOpen(tab);
    if (onTab[tab.$id]) return;
    try {
      const orders = await ordersOnTab(tab.$id);
      const paid = await paidOnOrders(orders.map((o) => o.$id));
      setOnTab((m) => ({ ...m, [tab.$id]: { orders, paid } }));
    } catch {
      // The row above still reads. A list that will not load must not take the
      // tab's own details down with it.
      setOnTab((m) => ({ ...m, [tab.$id]: { orders: [], paid: {} } }));
    }
  };

  const owingOn = (tab: Tab): number | null => {
    const at = onTab[tab.$id];
    if (!at) return null;
    return tabOwing(at.orders, (id) => at.paid[id] ?? 0);
  };

  const create = async () => {
    if (!form.name.trim()) { setError('Give the tab a name somebody will recognise.'); return; }
    const limit = form.limit.trim() === '' ? 0 : parseMoney(form.limit, decimals);
    if (limit === null) { setError('That limit is not a number. Leave it blank for no limit.'); return; }
    setBusy(true);
    try {
      await openTab({
        venueId: 'main',
        name: form.name,
        reference: form.reference,
        contactName: form.contact,
        contactPhone: form.phone,
        note: form.note,
        limitAmount: limit,
        by: me,
      });
      setAdding(false);
      setForm({ name: '', reference: '', contact: '', phone: '', note: '', limit: '' });
      setError(null);
      await load();
      toast('Tab opened');
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  const doClose = async (status: 'settled' | 'void') => {
    if (!closing) return;
    setBusy(true);
    try {
      await closeTab(closing.$id, me, closeNote, status);
      setClosing(null);
      setCloseNote('');
      setOpen(null);
      await load();
      toast(status === 'void' ? `${closing.name} written off` : `${closing.name} closed`);
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  const takeOff = async (order: Order, tab: Tab) => {
    try {
      await unpostOrder(order.$id);
      setOnTab((m) => ({
        ...m,
        [tab.$id]: {
          orders: (m[tab.$id]?.orders ?? []).filter((o) => o.$id !== order.$id),
          paid: m[tab.$id]?.paid ?? {},
        },
      }));
      toast(`${displayOrderNo(order.order_no)} taken off ${tab.name}`);
    } catch (e) {
      setError(humanError(e));
    }
  };

  const shown = useMemo(
    () => (tabs ?? []).filter((t) => (showClosed ? true : tabIsOpen(t))),
    [tabs, showClosed],
  );

  if (!tabs) return <Spinner />;

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <div>
          <h2 style={{ margin: 0 }}>Tabs</h2>
          <p className="small dim" style={{ margin: '0.2rem 0 0' }}>
            A running account somebody settles later. One tab takes orders from the bar, the kitchen and the
            shop — a guest who does all three has one account, not three.
          </p>
        </div>
        <div className="row" style={{ gap: '0.5rem' }}>
          <Button variant="ghost" onClick={() => setShowClosed((v) => !v)}>
            {showClosed ? 'Open only' : 'Show closed'}
          </Button>
          <Button variant="primary" onClick={() => { setAdding(true); setError(null); }}>Open a tab</Button>
        </div>
      </div>

      {error && <div style={{ marginBottom: '1rem' }}><Notice>{error}</Notice></div>}

      {shown.length === 0 ? (
        <Empty title={showClosed ? 'No tabs yet' : 'No tabs are open'}>
          Open one for a guest, a room or a company, and orders can be put on it from any counter.
        </Empty>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Name</th>
                <th>Reference</th>
                <th>Contact</th>
                <th className="num">Limit</th>
                <th>State</th>
                <th className="num" />
              </tr>
            </thead>
            <tbody>
              {shown.map((t) => (
                <tr key={t.$id}>
                  <td style={{ fontWeight: 550 }}>{t.name}</td>
                  <td className="dim small">{t.reference || '—'}</td>
                  <td className="dim small">
                    {t.contact_name || '—'}
                    {t.contact_phone && <div>{t.contact_phone}</div>}
                  </td>
                  <td className="num dim">{(t.limit_amount ?? 0) > 0 ? money(t.limit_amount ?? 0) : 'None'}</td>
                  <td>
                    {t.status === 'open' ? <Badge tone="ok">Open</Badge>
                      : t.status === 'void' ? <Badge tone="danger">Written off</Badge>
                        : <Badge>Closed</Badge>}
                  </td>
                  <td className="num">
                    <Button size="sm" variant="ghost" onClick={() => void openDetail(t)}>What is on it</Button>
                    {tabIsOpen(t) ? (
                      <Button size="sm" variant="ghost" onClick={() => { setClosing(t); setCloseNote(''); }}>
                        Close
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void reopenTab(t.$id).then(load).then(() => toast(`${t.name} reopened`))}
                      >
                        Reopen
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {adding && (
        <Modal
          title="Open a tab"
          onClose={() => setAdding(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
              <Button variant="primary" loading={busy} onClick={create}>Open it</Button>
            </>
          }
        >
          <Field label="Name" hint="What the counter will see in the list. A person, a room, a company.">
            <Input value={form.name} autoFocus onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Reference" hint="Optional. A room number, an order number, whatever it is called out loud.">
            <Input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} />
          </Field>
          <div className="grid-2">
            <Field label="Contact name">
              <Input value={form.contact} onChange={(e) => setForm({ ...form, contact: e.target.value })} />
            </Field>
            <Field label="Phone">
              <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </Field>
          </div>
          {/* A limit that is only drawn is not a limit. This one is checked
              where an order is posted, so the counter is refused rather than
              warned. */}
          <Field
            label={`Limit (${settings?.currency_symbol ?? ''})`}
            hint="Optional. Leave blank for no limit. The counter cannot put an order on once the tab would pass it."
          >
            <Input
              value={form.limit}
              inputMode="decimal"
              placeholder="No limit"
              onChange={(e) => setForm({ ...form, limit: e.target.value })}
            />
          </Field>
          <Field label="Note">
            <Textarea rows={2} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </Field>
        </Modal>
      )}

      {open && (
        <Modal
          title={open.name}
          onClose={() => setOpen(null)}
          footer={<Button onClick={() => setOpen(null)}>Close</Button>}
        >
          {(() => {
            const at = onTab[open.$id];
            if (!at) return <Spinner />;
            const owing = owingOn(open) ?? 0;
            return (
              <>
                <p className="small dim" style={{ marginTop: 0 }}>
                  {tabSummaryWords(open, owing, at.orders.length, money)}
                </p>

                {/* Said once, here, because it is the thing people get wrong
                    about tabs: nothing on this screen takes money. */}
                <Notice tone="info">
                  Putting an order on a tab is not payment. To settle it, take payment against each bill the
                  ordinary way at a till — that is what puts the money into a shift and gets it counted.
                </Notice>

                {at.orders.length === 0 ? (
                  <p className="small dim">Nothing has been put on this tab yet.</p>
                ) : (
                  <div className="table-wrap">
                    <table className="data">
                      <thead>
                        <tr>
                          <th>When</th>
                          <th>Order</th>
                          <th>Where</th>
                          <th className="num">Total</th>
                          <th>Paid</th>
                          <th className="num" />
                        </tr>
                      </thead>
                      <tbody>
                        {at.orders.map((o) => (
                          <tr key={o.$id}>
                            <td className="small">{new Date(o.$createdAt).toLocaleString()}</td>
                            <td style={{ fontWeight: 550 }}>{displayOrderNo(o.order_no)}</td>
                            <td className="small dim">{MODULE_LABELS[(o.module ?? 'kitchen') as Module]}</td>
                            <td className="num">{money(o.total)}</td>
                            <td>
                              {o.payment_status === 'paid'
                                ? <Badge tone="ok">paid</Badge>
                                : <Badge tone="warn">{o.payment_status}</Badge>}
                            </td>
                            <td className="num">
                              {/* For an order put on the wrong account. It goes
                                  back to being an ordinary unpaid bill, which
                                  is what it was. */}
                              {o.payment_status !== 'paid' && (
                                <Button size="sm" variant="ghost" onClick={() => void takeOff(o, open)}>
                                  Take off
                                </Button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            );
          })()}
        </Modal>
      )}

      {closing && (
        <Modal
          title={`Close ${closing.name}`}
          onClose={() => setClosing(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setClosing(null)}>Cancel</Button>
              {/* Written off is its own button and its own word. A debt given
                  up on is not a debt settled, and one row of history that
                  cannot tell them apart is a row nobody can answer for. */}
              <Button variant="ghost" loading={busy} onClick={() => void doClose('void')}>Write it off</Button>
              <Button variant="primary" loading={busy} onClick={() => void doClose('settled')}>
                It has been settled
              </Button>
            </>
          }
        >
          <p className="small dim" style={{ marginTop: 0 }}>
            Closing stops anything new going on this tab. It does not take payment and it does not change the
            orders already on it — settle those at a till the ordinary way.
          </p>
          {(owingOn(closing) ?? 0) > 0 && (
            <Notice tone="warn">
              {money(owingOn(closing) ?? 0)} is still showing as owed on this tab. Closing it anyway is fine if
              the money has been taken elsewhere, but write down where, because this is the only record.
            </Notice>
          )}
          <Field label="Note" hint="How it was settled, or why it is being written off.">
            <Textarea rows={2} value={closeNote} onChange={(e) => setCloseNote(e.target.value)} />
          </Field>
        </Modal>
      )}
    </>
  );
}
