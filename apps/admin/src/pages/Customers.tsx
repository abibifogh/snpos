import { useEffect, useMemo, useState } from 'react';
import {
  Badge, Button, Card, Empty, Field, Input, Modal, Notice, Select, Spinner, useToast,
  FilterBar, FilterField,
} from '@snpos/ui';
import { humanError } from '../lib';
import {
  formatMoney, listCreatedBetween, toCsv, downloadCsv, MODULE_LABELS,
  buildCustomers, sortCustomers, searchCustomers, summarise, anonymousCount,
  isRegular, contactable, toSheet, REGULAR_AT,
} from '@snpos/core';
import type { CustomerRecord, CustomerOrder, CustomerSort, Module } from '@snpos/core';
import { useSession } from '../session';
import { SideFilter, type Side } from '../components/SideFilter';

/**
 * The people who have bought something.
 *
 * Assembled from the orders, which is where the details actually are — a name
 * typed at the counter, a phone number taken for a takeaway, an email given to
 * have a receipt sent. There is a `customers` collection in the schema that
 * nothing has ever written to; reading from that would have shown an empty
 * page on a business with two years of trading behind it.
 *
 * The page is deliberately a place to LOOK at what is held, not a place to act
 * on it. Every address here was given for a reason — to collect an order, to
 * get a receipt — and none of it is consent to be sent anything else, so there
 * is no "email everyone" button and the page says why where somebody would go
 * looking for one.
 */

const dayStart = (d: string) => new Date(`${d}T00:00:00`).toISOString();
const dayEnd = (d: string) => new Date(`${d}T23:59:59.999`).toISOString();
const todayStr = () => new Date().toLocaleDateString('en-CA');
const daysAgoStr = (n: number) => new Date(Date.now() - n * 86400_000).toLocaleDateString('en-CA');

export function CustomersPage() {
  const { settings, profile } = useSession();
  const toast = useToast();

  /*
    Ninety days, not everything.

    A range rather than the whole history because this reads every order in it,
    and reading every order this business has ever taken to draw one screen is
    exactly the greed that put the tills on the floor when the month's
    allowance ran out. Ninety days answers "who has been in lately", which is
    the question; the range is there for the times it is not.
  */
  const [from, setFrom] = useState(daysAgoStr(90));
  const [to, setTo] = useState(todayStr());
  const [side, setSide] = useState<Side>('all');
  const [term, setTerm] = useState('');
  const [sort, setSort] = useState<CustomerSort>('recent');
  const [onlyReturning, setOnlyReturning] = useState(false);
  const [onlyEmail, setOnlyEmail] = useState(false);

  const [orders, setOrders] = useState<CustomerOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<CustomerRecord | null>(null);

  const money = (n: number) => (settings ? formatMoney(n, settings) : String(n));

  const load = async () => {
    setOrders(null);
    setError(null);
    try {
      const rows = await listCreatedBetween<CustomerOrder>('orders', dayStart(from), dayEnd(to));
      setOrders(rows);
    } catch (e) {
      setError(humanError(e));
      setOrders([]);
    }
  };

  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [from, to]);

  /*
    The side filter is applied to the ORDERS, before the people are built.

    Filtering the finished records instead would answer a different question:
    a person who eats in the bistro and once bought a basket would be shown
    under the craft shop with all of their bistro spending attached to them.
  */
  const mine = useMemo(
    () => (orders ?? []).filter((o) => side === 'all' || (o.module ?? 'kitchen') === side),
    [orders, side],
  );

  const people = useMemo(() => buildCustomers(mine), [mine]);
  const totals = useMemo(() => summarise(people), [people]);
  const anonymous = useMemo(() => anonymousCount(mine), [mine]);

  const shown = useMemo(() => {
    let rows = searchCustomers(people, term);
    if (onlyReturning) rows = rows.filter(isRegular);
    if (onlyEmail) rows = rows.filter((r) => !!r.email);
    return sortCustomers(rows, sort);
  }, [people, term, sort, onlyReturning, onlyEmail]);

  const exportCsv = () => {
    const sheet = toSheet(shown);
    downloadCsv(`customers-${from}-to-${to}.csv`, toCsv(sheet.headers, sheet.rows));
    toast(`${shown.length} ${shown.length === 1 ? 'person' : 'people'} exported`);
  };

  return (
    <>
      <div className="spread">
        <h1>Customers</h1>
        <Button onClick={exportCsv} disabled={shown.length === 0}>Export what is shown</Button>
      </div>

      <FilterBar>
        <FilterField label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></FilterField>
        <FilterField label="To"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></FilterField>
        <FilterField label="Side">
          <SideFilter value={side} onChange={setSide} settings={settings} profile={profile} />
        </FilterField>
        <FilterField label="Search">
          <Input value={term} placeholder="Name, email, phone…" onChange={(e) => setTerm(e.target.value)} />
        </FilterField>
        <FilterField label="Order by">
          <Select value={sort} onChange={(e) => setSort(e.target.value as CustomerSort)}>
            <option value="recent">Most recent visit</option>
            <option value="spend">Most spent</option>
            <option value="orders">Most orders</option>
            <option value="name">Name</option>
          </Select>
        </FilterField>
        <FilterField label="Show">
          <Select
            value={onlyReturning ? 'returning' : onlyEmail ? 'email' : 'all'}
            onChange={(e) => {
              setOnlyReturning(e.target.value === 'returning');
              setOnlyEmail(e.target.value === 'email');
            }}
          >
            <option value="all">Everybody</option>
            <option value="returning">Been in more than once</option>
            <option value="email">Has an email address</option>
          </Select>
        </FilterField>
      </FilterBar>

      {error && <div style={{ marginBottom: '1rem' }}><Notice>{error}</Notice></div>}

      {orders === null ? (
        <Card><Spinner /></Card>
      ) : (
        <>
          <Card>
            <div className="row row-wrap" style={{ gap: '1.8rem', alignItems: 'flex-end' }}>
              <div>
                <div className="dim small">People we can name</div>
                <div style={{ fontSize: '1.6rem', fontWeight: 700 }}>{totals.people}</div>
              </div>
              <div>
                <div className="dim small">Been in more than once</div>
                <div style={{ fontSize: '1.3rem', fontWeight: 650 }}>{totals.returning}</div>
              </div>
              <div>
                <div className="dim small">With an email</div>
                <div style={{ fontSize: '1.3rem', fontWeight: 650 }}>{totals.withEmail}</div>
              </div>
              <div>
                <div className="dim small">With a phone number</div>
                <div style={{ fontSize: '1.3rem', fontWeight: 650 }}>{totals.withPhone}</div>
              </div>
              <div>
                <div className="dim small">Their spending</div>
                <div style={{ fontSize: '1.3rem', fontWeight: 650 }}>{money(totals.spent)}</div>
              </div>
            </div>

            {/* Without this the page lies by omission. A list of nine reads
                like the whole customer base until it says nine out of what. */}
            {anonymous > 0 && (
              <p className="small dim" style={{ marginBottom: 0, marginTop: '0.9rem' }}>
                Another <strong>{anonymous}</strong> {anonymous === 1 ? 'order' : 'orders'} in this range carried no
                name, phone or email — somebody walked in, paid and left. That is normal, and it is most orders in
                most places. Details are only held where a customer gave them: ordering from their phone, asking for
                a receipt, or leaving a number for a takeaway.
              </p>
            )}
          </Card>

          <Card>
            <p className="small dim" style={{ margin: 0 }}>
              <strong>This is not a mailing list.</strong> Every address here was given for a reason — to collect an
              order, or to have a receipt sent — and that is not permission to send anything else. Before using any
              of it for marketing, ask people first. Ghana&rsquo;s Data Protection Act works the way this page does:
              details collected for one purpose are not free for another.
            </p>
          </Card>

          {shown.length === 0 ? (
            <Card>
              <Empty title={term ? 'Nobody matches that' : 'No customer details in this range'}>
                {term
                  ? 'Try a different name, or part of an email address or phone number.'
                  : 'Details are collected when a customer orders from their phone, asks for a receipt by email, or '
                    + 'leaves a number for a takeaway. Widen the dates, or check that self-ordering is switched on '
                    + 'under Settings.'}
              </Empty>
            </Card>
          ) : (
            <Card pad={false} title={`${shown.length} ${shown.length === 1 ? 'person' : 'people'}`}>
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Who</th>
                      <th>How to reach them</th>
                      <th className="num">Orders</th>
                      <th className="num">Spent</th>
                      <th>Last in</th>
                      <th>Buys</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((r) => (
                      <tr key={r.key}>
                        <td style={{ fontWeight: 550 }}>
                          {r.name || <span className="dim">No name given</span>}
                          {isRegular(r) && <> <Badge tone="ok">Regular</Badge></>}
                        </td>
                        <td className="small">
                          {r.email && <div>{r.email}</div>}
                          {r.phone && <div className="dim">{r.phone}</div>}
                          {!contactable(r) && <span className="dim">—</span>}
                        </td>
                        <td className="num">{r.orders}</td>
                        <td className="num" style={{ fontWeight: 600 }}>{money(r.spent)}</td>
                        <td className="dim small">{new Date(r.lastSeen).toLocaleDateString()}</td>
                        <td className="small dim">
                          {r.modules.map((m) => MODULE_LABELS[m as Module] ?? m).join(', ') || '—'}
                        </td>
                        <td className="right">
                          <Button size="sm" onClick={() => setOpen(r)}>Open</Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          <Card title="How people end up on this list">
            <p className="small dim" style={{ marginTop: 0 }}>
              Three ways, and all three are the customer choosing to give something: ordering from their own phone,
              asking for a receipt by email, or leaving a name or number for a takeaway or a booking. Nothing is
              collected quietly, and a walk-in who pays cash leaves no trace here at all.
            </p>
            <p className="small dim" style={{ marginBottom: 0 }}>
              Somebody who gave a phone number once and an email another time will appear twice — there is nothing
              shared between those two orders to join them by. Guessing from names would be worse: two people called
              Kwame are two people, and a wrong join quietly credits one person&rsquo;s spending to another with
              nothing on screen to show it happened. Being in the list {REGULAR_AT} times or more is what earns the
              Regular badge.
            </p>
          </Card>
        </>
      )}

      {open && (
        <Modal title={open.name || open.email || open.phone || 'Customer'} wide onClose={() => setOpen(null)}>
          <div className="row row-wrap" style={{ gap: '1.6rem', alignItems: 'flex-end' }}>
            <div>
              <div className="dim small">Orders</div>
              <div style={{ fontSize: '1.4rem', fontWeight: 700 }}>{open.orders}</div>
            </div>
            <div>
              <div className="dim small">Spent</div>
              <div style={{ fontSize: '1.4rem', fontWeight: 700 }}>{money(open.spent)}</div>
            </div>
            <div>
              <div className="dim small">First in</div>
              <div>{new Date(open.firstSeen).toLocaleDateString()}</div>
            </div>
            <div>
              <div className="dim small">Last in</div>
              <div>{new Date(open.lastSeen).toLocaleDateString()}</div>
            </div>
          </div>

          <Field label="How to reach them">
            <div className="small">
              {open.email ? <div>{open.email}</div> : null}
              {open.phone ? <div>{open.phone}</div> : null}
              {!contactable(open) && <span className="dim">Nothing was given.</span>}
            </div>
          </Field>

          <h3>What they have bought</h3>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>When</th><th>Order</th><th>Side</th><th className="num">Total</th><th>Paid</th></tr>
              </thead>
              <tbody>
                {open.history.map((o) => (
                  <tr key={o.$id} style={{ opacity: o.status === 'CANCELLED' || o.status === 'REJECTED' ? 0.5 : 1 }}>
                    <td className="dim small">{new Date(o.$createdAt).toLocaleDateString()}</td>
                    <td>
                      {o.order_no ?? '—'}
                      {(o.status === 'CANCELLED' || o.status === 'REJECTED') && <> <Badge>Cancelled</Badge></>}
                    </td>
                    <td className="small dim">{MODULE_LABELS[(o.module ?? 'kitchen') as Module]}</td>
                    <td className="num">{money(o.total)}</td>
                    <td className="small">
                      {o.payment_status === 'paid'
                        ? <Badge tone="ok">Paid</Badge>
                        : <span className="dim">{o.payment_status ?? '—'}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="small dim" style={{ marginBottom: 0 }}>
            Only this date range. Widen the dates on the page behind to see further back.
          </p>
        </Modal>
      )}
    </>
  );
}
