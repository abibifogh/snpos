import { useMemo, useState } from 'react';
import { Button, Card, TrendChart, TrendTable } from '@snpos/ui';
import {
  series, change, previousRange, byDayOfWeek, standout, changeTone, asPercent,
} from '@snpos/core';
import type { Grain, Change } from '@snpos/core';

/**
 * The part of a report that answers "compared with what?".
 *
 * A total for a date range is a fact. Whether it is a good one is a different
 * question, and the only honest way to answer it is against the same length of
 * time immediately before. Every figure on this panel carries that comparison,
 * because a number without one gets read as whatever mood the reader is in.
 */

export interface InsightInput {
  revenue: { at: string; amount: number; covers?: number }[];
  cost: { at: string; amount: number }[];
  from: Date;
  to: Date;
  money: (n: number) => string;
  tickMoney?: (n: number) => string;
}

const GRAINS: { key: Grain; label: string }[] = [
  { key: 'day', label: 'By day' },
  { key: 'week', label: 'By week' },
  { key: 'month', label: 'By month' },
];

function Stat({
  label,
  value,
  delta,
  goodWhenUp = true,
  sub,
}: {
  label: string;
  value: string;
  delta?: Change;
  goodWhenUp?: boolean;
  sub?: string;
}) {
  const tone = delta ? changeTone(delta, goodWhenUp) : 'flat';
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {delta ? (
        <div className={`delta ${tone}`}>
          {/* An arrow as well as the colour. Red and green alone is the one
              encoding a colourblind reader cannot use, and this is the line
              the whole panel turns on. */}
          <span aria-hidden="true">{tone === 'good' ? '▲' : tone === 'bad' ? '▼' : '—'}</span>
          <span>{asPercent(delta.ratio)} on the period before</span>
        </div>
      ) : (
        sub && <div className="delta flat">{sub}</div>
      )}
    </div>
  );
}

export function Insights({ revenue, cost, from, to, money, tickMoney }: InsightInput) {
  const [grain, setGrain] = useState<Grain>('day');
  const [showTable, setShowTable] = useState(false);

  const buckets = useMemo(
    () => series({ revenue, cost, grain, from, to }),
    [revenue, cost, grain, from, to],
  );

  // The same length of time, ending the instant this period starts. Not "last
  // month" — a 30-day range compared against a calendar month would be
  // comparing 30 days with 31, and reporting the extra day as growth.
  const before = useMemo(() => previousRange(from, to), [from, to]);
  const prior = useMemo(() => {
    const within = (rows: { at: string }[]) =>
      rows.filter((r) => {
        const d = new Date(r.at);
        return d >= before.from && d <= before.to;
      });
    const rev = within(revenue) as typeof revenue;
    const cst = within(cost) as typeof cost;
    return {
      revenue: rev.reduce((s, r) => s + r.amount, 0),
      cost: cst.reduce((s, r) => s + r.amount, 0),
      orders: rev.length,
    };
  }, [revenue, cost, before]);

  const now = useMemo(() => ({
    revenue: buckets.reduce((s, b) => s + b.revenue, 0),
    cost: buckets.reduce((s, b) => s + b.cost, 0),
    orders: buckets.reduce((s, b) => s + b.orders, 0),
  }), [buckets]);

  const kept = now.revenue - now.cost;
  const keptBefore = prior.revenue - prior.cost;
  const avg = now.orders ? Math.round(now.revenue / now.orders) : 0;
  const avgBefore = prior.orders ? Math.round(prior.revenue / prior.orders) : 0;

  // Day buckets specifically, whatever the chart is showing — a weekday
  // pattern built from weekly totals would be meaningless.
  const days = useMemo(() => series({ revenue, cost, grain: 'day', from, to }), [revenue, cost, from, to]);
  const dow = useMemo(() => byDayOfWeek(days), [days]);
  const peakDay = Math.max(...dow.map((d) => d.average), 1);
  const marks = useMemo(() => standout(days), [days]);

  const points = buckets.map((b) => ({
    key: b.key, label: b.label, full: b.full, revenue: b.revenue, cost: b.cost,
  }));

  const grainWord = grain === 'day' ? 'day' : grain === 'week' ? 'week' : 'month';

  return (
    <>
      <div className="stat-row">
        <Stat label="Revenue" value={money(now.revenue)} delta={change(now.revenue, prior.revenue)} />
        <Stat label="Costs" value={money(now.cost)} delta={change(now.cost, prior.cost)} goodWhenUp={false} />
        <Stat label="Kept" value={money(kept)} delta={change(kept, keptBefore)} />
        <Stat label="Average order" value={money(avg)} delta={change(avg, avgBefore)} />
      </div>

      <Card
        title={`Money in and out, by ${grainWord}`}
        actions={
          <div className="row" style={{ gap: '0.3rem' }}>
            {GRAINS.map((g) => (
              <Button
                key={g.key}
                size="sm"
                variant={grain === g.key ? 'primary' : 'default'}
                onClick={() => setGrain(g.key)}
              >
                {g.label}
              </Button>
            ))}
          </div>
        }
      >
        <TrendChart points={points} money={money} tickMoney={tickMoney} />

        <div className="row" style={{ marginTop: '0.8rem' }}>
          <Button size="sm" variant="ghost" onClick={() => setShowTable((v) => !v)}>
            {showTable ? 'Hide the figures' : 'Show the figures'}
          </Button>
        </div>
        {showTable && (
          <div style={{ marginTop: '0.6rem' }}>
            <TrendTable points={points} money={money} caption={`Revenue and costs by ${grainWord}`} />
          </div>
        )}
      </Card>

      <div className="grid-2">
        <Card title="Which days actually earn">
          <p className="small dim" style={{ marginTop: 0 }}>
            An average, not a total — a month holds five Mondays and four Sundays, and totalling would
            call Monday the better day when it is only the more frequent one.
          </p>
          <div className="dow">
            {dow.map((d) => (
              <div className="dow-row" key={d.day}>
                <span className="small">{d.name}</span>
                <div className="dow-track">
                  <div className="dow-fill" style={{ width: `${(d.average / peakDay) * 100}%` }} />
                </div>
                <span className="num dim">{money(d.average)}</span>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Standouts">
          {marks.best ? (
            <div className="stack" style={{ gap: '0.9rem' }}>
              <div>
                <div className="label small dim">Best day</div>
                <div style={{ fontWeight: 650 }}>{marks.best.full}</div>
                <div className="small dim">
                  {money(marks.best.revenue)} — {asPercent((marks.best.revenue - marks.typical) / (marks.typical || 1))} on a
                  typical day
                </div>
              </div>
              <div>
                <div className="label small dim">Quietest day</div>
                <div style={{ fontWeight: 650 }}>{marks.worst?.full}</div>
                <div className="small dim">{money(marks.worst?.revenue ?? 0)}</div>
              </div>
              <div>
                <div className="label small dim">A typical day</div>
                <div style={{ fontWeight: 650 }}>{money(marks.typical)}</div>
                <div className="small dim">
                  Averaged over the {days.filter((d) => d.revenue > 0).length} days you actually traded, so a
                  closed Monday does not drag it down.
                </div>
              </div>
            </div>
          ) : (
            <p className="dim small" style={{ margin: 0 }}>Nothing to compare yet.</p>
          )}
        </Card>
      </div>
    </>
  );
}
