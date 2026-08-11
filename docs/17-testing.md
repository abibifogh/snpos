# Testing

Two halves. The arithmetic is checked by machine on every change. The parts
that need a real database, a real till and a real person are a checklist.

---

## The automatic half

```
npm test          # the logic suite
npm run verify    # typecheck, tests, schema check, build. Run this before deploying.
```

36 tests, no database, about half a second. They cover the sums that decide what
somebody is paid and what a customer is charged.

**Why these and not others.** A test that needs a live Appwrite project is a
test nobody runs. Everything here is a pure function, which is also why the
money logic was moved into files that import nothing: `consignment-math.ts`,
`orders-time.ts`, `handover-math.ts`. That split exists for testability and for
nothing else, so the modules that used to hold those functions re-export them
and no caller had to change.

### What is covered

| Suite | What it protects |
|---|---|
| `money.test.ts` | The commission split never loses a pesewa at any price or rate. A statement adds up from its own opening balance. Tax, service and discounts. |
| `parity.test.ts` | **The browser and the server agree.** |
| `access.test.ts` | Who can open what, including the bug that hid the craft shop from every manager. |
| `timing.test.ts` | Quoted waits, the hour cap, when a ticket is late, the cancel window, cash handovers. |

### The parity suite is the important one

Order totals and the commission split are each implemented **twice**: once in
`packages/core` for the browser, once in `functions/order-guard` for the server.
That is not laziness. A Vite bundle and an Appwrite function cannot share a
module, and dropping the server copy would mean trusting a phone about prices.

Two copies drift. `parity.test.ts` runs both against thousands of inputs and
fails the build the moment they disagree. If you change money arithmetic in one
place and not the other, you will find out in about half a second rather than
in a maker's statement a year later.

---

## The manual half

Run against a scratch project, not live data. Each case names what must be true,
not just what to press.

### A. Craft sale, end to end

| # | Do this | Must be true |
|---|---|---|
| A1 | Craft till: add a product, take payment | Sale recorded; consignor credited **once**; stock down **once** |
| A2 | While A1 sits unpaid, look at the kitchen screen | **The basket is not on it.** No ticket, no alarm |
| A3 | Ring up a sale, then close the payment box without paying | Sale still visible on the counter and still payable |
| A4 | Pay half, then pay the rest | Order settles; **exactly one** ledger credit, for the full amount |
| A5 | Pay with more cash than the total | Change shown is tender minus amount paid, not tender minus bill |
| A6 | Enter cash less than the amount being paid | Refused at the counter, before it reaches the drawer |

### B. Sizes

| # | Do this | Must be true |
|---|---|---|
| B1 | Product with three sizes, sell the medium | Till asks which; medium's price charged; **medium's** count drops |
| B2 | Set one size to zero and try to sell it | Offered but disabled, marked "none left" |
| B3 | Product list with sizes | Shows a **range**, never the product's own price |
| B4 | Remove a size that has already sold | Switched off, not deleted; old receipts and statements still read |
| B5 | Add a variant type under Variant types, use it | Appears in the kind dropdown on a product |

### C. The two sides apart

| # | Do this | Must be true |
|---|---|---|
| C1 | Open a kitchen shift and a craft shift together | Both open; each shows its own takings |
| C2 | Close the kitchen shift | **Craft shift still open, its figures untouched** |
| C3 | Leave a jollof order unpaid, close the craft shift | Not blocked. The reverse too |
| C4 | Craft sale, then a kitchen order | Different number sequences. Craft carries its own prefix |
| C5 | Reports → Both / Kitchen / Craft shop | Figures change; Both equals the two added up |
| C6 | Record an expense on each side | Each appears only under its own filter |
| C7 | Craft till, no shift open | Says nothing can be sold. Does **not** offer a kitchen |

### D. Money that must never double

| # | Do this | Must be true |
|---|---|---|
| D1 | Take a payment, lose connection, retry | **One** credit, **one** stock movement |
| D2 | Refresh the till mid-sale and finish it | No duplicate order, no duplicate credit |
| D3 | Change a consignor's commission, then open an old statement | **Unchanged.** The old rate still applies to old sales |
| D4 | Intake → sale → statement → payout | Balance returns to zero and can be read line by line |

### E. Permissions

| # | Do this | Must be true |
|---|---|---|
| E1 | Sign in as a cashier, open Products | Can look. **No Add, no Save, no Delete** |
| E2 | Staff set to "Craft shop only" | No kitchen pages, no stations, no waste |
| E3 | Staff set to "Both" | Both groups in the sidebar |
| E4 | Manager after Settings was last saved | **Craft pages visible** |

### F. The kitchen still works

Run these every time. The restaurant is the part that is already earning.

| # | Do this | Must be true |
|---|---|---|
| F1 | Scan a table QR, order as a guest | Lands on the kitchen screen with an estimate |
| F2 | Order with several dishes | Estimate adds the prep times, never past an hour |
| F3 | Leave a ticket past its time | Late pill and alarm, at the moment the ticket predicted |
| F4 | Cancel within two minutes | Cancelled. After two minutes, refused |
| F5 | Close a shift with an unpaid order | Blocked, and it names the order |
| F6 | Close a shift properly | Summary email arrives, with the stock table |

### G. Money at the edges

| # | Try | Must be true |
|---|---|---|
| G1 | A product priced 0.01 at 33% commission | Split adds back to exactly the price |
| G2 | 100% commission, and 0% | Maker gets nothing / everything. Never negative |
| G3 | A statement for a period with no sales | Opening equals closing. Nothing invented |
| G4 | A payout larger than the balance | Refused |
| G5 | A consignor marked inactive who is still owed | Stays on the payouts list |

---

## Before every deploy

```
npm run verify
```

Then A1, A2, C2 and F1 by hand. Those four cover the four ways this system has
actually broken: money credited wrongly, the two sides leaking into each other,
a shift that would not stay open, and the restaurant stopping.
