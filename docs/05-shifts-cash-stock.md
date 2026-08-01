# 05 — Shifts, cash control, expenses & stock check

## 5.1 Opening a shift

Only a user with `can_open_shift` (cashier, manager, admin) may open one, and
only when no shift is `open`.

The opening float behaviour is governed by `settings.shift_float_policy`:

| Policy | Behaviour | Who sets it |
| --- | --- | --- |
| `zero` **(default)** | Every payment method starts at `shift_float_default` (normally 0). The previous shift's closing balances are **not** carried in. | admin |
| `carry_over` | The previous shift's counted cash is proposed as the opening float. Card/MoMo never carry — they settle to the bank, not the drawer. | admin |
| `prompt` | The opener is shown last shift's closing count and must explicitly choose "start at zero" or "carry over", with a reason. | admin |

This directly implements the requirement: **a new shift never inherits the last
shift's cash/card balance automatically**, and the admin holds the switch. The
chosen path is recorded in `shifts.float_source` and, when carried,
`carried_from_shift_id` — so an auditor can always see why a drawer started at
GH₵400. Every carry-over writes an `audit_log` row naming the approving user.

If the previous shift is not `closed`, opening is blocked with "Shift
2026-07-31-B is still open — close it first."

Opening steps: count the drawer → key the amount per method → optional note →
confirm. The count is stored as `opening_floats` JSON.

## 5.2 During the shift

- Every order and payment is stamped with `shift_id` at creation and is
  immutable thereafter — a payment can never migrate between shifts.
- Live shift tile on the POS: sales, cash expected in drawer, expenses,
  discounts, voids, covers, average ticket.
- **Cash drops / paid-in**: mid-shift cash removals to the safe are recorded as
  movements so the expected drawer figure stays honest.

## 5.3 Expenses

Recorded against the open shift, from the POS or admin:

- Category, payee, amount, which payment method it was paid from (usually cash
  — which reduces expected drawer), note, and a **photo of the receipt**
  uploaded to the `receipts` bucket.
- Expenses above a configurable threshold require manager approval before the
  shift can close; unapproved ones block closing and are listed by name.
- Petty-cash expenses paid from the till reduce `expected` cash automatically —
  this is the single most common source of phantom cash shortages, so it is
  wired in rather than left to a spreadsheet.

## 5.4 Closing a shift — the procedure

The close is a guided wizard; a step cannot be skipped, and the shift moves to
`closing` (blocking new orders) as soon as it starts.

**Step 1 — Open tickets.** Every unpaid or unserved order must be settled,
transferred to the next shift, or voided with a reason. Nothing is left dangling.

**Step 2 — Expenses.** Review the shift's expenses; approve or reject pending
ones; add any missed.

**Step 3 — Blind cash count.** For each method where `counted_at_close` is true,
the closer keys the counted amount **without seeing the expected figure** —
blind counting is what makes the variance meaningful. Cash is counted by
denomination (an optional note/coin grid that totals itself).

**Step 4 — Stock check** (see 5.5). Cannot be skipped for `critical`
ingredients.

**Step 5 — Review & confirm.** Now the expected vs counted vs variance table is
revealed. A variance beyond a configurable tolerance requires a written
explanation and, above a larger threshold, a manager's PIN.

**Step 6 — Post.** The `shift-close` function runs atomically:

1. Recompute `expected` per method from `payments` + `opening_floats` −
   cash expenses − drops.
2. Write `counted`, `variance`, and the shift totals.
3. Apply theoretical stock depletion (recipes × sold quantities) as
   `stock_movements` of type `sale_depletion`.
4. Reconcile counted stock: where a physical count differs from theoretical,
   write a `count_correction` movement and, if beyond threshold, a `stock_flags`
   row.
5. Post the journal entries (6.2).
6. Set `status = closed`, `posted_to_ledger = true`, generate the shift report
   (PDF/print + stored), and release the lock so the next shift can open.

**Reopening** a closed shift is admin-only, requires a reason, reverses the
journal entries with an explicit reversal entry (never a delete), and is
recorded in `audit_log`.

## 5.5 Stock check at close

The wizard lists ingredients to check — all `critical` ones plus any whose
theoretical level has crossed a threshold, with an option to show everything.

For each ingredient the app shows the name, unit, par level and (optionally) the
theoretical remaining quantity, and asks for a status:

| Status | Auto-derived when | Meaning |
| --- | --- | --- |
| **OK** | `qty ≥ low_threshold` (default: 30% of par) | Nothing to do |
| **LOW** | `0 < qty < low_threshold` | Appears on the auto-generated purchase list |
| **OUT** | `qty ≤ 0` | Items using it are auto-86'd for the next shift, and the manager is asked to confirm |

The status is **proposed automatically** from the theoretical figure and the
thresholds, and the closer can override it — an override sets
`status_source = manual_override` and is the honest signal, because the
theoretical number is a model and the shelf is the truth. Optionally the closer
keys an actual counted quantity, which feeds variance analysis (6.4).

Thresholds are per-ingredient (`low_threshold`, `par_level`) with a global
percentage fallback in settings, so you can say "500g of saffron is LOW" and
"20kg of rice is LOW" without them sharing a rule.

Output of the step: a stock status summary in the shift report, an auto-drafted
**purchase list** of everything LOW or OUT grouped by supplier, and any variance
flags.
