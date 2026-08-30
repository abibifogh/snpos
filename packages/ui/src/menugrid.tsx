import { useId, useMemo, useState } from 'react';
import type { MenuRow, Benchmarks, Quadrant } from '@snpos/core';

/**
 * The menu on two axes, with the benchmark drawn as a cross.
 *
 * A scatter rather than a bar chart, because the question is not "how much"
 * for any one dish — it is where each dish sits relative to two lines. The
 * lines are the entire point: they are the menu's own averages, so the chart
 * says "compared with everything else you sell", which is the only comparison
 * that means anything. A bar chart of margins would rank dishes without ever
 * showing what a good one looks like.
 *
 * Drawn by hand in SVG, like the trend chart beside it, for the same reason: a
 * charting library is tens of kilobytes to place forty dots on a screen that
 * has to open over a Ghanaian mobile connection.
 */

export interface MenuGridProps {
  rows: MenuRow[];
  benchmarks: Benchmarks;
  money: (n: number) => string;
  /** Axis ticks, where decimals are clutter. Falls back to `money`. */
  tickMoney?: (n: number) => string;
  height?: number;
  /** Called when somebody clicks a dish, if the page can do something with it. */
  onPick?: (row: MenuRow) => void;
}

/**
 * What each quadrant is called, and where its name sits on the chart.
 *
 * The label in the corner does the work a legend would, and does it better:
 * the name is where the dishes are, so nothing has to be matched by colour
 * across a gap. Colour is never the only carrier of identity here — every dot
 * is also in a labelled table below, and the quadrant name is written in its
 * own corner.
 */
const CORNERS: { q: Quadrant; label: string; x: 'left' | 'right'; y: 'top' | 'bottom' }[] = [
  { q: 'puzzle', label: 'Puzzles', x: 'left', y: 'top' },
  { q: 'star', label: 'Stars', x: 'right', y: 'top' },
  { q: 'dog', label: 'Dogs', x: 'left', y: 'bottom' },
  { q: 'plough', label: 'Plough-horses', x: 'right', y: 'bottom' },
];

/** 1 / 2 / 5 × a power of ten — ticks somebody would have chosen. */
function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0];
  const rough = max / count;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= rough) ?? 10 * mag;
  const out: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) out.push(v);
  return out;
}

export function MenuGrid({ rows, benchmarks, money, tickMoney, height = 340, onPick }: MenuGridProps) {
  const tick = tickMoney ?? money;
  const id = useId();
  const [hover, setHover] = useState<string | null>(null);

  const W = 800;
  const H = height;
  const pad = { top: 22, right: 22, bottom: 42, left: 86 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  const scale = useMemo(() => {
    const maxQty = Math.max(...rows.map((r) => r.qty), 1);
    // The y axis has to hold a negative contribution — a dish sold below cost
    // is the finding this chart exists to make unmissable, and clamping the
    // axis at zero would park it on the floor beside the merely thin ones.
    const hi = Math.max(...rows.map((r) => r.contribution), benchmarks.contribution, 1);
    const lo = Math.min(...rows.map((r) => r.contribution), 0);
    // A tenth of the range as headroom at each end. Without it the best and
    // worst dishes sit exactly on the axes with half a dot outside the plot —
    // and the worst dish is the one this chart most needs to show.
    const pad = Math.max((hi - lo) * 0.1, 1);
    return { maxQty, maxC: hi + pad, minC: lo - pad, hi, lo };
  }, [rows, benchmarks]);

  const x = (qty: number) => pad.left + (qty / scale.maxQty) * plotW;
  const y = (c: number) => pad.top + plotH - ((c - scale.minC) / (scale.maxC - scale.minC || 1)) * plotH;

  const xTicks = niceTicks(scale.maxQty);
  const yTicks = niceTicks(scale.hi).filter((t) => t >= scale.minC);

  const benchX = x((benchmarks.popularityBp / 10_000) * benchmarks.plates);
  const benchY = y(benchmarks.contribution);
  const zeroY = y(0);

  const hovered = rows.find((r) => r.menuItemId === hover) ?? null;

  return (
    <div className="menugrid">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" width="100%" height={H}
        aria-label={`Every dish placed by how often it sells and what it earns per plate. The benchmark is ${money(benchmarks.contribution)} a plate.`}>

        {/* The four quadrant fields, faintest thing on the chart. They exist so
            the corners read as regions rather than as empty space. */}
        <rect x={benchX} y={pad.top} width={pad.left + plotW - benchX} height={benchY - pad.top}
          fill="var(--q-star)" opacity={0.05} />
        <rect x={benchX} y={benchY} width={pad.left + plotW - benchX} height={pad.top + plotH - benchY}
          fill="var(--q-plough)" opacity={0.05} />
        <rect x={pad.left} y={pad.top} width={benchX - pad.left} height={benchY - pad.top}
          fill="var(--q-puzzle)" opacity={0.05} />
        <rect x={pad.left} y={benchY} width={benchX - pad.left} height={pad.top + plotH - benchY}
          fill="var(--q-dog)" opacity={0.05} />

        {yTicks.map((t) => (
          <g key={`y${t}`}>
            <line x1={pad.left} x2={pad.left + plotW} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeWidth={1} />
            <text x={pad.left - 10} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--text-dim)">{tick(t)}</text>
          </g>
        ))}
        {xTicks.map((t) => (
          <text key={`x${t}`} x={x(t)} y={pad.top + plotH + 20} textAnchor="middle" fontSize={11} fill="var(--text-dim)">
            {t}
          </text>
        ))}

        {/* Sold-below-cost line, only when something is down there. */}
        {scale.minC < 0 && (
          <line x1={pad.left} x2={pad.left + plotW} y1={zeroY} y2={zeroY}
            stroke="var(--danger)" strokeWidth={1.5} strokeDasharray="2 3" opacity={0.7} />
        )}

        {/* The benchmark cross. Heavier than the grid on purpose: it is the
            yardstick, not decoration, and every dot's meaning is its side of
            these two lines. */}
        <line x1={benchX} x2={benchX} y1={pad.top} y2={pad.top + plotH}
          stroke="var(--text-dim)" strokeWidth={1.5} strokeDasharray="5 4" />
        <line x1={pad.left} x2={pad.left + plotW} y1={benchY} y2={benchY}
          stroke="var(--text-dim)" strokeWidth={1.5} strokeDasharray="5 4" />

        {/* Painted with a surface-coloured stroke behind the glyphs. A dish can
            land anywhere, so a corner label will sometimes sit over a dot, a
            grid line or the zero rule — the halo is what keeps it legible when
            it does, rather than hoping it does not. */}
        {CORNERS.map((c) => (
          <text key={c.q}
            x={c.x === 'left' ? pad.left + 12 : pad.left + plotW - 12}
            y={c.y === 'top' ? pad.top + 17 : pad.top + plotH - 14}
            textAnchor={c.x === 'left' ? 'start' : 'end'}
            fontSize={12} fontWeight={700} fill={`var(--q-${c.q})`}
            stroke="var(--surface)" strokeWidth={3.5} paintOrder="stroke"
            style={{ pointerEvents: 'none' }}>
            {c.label}
          </text>
        ))}

        {rows.map((r) => {
          if (!r.quadrant) return null;
          const on = hover === r.menuItemId;
          return (
            <g key={r.menuItemId}
              onMouseEnter={() => setHover(r.menuItemId)}
              onMouseLeave={() => setHover((h) => (h === r.menuItemId ? null : h))}
              onClick={() => onPick?.(r)}
              style={{ cursor: onPick ? 'pointer' : 'default' }}>
              {/* A surface-coloured ring, so two dishes landing on the same
                  spot stay two dishes rather than one darker blob. */}
              <circle cx={x(r.qty)} cy={y(r.contribution)} r={on ? 9 : 6}
                fill={`var(--q-${r.quadrant})`} stroke="var(--surface)" strokeWidth={2} />
              {/* A generous invisible target: the dot is 12px, a finger is not. */}
              <circle cx={x(r.qty)} cy={y(r.contribution)} r={16} fill="transparent" />
            </g>
          );
        })}

        <text x={pad.left + plotW / 2} y={H - 6} textAnchor="middle" fontSize={11} fill="var(--text-dim)">
          Plates sold
        </text>
        <text x={18} y={pad.top + plotH / 2} textAnchor="middle" fontSize={11} fill="var(--text-dim)"
          transform={`rotate(-90 18 ${pad.top + plotH / 2})`}>
          Kept per plate
        </text>
      </svg>

      {/* Below the chart rather than floating over it: a tooltip that follows
          the pointer covers the neighbouring dots, which on a scatter is the
          comparison somebody is in the middle of making. */}
      <div className="menugrid-read" aria-live="polite" id={`${id}-read`}>
        {hovered ? (
          <>
            <strong>{hovered.name}</strong>
            <span>{hovered.qty} sold</span>
            <span>{money(hovered.unitPrice)} each</span>
            <span>{money(hovered.contribution)} kept</span>
            <span className={`q-tag q-${hovered.quadrant}`}>{QUADRANT_SHORT[hovered.quadrant!]}</span>
          </>
        ) : (
          <span className="dim">
            The dashed lines are this menu&rsquo;s own averages — {money(benchmarks.contribution)} kept per plate,
            across {benchmarks.items} costed {benchmarks.items === 1 ? 'dish' : 'dishes'}. Hover a dot for the dish.
          </span>
        )}
      </div>
    </div>
  );
}

const QUADRANT_SHORT: Record<Quadrant, string> = {
  star: 'Star', plough: 'Plough-horse', puzzle: 'Puzzle', dog: 'Dog',
};
