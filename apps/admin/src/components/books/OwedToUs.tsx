import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, Empty, Spinner } from '@snpos/ui';
import {
  loadReceivables, owedRows, ageBuckets, daysLate, writeXlsx, XLSX_TYPE, downloadFile,
  buildReportHtml, openPrintable,
} from '@snpos/core';
import type { OwedTab, Settings } from '@snpos/core';
import { AgeBands } from './BillsToPay';

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Owed to us: what customers owe on tabs, by how long it has been owed.
 *
 * A tab's sales are income on the day they are served; what has not been
 * paid sits here, and on the balance sheet as Owed by customers, until it
 * is settled at a till.
 */
export function OwedToUs({ money, settings }: { money: (n: number) => string; settings: Settings | null }) {
  const [tabs, setTabs] = useState<OwedTab[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const decimals = settings?.currency_decimals ?? 2;
  const now = today();

  useEffect(() => { void loadReceivables().then(setTabs).catch(() => setTabs([])); }, []);

  const bands = ageBuckets(owedRows(tabs ?? []), now);

  const statement = (t: OwedTab) => {
    openPrintable(buildReportHtml({
      title: `Statement · ${t.tab.name}`,
      restaurantName: settings?.restaurant_name ?? '',
      period: `as at ${now}`,
      stats: [{ label: 'Owed', value: money(t.owed) }, { label: 'Oldest', value: `${daysLate(t.oldest, now)} days` }],
      tables: [{
        title: 'Unpaid on this account',
        headers: ['Date', 'Bill', 'Owed'],
        rows: t.orders.map((o) => [o.since.slice(0, 10), o.order.order_no, money(o.owed)]),
        numeric: [2],
      }],
      note: t.tab.reference ? `Account reference: ${t.tab.reference}` : undefined,
      brandColor: settings?.primary_color ?? undefined,
    }), `Statement ${t.tab.name} ${now}`);
  };

  const exportXlsx = () => {
    const m = (n: number) => Math.round(n) / 10 ** decimals;
    const rows = [['Account', 'Reference', 'Bill', 'Served', 'Days', 'Owed'],
      ...(tabs ?? []).flatMap((t) => t.orders.map((o) => [t.tab.name, t.tab.reference ?? '', o.order.order_no, o.since.slice(0, 10), daysLate(o.since, now), m(o.owed)]))];
    downloadFile(`Owed to us ${now}.xlsx`, writeXlsx([{ name: 'Owed to us', rows }]).buffer as ArrayBuffer, XLSX_TYPE);
  };

  return (
    <Card title={`Owed to us${bands.total ? ` · ${money(bands.total)}` : ''}`} pad
      help={
        <>
          What customers owe on tabs, counted as a sale on the day it was served. Paying a tab at a till clears it here.
          Days are counted from when each bill was served.
        </>
      }
    >
      <div className="row row-wrap" style={{ gap: '0.5rem', marginBottom: '0.8rem' }}>
        <Button onClick={exportXlsx} disabled={!tabs || tabs.length === 0}>Excel</Button>
        <Link className="btn" to="/tabs">Tabs</Link>
      </div>
      <AgeBands b={bands} money={money} />
      {tabs === null ? <Spinner /> : tabs.length === 0 ? (
        <Empty title="Nobody owes anything">Every tab is paid up.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Account</th><th className="num">Owed</th><th>Oldest</th><th /></tr></thead>
            <tbody>
              {tabs.map((t) => [
                <tr key={t.tab.$id}>
                  <td>
                    <button type="button" className="linkish" onClick={() => setOpen(open === t.tab.$id ? null : t.tab.$id)} style={{ background: 'none', border: 0, padding: 0, font: 'inherit', cursor: 'pointer', textAlign: 'left' }}>
                      <strong>{t.tab.name}</strong>
                    </button>
                    <div className="small dim">{t.tab.reference ? `${t.tab.reference} · ` : ''}{t.orders.length} unpaid {t.orders.length === 1 ? 'bill' : 'bills'}{t.tab.status !== 'open' ? ' · closed with this still owed' : ''}</div>
                  </td>
                  <td className="num" style={{ fontWeight: 600 }}>{money(t.owed)}</td>
                  <td>{daysLate(t.oldest, now)} days</td>
                  <td className="num"><Button size="sm" onClick={() => statement(t)}>Statement</Button></td>
                </tr>,
                open === t.tab.$id && (
                  <tr key={`${t.tab.$id}-bills`}>
                    <td colSpan={4}>
                      <table className="data">
                        <tbody>
                          {t.orders.map((o) => (
                            <tr key={o.order.$id}>
                              <td className="small dim">{o.since.slice(0, 10)}</td>
                              <td><Link to={`/orders?q=${encodeURIComponent(o.order.order_no)}`}>{o.order.order_no}</Link></td>
                              <td className="num">{money(o.owed)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                ),
              ])}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
