/**
 * Which dishes earn their place on the menu.
 *
 * Two facts about a dish decide what to do with it, and neither means much
 * alone. How often it sells says nothing about whether selling it is worth
 * doing — the busiest item on most menus is the one priced closest to its
 * cost. What it earns per plate says nothing about whether anybody orders it.
 * Put the two on a pair of axes and every dish falls into one of four
 * quadrants, each with a different obvious action.
 *
 *      contribution per plate
 *              ▲
 *      Puzzle  │  Star          Star   sells well, earns well → protect it
 *              │                Puzzle earns well, nobody orders → promote
 *      ────────┼────────►       Plough popular but thin → reprice or re-cost
 *      Dog     │  Plough-horse  Dog    neither → take it off
 *              │   how often it sells
 *
 * The point of this file is the word *yardstick*. "Chicken returns 38%" is not
 * a decision. "Chicken returns 38% against a menu benchmark of 61%, and it is
 * your third best seller, so it is a plough-horse — closing that gap is worth
 * 2,400 cedis a month" is one. Every figure here is reported against the
 * menu's own benchmark rather than in isolation, because a margin is only ever
 * good or bad compared with what else you could be selling instead.
 *
 * Pure, importing nothing at runtime, like every other analysis in this
 * package. Somebody is going to take a dish off the menu because of a number
 * on this screen, and that number has to be checkable without a database.
 */

/**
 * One dish's trade over the period, already summed.
 *
 * Named for what it is rather than for the line it came from: a shift's
 * counter tally is also a list of things sold — see soldByItem in bar-count —
 * and two exports called the same thing made both of them ambiguous, which
 * takes out every screen that reads either.
 *
 * `revenue` is what was actually taken, not list price × quantity. The till
 * lets a manager change a line price, and a dish sold at 40 instead of 55 is
 * exactly the case this report exists to surface — reading list price here
 * would hide it behind an average that looks fine.
 */
export interface DishTrade {
  menuItemId: string;
  name: string;
  qty: number;
  revenue: number;
}

/** What one of them costs to make, from its recipe. */
export interface CostedItem {
  menuItemId: string;
  unitCost: number;
  /** No recipe. Not the same as costing nothing — see below. */
  unknown: boolean;
}

export type Quadrant = 'star' | 'plough' | 'puzzle' | 'dog';

export interface MenuRow {
  menuItemId: string;
  name: string;
  qty: number;
  revenue: number;
  /** What was actually got per plate, after any till override. */
  unitPrice: number;
  unitCost: number;
  /** Per plate, price less cost. Negative is possible and is the finding. */
  contribution: number;
  /** Contribution over price, in basis points. */
  marginBp: number;
  /** Everything this dish contributed over the period. */
  totalContribution: number;
  /** Its share of plates sold, in basis points of the classified menu. */
  popularityBp: number;
  popular: boolean;
  profitable: boolean;
  /** Null when the dish has no recipe, so nothing can honestly be said. */
  quadrant: Quadrant | null;
  /**
   * What closing the gap to the benchmark would have been worth over this
   * period, at this volume. Zero for anything already at or above it.
   */
  upside: number;
}

export interface Benchmarks {
  /**
   * The line a dish has to clear to count as profitable: the contribution the
   * average plate actually returned.
   *
   * Weighted — total contribution over total plates — not the average of the
   * per-dish figures. One rarely-ordered lobster at a huge margin would drag
   * an unweighted line above almost everything on the menu, and half the
   * kitchen would be reported as failing against a benchmark nothing reaches.
   */
  contribution: number;
  /** The same line as a margin, for a sentence rather than a sum. */
  marginBp: number;
  /**
   * The share of plates a dish needs to count as popular.
   *
   * An even menu would give every dish 1/n of the plates. Demanding a full
   * 1/n would put half the menu below the line by construction, so the
   * convention — and it is a convention, not a law — is 70% of an even share.
   */
  popularityBp: number;
  /** How many dishes the benchmarks were computed from. */
  items: number;
  plates: number;
}

export interface Uncosted {
  rows: MenuRow[];
  /**
   * What share of takings comes from dishes with no recipe.
   *
   * Reported prominently because it is the honest limit on everything else
   * here. A menu where two thirds of the money is uncosted has not been
   * analysed; it has been sampled.
   */
  revenueBp: number;
  revenue: number;
}

export interface MenuEngineering {
  /** Classified dishes, best total contribution first. */
  rows: MenuRow[];
  /** Dishes with no recipe, listed but never classified. */
  uncosted: Uncosted;
  /** Null when there was not enough trade to say anything. */
  benchmarks: Benchmarks | null;
  /** Why there are no benchmarks, for a screen to print instead of a grid. */
  tooThin: string | null;
  totals: {
    plates: number;
    revenue: number;
    contribution: number;
    /** Share of contribution coming from each quadrant, in basis points. */
    byQuadrant: Record<Quadrant, { items: number; plates: number; contribution: number; revenue: number }>;
    /** The whole prize on the table if every dish met the benchmark. */
    upside: number;
  };
}

/** 70% of an even share. The Kasavana–Smith convention. */
export const POPULARITY_RULE_BP = 7_000;

/**
 * Below this many costed dishes, the quadrants are noise.
 *
 * With three dishes the "average" is one of them, and the grid says more about
 * arithmetic than about the menu. Saying so is better than drawing a chart
 * somebody will act on.
 */
export const MIN_ITEMS = 4;

/** And below this many plates, one large table decides the whole grid. */
export const MIN_PLATES = 20;

export const QUADRANT_LABEL: Record<Quadrant, string> = {
  star: 'Star',
  plough: 'Plough-horse',
  puzzle: 'Puzzle',
  dog: 'Dog',
};

/** What each quadrant means, in the words somebody would use out loud. */
export const QUADRANT_MEANING: Record<Quadrant, string> = {
  star: 'Sells well and earns well. Protect it — keep it in stock, keep the recipe honest, do not quietly shrink the portion.',
  plough: 'Popular, but thin. The kitchen is busy with it and the money is not following. Re-cost the recipe or lift the price a little; volume this high forgives a small rise.',
  puzzle: 'Earns well when it sells, and it rarely sells. Move it up the menu, rename it, or have staff mention it. Nothing needs changing in the kitchen.',
  dog: 'Neither popular nor profitable. It occupies a line on the menu, a shelf in the store, and space in a cook\'s head. Take it off unless it is there for a reason nobody wrote down.',
};

const bpOf = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 10_000) : 0);

/**
 * The whole analysis.
 *
 * `sold` and `costs` are joined on the menu item id rather than the name.
 * Names repeat across venues and change when somebody edits the menu, and a
 * report that silently merges two dishes because they were both called "Rice"
 * is worse than no report.
 */
export function menuEngineering(
  sold: DishTrade[],
  costs: CostedItem[],
  opts: { popularityRuleBp?: number; minItems?: number; minPlates?: number } = {},
): MenuEngineering {
  const rule = opts.popularityRuleBp ?? POPULARITY_RULE_BP;
  const minItems = opts.minItems ?? MIN_ITEMS;
  const minPlates = opts.minPlates ?? MIN_PLATES;

  const costBy = new Map(costs.map((c) => [c.menuItemId, c]));

  // Dishes that sold nothing tell us nothing; a zero-plate row would also
  // divide by zero on the way to a unit price.
  const traded = sold.filter((s) => s.qty > 0);

  const build = (s: DishTrade, unitCost: number): Omit<MenuRow, 'popularityBp' | 'popular' | 'profitable' | 'quadrant' | 'upside'> => {
    const unitPrice = Math.round(s.revenue / s.qty);
    const contribution = unitPrice - unitCost;
    return {
      menuItemId: s.menuItemId,
      name: s.name,
      qty: s.qty,
      revenue: s.revenue,
      unitPrice,
      unitCost,
      contribution,
      marginBp: unitPrice > 0 ? Math.round((contribution / unitPrice) * 10_000) : 0,
      totalContribution: contribution * s.qty,
    };
  };

  const blank = { popularityBp: 0, popular: false, profitable: false, quadrant: null, upside: 0 };

  // An uncosted dish is an unanswered question, not a dish that costs nothing.
  // Treating a missing recipe as a cost of zero would report it as pure profit,
  // put it in the top-right corner of the grid, and drag the benchmark up so
  // that properly costed dishes were reported as failing against it. The whole
  // report would be wrong in the direction that flatters.
  const costed: DishTrade[] = [];
  const uncostedRows: MenuRow[] = [];
  for (const s of traded) {
    const c = costBy.get(s.menuItemId);
    if (!c || c.unknown) uncostedRows.push({ ...build(s, 0), ...blank, unitCost: 0, contribution: 0, marginBp: 0, totalContribution: 0 });
    else costed.push(s);
  }

  const totalRevenue = traded.reduce((t, s) => t + s.revenue, 0);
  const uncostedRevenue = uncostedRows.reduce((t, r) => t + r.revenue, 0);
  const uncosted: Uncosted = {
    rows: uncostedRows.sort((a, b) => b.revenue - a.revenue),
    revenue: uncostedRevenue,
    revenueBp: bpOf(uncostedRevenue, totalRevenue),
  };

  const base = costed.map((s) => build(s, costBy.get(s.menuItemId)!.unitCost));
  const plates = base.reduce((t, r) => t + r.qty, 0);
  const contribution = base.reduce((t, r) => t + r.totalContribution, 0);

  const empty = (reason: string | null): MenuEngineering => ({
    rows: base
      .map((r) => ({ ...r, ...blank }))
      .sort((a, b) => b.totalContribution - a.totalContribution),
    uncosted,
    benchmarks: null,
    tooThin: reason,
    totals: {
      plates,
      revenue: totalRevenue,
      contribution,
      byQuadrant: emptyQuadrants(),
      upside: 0,
    },
  });

  if (base.length < minItems) {
    return empty(
      base.length === 0
        ? 'No dish sold in this period has a recipe, so nothing can be costed.'
        : `Only ${base.length} costed ${base.length === 1 ? 'dish' : 'dishes'} sold in this period. The comparison needs at least ${minItems} to mean anything.`,
    );
  }
  if (plates < minPlates) {
    return empty(`Only ${plates} plates sold in this period. One large table would decide the whole grid, so nothing is classified.`);
  }

  const benchmarks: Benchmarks = {
    contribution: Math.round(contribution / plates),
    marginBp: bpOf(contribution, base.reduce((t, r) => t + r.revenue, 0)),
    popularityBp: Math.round((10_000 / base.length) * (rule / 10_000)),
    items: base.length,
    plates,
  };

  const rows: MenuRow[] = base.map((r) => {
    const popularityBp = bpOf(r.qty, plates);
    const popular = popularityBp >= benchmarks.popularityBp;
    const profitable = r.contribution >= benchmarks.contribution;
    // Annotated rather than inferred: a bare ternary of string literals widens
    // to `string`, and the row then stops being a MenuRow.
    const quadrant: Quadrant = popular
      ? (profitable ? 'star' : 'plough')
      : (profitable ? 'puzzle' : 'dog');
    return {
      ...r,
      popularityBp,
      popular,
      profitable,
      quadrant,
      // What this period would have been worth had the dish met the benchmark,
      // at the volume it actually did. Not a forecast: a size, so two problems
      // can be ranked against each other rather than both called "low margin".
      upside: profitable ? 0 : (benchmarks.contribution - r.contribution) * r.qty,
    };
  }).sort((a, b) => b.totalContribution - a.totalContribution);

  const byQuadrant = emptyQuadrants();
  for (const r of rows) {
    if (!r.quadrant) continue;
    const q = byQuadrant[r.quadrant];
    q.items += 1;
    q.plates += r.qty;
    q.contribution += r.totalContribution;
    q.revenue += r.revenue;
  }

  return {
    rows,
    uncosted,
    benchmarks,
    tooThin: null,
    totals: {
      plates,
      revenue: totalRevenue,
      contribution,
      byQuadrant,
      upside: rows.reduce((t, r) => t + r.upside, 0),
    },
  };
}

function emptyQuadrants(): Record<Quadrant, { items: number; plates: number; contribution: number; revenue: number }> {
  return {
    star: { items: 0, plates: 0, contribution: 0, revenue: 0 },
    plough: { items: 0, plates: 0, contribution: 0, revenue: 0 },
    puzzle: { items: 0, plates: 0, contribution: 0, revenue: 0 },
    dog: { items: 0, plates: 0, contribution: 0, revenue: 0 },
  };
}

/**
 * The dishes worth doing something about, in the order worth doing them.
 *
 * Ranked by what the change is worth rather than by how bad the margin looks.
 * A dish thirty points below the benchmark that sells twice a week is a worse
 * use of an afternoon than one five points below it that sells sixty times,
 * and a report sorted by percentage puts them the wrong way round.
 */
export function whatToActOn(analysis: MenuEngineering, limit = 5): MenuRow[] {
  return analysis.rows
    .filter((r) => r.upside > 0)
    .sort((a, b) => b.upside - a.upside)
    .slice(0, limit);
}

/**
 * Dishes sold below what they cost to make.
 *
 * Its own list rather than a corner of the grid. Every plate of these loses
 * money, so volume makes it worse instead of better — which is the opposite of
 * how every other row on this report reads, and worth separating so nobody
 * skims past it.
 */
export function soldAtALoss(analysis: MenuEngineering): MenuRow[] {
  return analysis.rows
    .filter((r) => r.contribution < 0)
    .sort((a, b) => a.totalContribution - b.totalContribution);
}

/** "Star", or "Not costed" when there is no recipe to judge it by. */
export const quadrantLabel = (q: Quadrant | null): string => (q ? QUADRANT_LABEL[q] : 'Not costed');
