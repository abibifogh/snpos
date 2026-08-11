import { useId, useMemo, useRef, useState } from 'react';

/**
 * Money in and money out, over time.
 *
 * Two lines rather than a second axis. Revenue and cost are both money in the
 * same currency, so they belong on one scale, and the moment they share it,
 * the gap between the lines IS the profit, readable without arithmetic. A
 * second axis would let that gap be anything the scales happened to make it.
 *
 * Drawn by hand in SVG. A charting library would be 60kB to draw two
 * polylines onto a screen that has to open over a Ghanaian mobile connection,
 * and none of them would know what to do about a restaurant's brand colour.
 */

export interface TrendPoint {
  key: string;
  label: string;
  full: string;
  revenue: number;
  cost: number;
}

/**
 * Ticks a person would have chosen.
 *
 * 1 / 2 / 5 × a power of ten. An axis reading 0, 3,167, 6,334 is arithmetically
 * correct and useless, nobody holds those in their head to read a point off
 * the line.
 */
function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0];
  const rough = max / count;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= rough) ?? 10 * mag;
  const out: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(v);
  return out;
}

export function TrendChart({
  points,
  money,
  tickMoney,
  height = 240,
  costLabel = 'Costs',
  revenueLabel = 'Revenue',
}: {
  points: TrendPoint[];
  money: (n: number) => string;
  /** Axis ticks, where decimals are clutter. Falls back to `money`. */
  tickMoney?: (n: number) => string;
  height?: number;
  costLabel?: string;
  revenueLabel?: string;
}) {
  const id = useId();
  const wrap = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  // A viewBox rather than measured pixels: the chart scales to whatever the
  // card gives it, on a phone or a laptop, without a resize observer.
  const W = 800;
  const H = height;
  const pad = { top: 16, right: 16, bottom: 30, left: 64 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  const { ticks, top } = useMemo(() => {
    const max = Math.max(...points.flatMap((p) => [p.revenue, p.cost]), 0);
    const t = niceTicks(max);
    return { ticks: t, top: Math.max(t[t.length - 1], 1) };
  }, [points]);

  if (points.length === 0) {
    return <p className="dim small" style={{ margin: 0 }}>Nothing in this period yet.</p>;
  }

  const x = (i: number) => pad.left + (points.length === 1 ? plotW / 2 : (i * plotW) / (points.length - 1));
  const y = (v: number) => pad.top + plotH - (v / top) * plotH;

  const path = (pick: (p: TrendPoint) => number) =>
    points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(pick(p)).toFixed(1)}`).join(' ');

  const areaPath =
    `${path((p) => p.revenue)} L${x(points.length - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z`;

  // Every second or fourth label once there are more than a fortnight of them,
  // so the axis stays readable rather than becoming a grey smear.
  //
  // The last one is always wanted; it is where the eye lands and where the
  // direct labels are, but only if there is room. Forcing it drew "5 Wed"
  // and "6 Thu" on top of each other at the right-hand edge.
  const labelEvery = points.length > 24 ? 4 : points.length > 14 ? 2 : 1;
  const lastIndex = points.length - 1;
  const lastRegular = Math.floor(lastIndex / labelEvery) * labelEvery;
  const showsLast = lastIndex - lastRegular >= Math.ceil(labelEvery / 2);
  const labelled = (i: number) =>
    i === lastIndex ? showsLast : i % labelEvery === 0 && !(showsLast && lastIndex - i < labelEvery);
  const last = points[lastIndex];

  const onMove = (e: React.MouseEvent<SVGSVGElement> | React.TouchEvent<SVGSVGElement>) => {
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const clientX = 'touches' in e ? e.touches[0]?.clientX : e.clientX;
    if (clientX === undefined) return;
    const px = ((clientX - rect.left) / rect.width) * W;
    // Nearest point, not the one under the cursor. A two-pixel line is not a
    // hit target, and asking somebody to land on one with a thumb is not a
    // chart, it is a game.
    let nearest = 0;
    let best = Infinity;
    for (let i = 0; i < points.length; i++) {
      const d = Math.abs(x(i) - px);
      if (d < best) { best = d; nearest = i; }
    }
    setHover(nearest);
  };

  const shown = hover === null ? null : points[hover];

  return (
    <div className="trend" ref={wrap}>
      <div className="trend-legend">
        <span><i className="swatch swatch-rev" aria-hidden="true" />{revenueLabel}</span>
        <span><i className="swatch swatch-cost" aria-hidden="true" />{costLabel}</span>
      </div>

      <div className="trend-plot">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={`${revenueLabel} and ${costLabel} over ${points.length} periods`}
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
          onTouchStart={onMove}
          onTouchMove={onMove}
        >
          <defs>
            <linearGradient id={`${id}-wash`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" className="wash-top" />
              <stop offset="100%" className="wash-bottom" />
            </linearGradient>
          </defs>

          {/* Hairline grid, one step off the surface. Solid, a dashed grid
              reads as a threshold or a projection when it is neither. */}
          {ticks.map((t) => (
            <g key={t}>
              <line className="grid" x1={pad.left} x2={W - pad.right} y1={y(t)} y2={y(t)} />
              <text className="tick" x={pad.left - 10} y={y(t) + 4} textAnchor="end">
                {(tickMoney ?? money)(t)}
              </text>
            </g>
          ))}

          <path className="rev-area" d={areaPath} fill={`url(#${id}-wash)`} />
          <path className="rev-line" d={path((p) => p.revenue)} />
          <path className="cost-line" d={path((p) => p.cost)} />

          {points.map((p, i) =>
            labelled(i) ? (
              <text key={p.key} className="tick" x={x(i)} y={H - 10} textAnchor="middle">
                {p.label}
              </text>
            ) : null,
          )}

          {/* The endpoint, direct-labelled. One value on the chart, not thirty. */}
          <circle className="rev-dot" cx={x(points.length - 1)} cy={y(last.revenue)} r={4.5} />
          <circle className="cost-dot" cx={x(points.length - 1)} cy={y(last.cost)} r={4.5} />

          {shown && hover !== null && (
            <g className="crosshair">
              <line x1={x(hover)} x2={x(hover)} y1={pad.top} y2={pad.top + plotH} />
              <circle className="rev-dot" cx={x(hover)} cy={y(shown.revenue)} r={5} />
              <circle className="cost-dot" cx={x(hover)} cy={y(shown.cost)} r={5} />
            </g>
          )}
        </svg>

        {shown && (
          <div
            className="trend-tip"
            style={{ left: `${((x(hover ?? 0) - pad.left) / plotW) * 100}%` }}
          >
            <strong>{shown.full}</strong>
            <span><i className="swatch swatch-rev" aria-hidden="true" />{money(shown.revenue)}</span>
            <span><i className="swatch swatch-cost" aria-hidden="true" />{money(shown.cost)}</span>
            <span className="dim">Kept {money(shown.revenue - shown.cost)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The same numbers, as a table.
 *
 * Not a fallback, a twin. Somebody using a screen reader, printing the page,
 * or wanting to check one figure against a receipt needs the values, and a
 * tooltip is the one place a value must never only live.
 */
export function TrendTable({
  points,
  money,
  caption,
}: {
  points: TrendPoint[];
  money: (n: number) => string;
  caption: string;
}) {
  return (
    <div className="table-wrap">
      <table className="data">
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            <th>Period</th>
            <th className="num">Revenue</th>
            <th className="num">Costs</th>
            <th className="num">Kept</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.key}>
              <td>{p.full}</td>
              <td className="num">{money(p.revenue)}</td>
              <td className="num">{money(p.cost)}</td>
              <td className="num">{money(p.revenue - p.cost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
