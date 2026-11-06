# Bar count differences, and HIVE

With **Bar count differences** switched on (feature `count_charges`, off by default), a bar count takes effect the moment it is saved. There is no approval step. Anything short, less anything over on the same count, at selling price, goes on the account of whoever answers for it, as a deduction that is **not final**. Final deductions go to **HIVE**, the payroll.

Shop, store-room and kitchen counts are unchanged: they still wait on Approvals.

## Who answers for a count

- **Closing count:** whoever opened the shift that is closing.
- **Opening count that does not agree:** whoever opened the bar shift before. The stock went before this shift started.
- **No shift before:** nobody is charged. The managers are emailed, and the notice records why.

## The flow

1. **The till saves the count.** The shelf moves at once. The till writes one `approval_notices` row of kind `count_charge`.
2. **The notify function raises the charge.** It prices each line at selling price, falling back to cost where nothing on the menu sells the item alone. It nets over against short and writes one `staff_charges` row with `decision: pending` and `answer_by` (24 hours by default, set by `answer_hours`). That row is readable by the person and by managers. The person and the managers are emailed.
3. **The person answers on the till:** accept, put it back at the next shift, or explain. Each answer is a `charge_replies` row, which the function checks and copies onto the charge. They can change it until a manager decides.
4. **A manager decides** under Approvals › Count differences: deduct, deduct part, waive, or agree to the put-back. This is also a `charge_replies` row. The function accepts it only if two things hold:
   - The row is readable by the account it names. Appwrite lets an account grant that only to itself.
   - That account's profile is an admin or a manager.

   A deduction writes a `pay` settlement. A waiver writes a `written_off` settlement. Part does both.
5. **The clock.** Every hour, anything accepted or unanswered past its deadline is deducted. Anything explained, offered back, or reopened by a manager waits for a manager. Once a day, at `remind_hour` venue time, the managers are emailed what waits for them.
6. **Undo.** A manager can take a decision back until HIVE has the deduction. The settlements are deleted and their journal entries reversed. From then on it waits for a manager, never for the clock.
7. **Put back.** At the person's next close, the till adds the agreed amount to the cash drawer's expected figure, on its own line, and records it on the shift as `putbacks`. When the shift closes, the function settles each one as cash paid back into that drawer. If the drawer still comes up short, that is the shift's own shortage, as always.

## HIVE

On Staff, an admin matches each person to a HIVE staff record. The record is stored as `hive_staff_id` and `hive_name` on the profile. A match is suggested by the same email, or by a name nobody else has, and is never applied without an admin choosing it. Anybody not matched has their deductions **held**.

Until HIVE connects, Staff › Staff owing › **Download for HIVE** gives the month's final deductions as a spreadsheet. Each row has its own reference, `POS-<charge id>`. **Mark as sent** then makes those deductions final.

### The signed paths

All three paths live on the notify function and are `POST`. They are signed like the Insight paths (see `20-insight-approvals.md`):

- **The headers:** `X-Till-At` and `X-Till-Sig`.
- **The signature:** HMAC-SHA256 over `till-link`, the time, the path and the body, each on its own line.
- **The time limit:** within five minutes.

The secret is **`HIVE_SECRET`**, set on the notify function. Without it, each path answers 503.

| Path | Body | Answer |
|---|---|---|
| `/hive/staff` | `{ "staff": [{ "id", "name", "email", "role", "active" }] }` | `{ ok, added, updated }`. People missing from the list are kept but no longer offered. |
| `/hive/deductions` | `{ "since"?: "YYYY-MM-DD", "include_sent"?: false }` | `{ ok, decimals, deductions: [{ ref, staff_id, name, amount, currency, date, description, decided_by }], held: [{ name, amount, count, reason }] }`. Amounts are in minor units. |
| `/hive/ack` | `{ "refs": ["POS-…"] }` | `{ ok, taken, unknown? }`. Taken deductions are stamped `hive_sent_at`, are never offered again, and can no longer be undone. |
