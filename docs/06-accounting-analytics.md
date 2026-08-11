# 06, Accounting & analytics

## 6.1 Principle

Sales, cash and stock all post into one double-entry ledger. Dashboards read
from the ledger and from the operational collections; they never recompute
money a second, divergent way. If a dashboard and the ledger disagree, that's a
bug, not a rounding opinion.

## 6.2 What `shift-close` posts

For a shift with GH₵4,000 food sales, GH₵500 tax, GH₵200 tips, GH₵150 cash
expenses, GH₵2,600 cash counted vs GH₵2,620 expected:

```
Dr 1000 Cash on hand            2,600
Dr 1010 Card clearing           1,900
Dr 7000 Cash over/short            20      (shortage)
   Cr 4000 Food sales                    4,000
   Cr 2100 Tax payable                     500
   Cr 2200 Tips payable                    200
Dr 6xxx Expense category          150
   Cr 1000 Cash on hand                    150
Dr 5000 COGS                    <cost>
   Cr 1200 Inventory                     <cost>
```

Purchases post `Dr 1200 Inventory / Cr 1000|2000` when received. Refunds and
voids post reversing entries with their own source rows. Discounts post to the
contra-revenue account `4900` so gross vs net revenue stays visible.

Entries must balance; `shift-close` aborts the whole close if they don't rather
than posting a half-truth.

## 6.3 Dashboards

**Sales overview**, revenue by day/week/month with prior-period comparison,
covers, average ticket, revenue by channel (QR vs waiter vs takeaway), by
category, by hour-of-day heatmap, by staff member. Peak-hour view drives
rostering.

**Menu engineering**, the classic four-quadrant plot of popularity vs
contribution margin, using recipe cost as the margin input:

| | High margin | Low margin |
| --- | --- | --- |
| **High popularity** | ★ Stars, protect, never discount | 🐎 Plough-horses, re-price or re-cost |
| **Low popularity** | 🧩 Puzzles, promote or reposition | 🐕 Dogs, remove |

This is the single most valuable report a restaurant POS produces, and you
already have every input for it.

**Purchase history per item**, for each ingredient: every purchase with date,
supplier, quantity, unit cost, and a unit-cost trend line so price creep is
visible. Purchase frequency ranking answers "which ingredient do we buy most
often" both by count of purchases and by spend, which are usually different
lists and both matter.

**Ingredient ↔ meal map**, from `recipes`, browsable in both directions: pick
an ingredient to see every dish that uses it (and what share of its usage each
dish drives), or pick a dish to see its full costed recipe. Used for allergen
tracing and for "if tomatoes double in price, which dishes hurt".

**Cost & margin**, theoretical food-cost % vs actual food-cost %, per dish and
overall. The gap between those two numbers *is* your leakage.

**Cash control**, variance by shift and by staff member over time. One-off
shortages are noise; a pattern by person is a finding.

**Operations**, kitchen acceptance time (SLA breaches from `alert_level`),
prep time by dish, rejection count grouped by reason, void and discount rates by
staff.

## 6.4 Variance flagging, usage vs sales

This is the "flag it when ingredient usage doesn't match reported sales"
requirement. `stock-variance` runs nightly and per shift close:

```
theoretical_usage = Σ over sold items ( qty_sold × recipe_qty × (1 + wastage_bp/10000) )
                  + Σ over sold add-ons ( same )

actual_usage      = opening_qty + purchases_received − counted_qty
                    − recorded_waste − transfers

variance_qty      = actual_usage − theoretical_usage
variance_bp       = variance_qty / theoretical_usage × 10000
variance_value    = variance_qty × weighted_average_unit_cost
```

A flag is raised when `|variance_bp| > settings.stock_variance_threshold_bp`
(default 10%) **and** `variance_value` exceeds a monetary floor, so a 40%
variance on GH₵2 of parsley doesn't bury a 6% variance on GH₵900 of beef.
Severity scales with value, not percentage.

The flag suggests likely causes ranked by pattern, because "you have a variance"
is useless without a next step:

| Pattern | Suggested cause |
| --- | --- |
| Consistent small over-usage on one ingredient across many shifts | Over-portioning, or the recipe quantity is wrong |
| Large variance confined to one shift or one staff member | Unrecorded sale, waste not logged, or theft |
| Variance appears right after a recipe or supplier change | Recipe/unit-conversion error, or pack size changed |
| Actual *under* theoretical (using less than sold) | Under-portioning, or a count/entry error |

Each flag is a workflow item: open → investigating → resolved, with a
resolution note, so the same variance isn't rediscovered every month.

**Cross-check against sales**: the same engine also flags dishes whose sales
count is inconsistent with depletion of an ingredient unique to them, the
classic signal of an unrung sale.

## 6.5 Reports & export

Shift report, daily Z-report, date-range P&L, tax summary, stock valuation,
purchase register, staff sales, and a full journal export. All exportable as CSV
and PDF; the journal export is shaped for import into QuickBooks/Xero/Wave so
your accountant isn't retyping anything.

Scheduled email of the daily summary to the owner via an Appwrite Function on a
cron (requires Messaging, doc 09).
