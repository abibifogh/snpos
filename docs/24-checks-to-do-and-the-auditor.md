# Checks, To do, and the auditor

The admin is grouped by the job being done: **Today**, **Sales**, **Stock**, **Checks**, **Money**, **Books**, **Setup**. Every key in `ADMIN_SECTIONS` is what it was, so every permission already granted carries over. Old addresses redirect to their new place.

## What moved

| What | Was | Now |
|---|---|---|
| Approvals | Its own group and page | **Today › To do**, the To decide tab. Key `waiting`, unchanged. |
| Count | Stock › Count | **Checks › Counts** (`/counts`): Count log, Count now, Missed counts |
| Staff owing | A tab of Shifts | **Checks › Differences**, the Owing tab |
| Count differences | A card on Approvals | **Checks › Differences**, the To review tab. To decide shows a summary and a link. |
| HIVE file | On Staff owing | **Differences › Deductions & HIVE** |
| HIVE matching | Foot of Staff › People | **Staff › HIVE matching** |
| Cleaning | Setup | **Checks › Cleaning** |
| Discounts | Its own link | A tab of **Products** |
| Pre-orders | Only on the till | **Sales › Bookings**, beside Group bookings |
| Accountant tools | Its own link | One **Accounting** link with a Day to day / Accountant tools switch |
| Accounts on Money out | A tab | Only for somebody who cannot reach the chart of accounts in Accounting |

## The count log

`count-log.ts` (pure) and `count-log-store.ts`. One row per count:

- stock counted at the start or end of a shift (`shift_stock_checks`, grouped by shift and phase; `stock_counts` with a shift for the shop);
- a stocktake of a store room or the shop floor;
- the cash drawer at both ends of every shift, from `opening_floats`, `expected`, `counted` and `variance` on the shift;
- **Missed**: a shift on a side that counts at that end (`countsInAtOpen` / `countsOutAtClose`) with no count, an hour after opening or once closed.

Read for the dates chosen, with no limit on how far back. Filtered by side, kind, person and "only with a difference". Downloads as a spreadsheet.

## The auditor

A role (`auditor`) and a team (`auditors`). Default pages: To do, Counts (log and missed, never Count now), Differences, Cleaning, and read-only Shifts, Orders and Stock. The database enforces read-only: `AUDITOR_READS` in `schema.mjs` adds `team:auditors` to the read permission of what they trace a difference through. Their only writes are follow-ups, notes, `charge_replies` and the audit log.

They decide a count difference alone up to `auditor_limit` on the `count_charges` feature (minor units; 100 of the currency until set). Above it they send a `recommend` reply, which the function writes onto the charge as `recommended_*` and which an admin or a manager confirms. Nobody, of any role, decides a difference on their own account. The same rules are in `core/auditor.ts` and in `functions/notify/src/count-charges.js`.

## Follow-ups

Collection `follow_ups`: `kind` task or note. Notes are written on a difference and kept. Tasks have a due day and whose they are (a role or one person).

The hourly sweep (`functions/notify/src/follow-ups.js`) raises and closes these by `auto_key`:

| Key | When | For |
|---|---|---|
| `review:<charge>` | Pending, and explained, offered back or reopened | auditor |
| `confirm:<charge>` | An auditor's recommendation waits | manager |
| `putback:<charge>` | A put-back agreed two days ago, not yet in a drawer | auditor |
| `nocount:<shift>:open\|close` | A shift opened or closed without its count | auditor |
| `approval:<count>` | A count waiting on approval for more than a day | manager |
| `overtime:<shift>` | A shift open past its limit | manager |
| `hive:<YYYY-MM>` | Final deductions not sent to HIVE: last month, and this month from the 25th | admin |

One a person closed stays closed. One the system closed comes back if its reason does.

Each morning at `remind_hour`, whoever has something due or overdue gets one email. Anything two days overdue also goes to the admins. With no auditor on the staff, theirs go to the managers and admins.
