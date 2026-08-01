# 07 — Roles & access control

Roles are **Appwrite Teams**. Collection and document permissions reference team
IDs, so the server enforces access — the UI merely hides what the server would
refuse anyway. A cook opening devtools cannot read payroll or change a price.

## 7.1 Matrix

| Capability | Diner | Cook | Waiter | Cashier | Manager | Admin |
| --- | :-: | :-: | :-: | :-: | :-: | :-: |
| View menu | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| Place order for own table | ✔ | — | ✔ | ✔ | ✔ | ✔ |
| View own order status | ✔ | — | — | — | — | — |
| View kitchen queue | — | ✔ | ✔ | ✔ | ✔ | ✔ |
| Accept / reject order | — | ✔ | — | — | ✔ | ✔ |
| Mark item ready | — | ✔ | — | — | ✔ | ✔ |
| 86 an item (sold out) | — | ✔ | — | — | ✔ | ✔ |
| Add items to open ticket | — | — | ✔ | ✔ | ✔ | ✔ |
| Void a line | — | — | ✚ | ✚ | ✔ | ✔ |
| Apply discount | — | — | ✚ | ✚ | ✔ | ✔ |
| Take payment / split bill | — | — | — | ✔ | ✔ | ✔ |
| Refund | — | — | — | ✚ | ✔ | ✔ |
| Open shift | — | — | — | ✔ | ✔ | ✔ |
| Record expense | — | — | — | ✔ | ✔ | ✔ |
| Approve expense | — | — | — | — | ✔ | ✔ |
| Close shift | — | — | — | ✚ | ✔ | ✔ |
| Carry over float | — | — | — | — | ✚ | ✔ |
| Reopen closed shift | — | — | — | — | — | ✔ |
| Stock check at close | — | ✔ | — | ✔ | ✔ | ✔ |
| Record purchases / adjust stock | — | — | — | — | ✔ | ✔ |
| Resolve variance flags | — | — | — | — | ✔ | ✔ |
| Edit menu, prices, add-ons | — | — | — | — | ✔ | ✔ |
| Edit availability windows | — | — | — | — | ✔ | ✔ |
| View sales dashboards | — | — | own | own | ✔ | ✔ |
| View accounting / ledger | — | — | — | — | ✔ | ✔ |
| Branding, currency, colours, logos | — | — | — | — | — | ✔ |
| Payment methods & tax config | — | — | — | — | — | ✔ |
| Manage users & roles | — | — | — | — | ✚ | ✔ |
| Float policy setting | — | — | — | — | — | ✔ |
| View audit log | — | — | — | — | ✔ | ✔ |

✔ allowed · ✚ allowed **with manager PIN override** or within a configured limit
· — denied

Per-user fine tuning on `staff_profiles`: `can_open_shift`,
`can_discount_up_to_bp`, `can_void`. So a senior waiter can be trusted with 10%
discounts without becoming a manager.

## 7.2 Enforcement layers

1. **Team-based collection permissions** — the baseline. `payments` is not
   writable by `cooks`, full stop.
2. **Document permissions** — a diner's anonymous user ID is granted read on
   exactly their own order at creation time.
3. **Functions with API keys** — anything requiring cross-collection integrity
   (order creation, shift close, refunds, role changes) runs server-side. These
   collections have **no** client create/update permission at all.
4. **PIN overrides** — a manager PIN entered on a waiter's terminal calls a
   function that verifies the Argon2id hash server-side and issues a
   short-lived, single-action grant. The PIN is never compared client-side.
5. **Audit log** — every privileged action is recorded with actor, before/after
   and device, written by functions so it cannot be tampered with from a client.

## 7.3 Session model

- Staff sign in once per device with email + password; the device holds a
  long-lived Appwrite session.
- Shared terminals then use **PIN-based user switching** — fast, and every
  action is still attributed to the individual, which is what makes the
  per-staff variance and void reports meaningful.
- Idle timeout returns a shared terminal to the PIN lock screen (configurable,
  default 3 minutes).
- Kitchen devices use a dedicated device account per station, so a rotating
  cook never has to log in mid-service.
- Admin accounts should have MFA enabled (Appwrite supports TOTP).
