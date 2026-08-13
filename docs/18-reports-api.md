# The reporting API

A read-only door onto the records, so another system can pull the data and do
its own analysis.

It reads. It never writes, it never serves without a key, and it never sends
anybody's email address or phone number.

---

## Where it lives, and why it is inside the notify function

The Appwrite plan this runs on allows four functions and this project has four:
`order-guard`, `preorder-fire`, `kitchen-escalate` and `notify`. So the API is a
branch inside `notify`, checked before anything else that function does. It is
the same reason the hourly stock sweep lives there.

That is why `notify` is now called **"Notify: emails and reports"** in the
console. It was "Receipts, summaries and watches", which said nothing about
reports and, truncated to the width of a card, said nothing about notify
either.

That has one consequence worth writing down. `notify` now accepts requests from
outside, so its dispatch was changed: the timer branch used to be "no document
arrived", which an empty POST from anywhere would have satisfied and started
sending email. It now reads Appwrite's own trigger header, and anything that is
not a report, an event or the schedule does nothing at all.

---

## Switching it on

Add a repository secret named `REPORTS_API_KEY`, then run **Deploy functions**.

Make it long and random. Something like:

```
openssl rand -hex 32
```

With no key set, every request is refused with a 503 that says so. That is
deliberate: an endpoint serving a business's takings to whoever finds the
address is worse than an endpoint that does not work.

To change the key, change the secret and deploy again. To switch the API off,
delete the variable from the notify function in the Appwrite console.

---

## Finding it in the Appwrite console

The console lists functions by their **display name**, not by their id. The one
you want is:

> **Notify: emails and reports**  ·  id `notify`

If it still reads "Receipts, summaries and watches", that is the same function
under its old name; the next **Deploy functions** run renames it. Everything in
this document, and everything in the code, refers to it as `notify`, which is
the id on the small chip under the name.

---

## Giving it an address

A function has no address until one is created. The Domains screen starts
empty, and nothing on it is an address you already own: Appwrite makes one.

Press **Create domain**. Two ways:

**An Appwrite subdomain.** You type only the first part, a label of your
choosing, such as `snpos-reports`. Appwrite appends its own domain and shows
you the result. No DNS, nothing to wait for. This is the one to pick unless
somebody has asked otherwise.

**Your own subdomain**, such as `reports.niceoperation.com`. Tidier to hand to
another team, but it is a DNS change and a wait. See below.

Whichever it is, that address plus `/reports/...` is what the other system
calls.

### A subdomain of your own, in Cloudflare

Do it in this order. Appwrite only tells you what to point at once you have
told it the name you want, so starting in Cloudflare means guessing.

1. **In Appwrite**, Domains → Create domain → your own domain →
   `reports.niceoperation.com`. It answers with a CNAME target. Copy it.

2. **In Cloudflare**, choose `niceoperation.com`, then DNS → Records → Add
   record:

   | Field | Value |
   |---|---|
   | Type | `CNAME` |
   | Name | `reports` (the label only, not the whole address) |
   | Target | what Appwrite gave you |
   | Proxy status | **DNS only**, the grey cloud |
   | TTL | Auto |

3. **Back in Appwrite**, press Verify. A minute or two, sometimes longer.

**The proxy toggle is what goes wrong.** Cloudflare turns the orange cloud on
by default. Appwrite has to reach the address itself to prove the domain is
yours and to issue a certificate, and a proxy in front of it stops that, so
verification fails and says very little about why. Grey cloud. There is nothing
to gain from proxying an API that one system calls.

---

## If a domain cannot be created

Every function can also be called through Appwrite's own API, with no domain at
all. It is clumsier and worth avoiding, but it works.

```bash
curl -sS -X POST \
  "https://fra.cloud.appwrite.io/v1/functions/notify/executions" \
  -H "X-Appwrite-Project: <project id>" \
  -H "X-Appwrite-Key: <an API key with execution.write>" \
  -H "Content-Type: application/json" \
  -d '{
        "path": "/reports/summary?from=2026-08-01",
        "method": "GET",
        "headers": { "authorization": "Bearer <REPORTS_API_KEY>" },
        "async": false
      }'
```

The report comes back in the `responseBody` field of what that returns, as a
string of JSON.

Prefer a domain. This route needs an Appwrite API key as well as the reporting
key, and an API key is a far larger thing to hand to an outside system: it can
do everything, where the reporting key can only read reports.

---

## Calling it

```
GET  https://<function-domain>/reports/summary?from=2026-08-01&to=2026-08-12
Authorization: Bearer <REPORTS_API_KEY>
```

Every request is a `GET`. Anything else is refused with a 405.

### Ask it what it offers

```
GET /reports
```

Returns the list of resources and the parameters they take. If you only read one
thing before writing an integration, read that.

---

## Parameters

| Name | Meaning |
|---|---|
| `from` | `YYYY-MM-DD` or a full timestamp. Defaults to 30 days before `to`. |
| `to` | `YYYY-MM-DD` or a full timestamp. A plain date means **the whole of that day**. Defaults to now. |
| `module` | `kitchen` or `craft`. Omit for both. |
| `venue_id` | One venue. Omit for all. |
| `limit` | 1 to 500. Default 100. |
| `cursor` | The `next_cursor` from the previous page. |

---

## What you can ask for

### Totals

`/reports/summary` gives one object for the window: orders, covers, gross sales,
discounts, tax, service, takings, tips, expenses, net sales, average order, a
breakdown by payment method and a breakdown by side of the business.

Cancelled orders, rejected orders and pre-orders that have not fired are not
counted as sales. Voided and refunded payments are not counted as money.
`net_sales` is what was taken less what was paid back out; it is **not profit**,
because nothing here knows what anything cost to make.

### A window of time

Each takes `from`, `to` and pages with `cursor`.

| Resource | What it is |
|---|---|
| `/reports/orders` | Every sale, with its totals and its timestamps |
| `/reports/order-items` | The lines on those sales. Add `order_id=` for one order |
| `/reports/payments` | Every payment, with its method and its tip |
| `/reports/expenses` | Money paid out, with who it went to |
| `/reports/shifts` | Each shift with its floats, expected, counted and variance |
| `/reports/ledger` | The consignment ledger, one line per sale and payout |
| `/reports/intakes` | Deliveries from consignors |
| `/reports/movements` | Stock in and out, piece by piece |

### Lists of what exists

| Resource | What it is |
|---|---|
| `/reports/products` | The catalogue, both sides |
| `/reports/categories` | Sections, and which side each belongs to |
| `/reports/consignors` | Makers and their agreed terms |
| `/reports/venues` | |
| `/reports/payment_methods` | So a `method_id` can be given a name |
| `/reports/staff` | Names and roles, so a `taken_by` can be given a name |

---

## The shape of a response

```json
{
  "ok": true,
  "resource": "orders",
  "currency": { "code": "GHS", "symbol": "GH₵", "decimals": 2,
                "note": "Every money figure is a whole number in minor units." },
  "range": { "from": "2026-08-01T00:00:00.000Z", "to": "2026-08-12T23:59:59.999Z" },
  "module": "all",
  "count": 100,
  "next_cursor": "68a1f3c2b0d4e5f6a7b8",
  "data": [ … ]
}
```

### Money is an integer

`"total": 4500` is **GH₵ 45.00**, not forty-five hundred cedis. Divide by
`10 ^ currency.decimals` at the point you display it, and never before you add
anything up. This is the same rule the rest of the system follows and it exists
because floating point and money must not meet: `0.1 + 0.2` is not `0.3`, and a
report that is out by a thousandth of a pesewa a line does not reconcile against
a cash drawer.

### Paging

Keep calling with `cursor=` set to the previous response's `next_cursor` until
it comes back `null`.

```bash
cursor=""
while :; do
  page=$(curl -sS -H "Authorization: Bearer $KEY" \
    "$BASE/reports/orders?from=2026-01-01&limit=500&cursor=$cursor")
  echo "$page" | jq -c '.data[]'
  cursor=$(echo "$page" | jq -r '.next_cursor // empty')
  [ -z "$cursor" ] && break
done
```

One caution about `module`. The filter is applied after a page is read, because
rows written before the two sides were split carry no side at all and a database
filter steps straight over them. So a filtered page can come back with fewer
rows than you asked for while `next_cursor` is still set. That is not the end of
the data. Stop when `next_cursor` is `null`, never when a page looks short.

---

## What it will not give you

**Email addresses and phone numbers.** They are on an order so a receipt can
reach somebody. They are not analysis, and a copy of them in an analytics system
is one more place they can leak from. Customer *names* are included, because
"who buys the most" is a real question.

**PINs, password hashes, API keys.** Nothing of the sort is in any response.

**Anything writable.** There is no code path in the API that creates, updates or
deletes. If an integration needs to write, it is not this API.

---

## If something goes wrong

| Status | Meaning |
|---|---|
| 401 | The key is missing or wrong. It says nothing more than that, on purpose |
| 404 | No such report. Ask `/reports` for the list |
| 405 | Something other than a GET |
| 500 | The report could not be produced. The reason is in the function's logs, not in the response |
| 503 | `REPORTS_API_KEY` has not been set on the notify function |

---

## Checking it works

```bash
BASE=https://<function-domain>
KEY=<your key>

curl -sS -H "Authorization: Bearer $KEY" "$BASE/reports" | jq
curl -sS -H "Authorization: Bearer $KEY" "$BASE/reports/summary" | jq .data
curl -sS -i "$BASE/reports/summary" | head -1     # expect 401
```

The third one matters most. If it returns anything but a 401, stop and check the
key was actually deployed.
