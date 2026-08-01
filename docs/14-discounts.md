# 14 — Discounts, discount codes, and marking a bill paid

## 14.1 Two kinds of discount

| | **Staff discount** | **Discount code** |
| --- | --- | --- |
| Has a code? | No — it's a button | Yes — the guest types it |
| Who applies it | Staff, after accepting the order | The guest while ordering, or staff |
| Typical use | "Staff meal 50%", "Manager goodwill" | "OPENING20", a printed flyer, a regular's card |
| Needs manager PIN | Above your configured limit | Only if the discount itself demands it |

Both are rows in the same `discounts` collection — a discount with a blank
`code` is simply staff-only. That way one set of rules, limits and reports
covers both.

## 14.2 What a discount can be

- **Percent off** the order, a category, specific items, or a tag — with an
  optional cap, so "20% off, maximum GH₵30" is one setting rather than a
  workaround.
- **Fixed amount off**.
- **A free item**, or a percent off one specific item.
- **Free delivery**.

And what limits it:

- Minimum order total.
- Valid dates, days of the week, and a time window.
- Which channels — QR ordering, the terminal, takeaway, delivery.
- Which venues, or all of them.
- Total usage limit, and a per-customer limit.
- First order only.
- Whether it stacks with another discount (default: no).

## 14.3 Guests applying a code

On the customer's phone, at the order review step: a "Have a code?" field. On
entry the code is validated **server-side** — never in the browser, because
anything checked in the browser can be edited by the customer.

If it's invalid, expired, used up, or doesn't meet the minimum, the guest is
told plainly which of those it is (except for codes that don't exist, which get
a generic message — so nobody can guess at your codes by fishing).

An applied code shows on the order as a line the kitchen never sees and the
cashier can't miss. **Staff can remove a guest-applied code** before payment,
with a reason.

## 14.4 Staff applying a discount

Staff apply discounts **after accepting the order** and **before it's marked
paid**. Never after — a discount on a settled bill is the classic route for
cash to walk out of a restaurant, so the system doesn't allow it. Refunds
handle genuine after-the-fact cases, and they leave their own trail.

Guardrails:

- Each staff member has a ceiling (`can_discount_up_to_bp` on their profile).
  Beyond it, a manager PIN is required, entered on the same screen — no logging
  out.
- Anything above 20% needs a manager by default (`manager_pin_above_bp`).
- Only one discount applies unless the discount is explicitly marked stackable.
- Every application writes a `discount_redemptions` row: which discount, which
  order, who applied it, who approved it, at what stage, for how much.
  Reversals are recorded too — nothing is deleted.

Reports show discounts by staff member and by reason. If one person's
discounting is well above everyone else's, you'll see it without going looking.

## 14.5 Marking a bill paid

**Customers never settle a bill in the app.** Payment is always recorded by a
member of staff. This follows directly from your decision that payment happens
on your existing card machine or by cash or mobile money.

The flow:

1. Staff open the bill and pick how it was settled — cash, card, mobile money,
   or a split across several.
2. For cash, the terminal computes change. For card or mobile money, staff can
   record a reference number if you want the reconciliation to be exact.
3. Staff confirm. The order becomes `paid`, stamped with `marked_paid_by` and
   `marked_paid_at`.
4. Only then are receipt, loyalty points and the feedback prompt triggered.

Enforced, not just intended:

- The customer-facing app has **no route that can write `payment_status`,
  `marked_paid_by` or `marked_paid_at`**, and permissions on the `payments`
  collection exclude guests entirely. A customer cannot mark their own bill
  paid even with a crafted request.
- Marking paid requires `can_mark_paid` on the staff profile — on for cashiers,
  waiters and managers by default, and something you can remove per person.
- Every payment records who took it and on which device.
- Voiding a payment after the fact requires a manager and a reason, and both
  the payment and its reversal stay on the record.

## 14.6 Where discounts sit in the maths

Order of operations, which matters for tax and for your reports:

1. **Menu price**, after any time-based price rule (doc 13, feature 12).
2. **Add-ons** added.
3. **Discounts** applied — item-level first, then order-level.
4. **Service charge**, on the discounted subtotal.
5. **Tax**, per your inclusive/exclusive setting.
6. **Tips**, which are never discounted and never taxed as sales.

Time-based prices and discounts are deliberately separate things: the first
changes what the dish costs today, the second reduces a bill that was already
priced. Mixing them makes "how much did we give away this month?" unanswerable.
