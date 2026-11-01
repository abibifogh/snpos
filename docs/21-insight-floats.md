# Orders from floats in Insight

Some staff hold a cash **float** that **Insight** (the group hub) keeps the books of. When one of them buys something for the bistro (`kitchen`), the bar (`bar`) or the craft shop (`craft`), Insight makes a **draft purchase order in the POS**. It used to make it in Odoo.

A manager here then:

1. checks the order;
2. picks a stock item for any line the POS could not match by name;
3. receives it into stock.

The money came out of the float in Insight, not out of a till drawer, a petty cash box or the bank. So receiving it makes **no drawer or box look short**.

This document covers the POS end.

## The three paths

The three paths live on the notify function, beside `/approvals/list` and `/approvals/decide`. They are signed exactly like those (see `20-insight-approvals.md`):

- **The headers:** `X-Till-At` (milliseconds) and `X-Till-Sig`.
- **The signature:** HMAC-SHA256 with `INSIGHT_SSO_SECRET` over `till-link`, the time, the path and the body, each on its own line.
- **The time limit:** within five minutes.

An unsigned or stale request gets 401 before the database is read. All three are `POST` with a JSON body. They answer `{ ok: true, ... }`, or `{ ok: false, error }` with a status.

These are Insight's own calls, not a person's. So there is no `email` in the body and nobody is looked up. Writes are put down to `insight`. Audit rows say `device: "Insight"`, `actor_id: "insight"`.

### `POST /floats/po`: make the draft

```json
{
  "key": "insight-float:123",
  "module": "bar",
  "ref": "FLT/ESI/007",
  "holder": "Esi Test",
  "supplier": "A Drinks Depot",
  "day": "2026-10-31",
  "total": 64000,
  "description": "Tonic water",
  "lines": [{ "name": "Tonic water 330ml, crate of 24", "qty": 4, "amount": 64000 }],
  "hint": "for the weekend",
  "receipt": { "mime": "image/jpeg", "data": "<base64>" },
  "by": "Kofi Test"
}
```

It answers `{ ok: true, id, poNo, status, total, module, url }`. Here `url` is `${APP_URL}/#/purchase-orders?show=<id>`, which opens the order on Purchase orders.

**Once per key.** If an order with that `key` already exists and is not cancelled, it comes back unchanged, with `already: true`. If the database has not been provisioned for these fields yet, the order is still made and the answer carries a `warning` saying to run Provision.

**Lines.** Each line is matched by name to one of that side's stock items, carefully:

1. the same name, ignoring case and punctuation;
2. otherwise an item whose every word is in the line, with the most words winning;
3. otherwise most words shared both ways, with a high bar.

A tie is no answer. A matched line carries the item, its unit and how it is bought (in its pack where it has one). A line that does not match keeps its name and no item. Either way the quantity is what was bought, and the price of one is `round(amount / qty)`. With no lines, one line is made from `description` and `total`. What was bought is kept on each line as `bought_as`.

**Supplier.** The supplier is matched to the supplier list by name, ignoring case. Otherwise the name is kept as given, or "Supplier to confirm" when blank. A supplier is never added, and neither is a stock item.

**The order.** It is made with:

- `status: draft`;
- the next PO number;
- `total` as given (when the lines come to something else, the note says so);
- `created_by: insight` and `created_by_name: "Insight (Esi Test's float)"`;
- a note like *From Insight: Esi Test's float · FLT/ESI/007 · bought 2026-10-31 · sent by Kofi Test*, followed by the description and the holder's hint;
- `insight_key`, `insight_ref`, `insight_from` ("Esi Test's float"), `receipt_file_id` and `paid_by: "float"`.

**The receipt.** It is optional. When it is under about 5 MB of base64 and a type the bucket takes (JPEG, PNG, WebP or PDF), it goes into the bucket the till's spend receipts use. That is `receipts`, or the shared bucket on a single-bucket install. Only managers and admins can read it. If it cannot be stored, the order is made without it.

### `POST /floats/po/status`: where they have got to

The body is `{ "ids": ["..."] }`, at most 100 ids. It answers `{ ok: true, orders: [{ id, poNo, status, total, receivedAt, module }] }`. Ids the POS does not have are left out.

### `POST /floats/po/cancel`: take one back

The body is `{ "id": "...", "by": "Kofi Test", "note": "Bought twice" }`.

Only an order that came from Insight and is **still a draft** can be cancelled this way. It becomes `cancelled`, with the note as `decided_note`, and gets an audit row. It answers `{ ok: true, status: "cancelled" }`.

Anything else gets 409 with a plain reason, for example *PO-0142 is already being received in the POS: cancel it there first.* Once a manager has checked an order, it is the POS's to cancel.

## What the POS does with it

**Purchase orders.** The order shows a *From Insight* badge. Opened, it shows:

- *From Insight: Esi Test's float · FLT/ESI/007*;
- a link to the receipt, if there is one;
- *Paid from: Esi Test's float, in Insight*.

Each line that did not match says what the receipt called it and offers the side's stock items. Picking one keeps what was bought and paid, and only says what it is. The buying unit can be switched between the pack and single units without moving the price. **Checked, receive it** is offered once every line has an item. It needs no approval, because the money is already spent. It marks the order ready and opens the delivery form with the order picked.

An order from a float is never sent to a supplier, and the admins are not emailed about it as a new order.

**Receiving.** Receiving uses the same spend form as any delivery, at a till or from Purchase orders. With an order from a float picked, the form does not ask where the money came from. It says *Paid from Esi Test's float, in Insight — not from the drawer*. The spend is saved with:

- `source: "float"`;
- `from_takings: false`;
- no petty cash box;
- not owed to the supplier.

So the drawer count expects no less, and no box is charged. The holder's receipt photo goes onto the spend when none was taken there.

**The books.** A float spend debits stock (or the category, for anything not on a shelf) as any spend does. It credits **2310 Paid from floats (Insight)**, a liability that says what the POS owes back to the float. The float itself is accounted for in Insight. Clear 2310 by hand when the float is squared up.

## Setting it up

1. **Run Provision** (GitHub Actions, *Provision Appwrite*). This adds:
   - the new order fields `insight_key`, `insight_ref`, `insight_from`, `receipt_file_id` and `paid_by`, with an index on `insight_key`;
   - the spend source `float`;
   - the account `2310`.

   Until it has run, orders from Insight are still made, but without those fields. Without `insight_key`, asking twice can make two. Receiving one is refused by the database until then, because it does not know the spend source `float` yet.
2. **No new secret.** The signature uses `INSIGHT_SSO_SECRET`, the one the sign-in hand-off and Approvals already use. Links use `APP_URL`.
3. In Insight, the POS's address is the notify function's domain, as for Approvals.

Code: `functions/notify/src/insight-floats.js`; on the app side, `paidFromFloat` and friends in `packages/core/src/purchase-orders.ts`, the spend form in `packages/ui/src/till.tsx`, and `apps/admin/src/pages/PurchaseOrders.tsx`.

Tests: `functions/notify/insight-floats.test.mjs` and `packages/core/src/__tests__/insight-floats.test.ts`.
