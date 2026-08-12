# Testing

Two halves. The arithmetic is checked by machine on every change. The parts
that need a real database, a real till and a real person are a checklist.

---

## The automatic half

```
npm test          # the logic suite
npm run verify    # typecheck, tests, schema check, build. Run this before deploying.
```

58 tests, no database, about half a second. They cover the sums that decide what
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
| `money.test.ts` | The commission split never loses a pesewa at any price or rate, as a share or as a flat amount per piece. What a statement's four sections contain, and that only the ledger touches the balance. Tax, service and discounts. Splitting one tender across several bills. |
| `parity.test.ts` | **The browser and the server agree.** |
| `access.test.ts` | Who can open what, including the bug that hid the craft shop from every manager. |
| `timing.test.ts` | Quoted waits, the hour cap, when a ticket is late, the cancel window, cash handovers. |
| `shift-rules.test.ts` | Shift codes per side, the 24 hour limit including a device with the wrong clock, which orders a shift may close over, and that an order once moved is payable on the shift that took it. |

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
| C8 | Craft till, press Sold out | Shop products only. **No dishes** |
| C9 | Close a craft shift | **No OK / Low / Out shelf check.** Money in and money out shown |
| C10 | Close a kitchen shift | Shelf check still there, money in and out above it |
| C11 | Record spend from the craft till | Saved against the shop. **No ingredient list** on the form |
| C12 | Open one shift on each side | Codes read `BIST…` and `CRAF…` |
| C13 | Craft till, press This shift | This shift's sales and spending. **No kitchen tickets** |

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
| G6 | Set a maker to a flat GH₵2 a piece, sell three at different prices | Shop keeps exactly GH₵6. Percentage never applied |
| G7 | Flat GH₵2 on a piece discounted to GH₵1 | Shop keeps GH₵1, maker gets nothing. **Never negative** |
| G8 | Set a flat amount, then switch that maker back to a share | The flat is cleared. Old sales keep their own terms |

### H. The counter payment box

| # | Do this | Must be true |
|---|---|---|
| H1 | Craft sale, put the whole amount on cash | Recorded, sale settles, no "cash given" box anywhere |
| H2 | Split it: some on cash, the rest on card | Both recorded against the same sale. Entered total matches the sale |
| H3 | Enter more than the sale | Refused, and it says by how much |
| H4 | Enter less than the sale, do not tick the box | Refused. The tick is required, not implied |
| H5 | Enter less, tick the box, confirm | Part payment taken. Sale stays on the counter for the rest |
| H6 | Put an amount on a card method that needs a reference | Refuses until the reference for **that** method is entered |
| H7 | Two unpaid sales on the counter, pay both with one split | Every pesewa lands. Neither sale is over or under paid |

### J. Shifts that outstay the day

Needs a shift whose opened_at is backdated, or patience.

| # | Do this | Must be true |
|---|---|---|
| J1 | A shift open 21 hours | Warned on the bar. Still sells |
| J2 | Kitchen shift open 24 hours, place an order | **Accepted and cooked.** Payment refused, and it says why |
| J2a | Craft shift open 24 hours | **No new sales at all.** Different message from the kitchen |
| J2b | Overdue shift, order that was open BEFORE the day ran out | Settles normally. Still blocks the close |
| J2c | Close the overdue shift | Late orders **named on the close screen**, then it closes |
| J2d | Open a fresh shift | Those orders are **on the pass**, and payable |
| J2d2 | Pay one of them on that fresh shift | **Goes through.** No "came in after the shift" refusal |
| J2d3 | Leave one unpaid and try to close the fresh shift | **Blocked.** It is an ordinary order now |
| J2f | Two kitchen shifts somehow open at once | The till uses the one opened most recently |
| J2e | The shift that shelved them | Its takings and summary do not include them |
| J3 | Close it and open a fresh one | Normal service. Fresh code, fresh float |
| J4 | Leave one open past a day with the hourly job running | Manager gets one email, not twenty four |
| J5 | Set the device clock ahead, then back | The till never blocks on a clock it cannot trust |

### K. The two documents

| # | Do this | Must be true |
|---|---|---|
| K1 | Print a statement | **No commission line, no "Sold for", no "Shop kept"** anywhere on it |
| K2 | Read a statement end to end | Brought in, sold, paid, still to sell, then the balance |
| K3 | Statement for a month with no deliveries | Says so. Does not silently drop the section |
| K4 | Print a delivery slip | Prices are what the **maker** gets, not the shelf price |
| K5 | Sell some of a delivery, reprint its slip | Quantities unchanged, and **never negative** |
| K6 | Record a payment from a statement | No permission error. Balance drops within a few seconds |
| K7 | Record a payment twice on a bad connection | **One** ledger line, one deduction |

---

## Before every deploy

```
npm run verify
```

Then A1, A2, C2, C8, K6 and F1 by hand. Those six cover the ways this system
has actually broken: money credited wrongly, the two sides leaking into each
other, a shift that would not stay open, one side's catalogue showing on the
other, a write the permissions were right to refuse, and the restaurant
stopping.
