# Testing

Two halves. The arithmetic is checked by machine on every change. The parts
that need a real database, a real till and a real person are a checklist.

---

## The automatic half

```
npm test          # the logic suite
npm run verify    # typecheck, tests, schema check, build. Run this before deploying.
```

107 tests, no database, about half a second. They cover the sums that decide what
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
| `access.test.ts` | Who can open what, including the bug that hid the craft shop from every manager, and which catalogue a customer's phone is shown. |
| `reports.test.ts` | **The only door to the outside world.** Who gets in, what a window means, and that nothing personal leaves. |
| `stock-import.test.ts` | Everything a bulk upload must refuse, which is most of what it does. |
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
| C14 | Scan a table QR as a customer | Food only. **No craft products anywhere on the menu** |
| C15 | Order from that phone menu | Lands as a kitchen order. Nothing craft can reach the pass |
| C16 | A shop with the kitchen switched off, scan its code | Shows the shop's goods, not a blank page |

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
| F3a | Accept a 20 minute dish, read the ticket | Counts down from **20**, not 25. The two figures agree |
| F3b | Let it run past 20 | "due now", then "1 min over". The pill follows at the grace |
| F3c | Place an order and watch the ticket land | Items appear within a second or two. **No warning at all** |
| F3d | Watch a normal order for a minute | Never says "nothing is listed". That is for real faults |
| F3e | An order genuinely sent with no lines | Says so, after a minute, in warning colour |
| F4 | Cancel within two minutes | Cancelled. After two minutes, refused |
| F5 | Close a shift with an unpaid order | Blocked, and it names the order |
| F6 | Close a shift properly | Summary email arrives, with the stock table |
| F7 | Press the name at the top right | PIN pad, headed "Who is taking over?" |
| F8 | Enter a second cook's PIN | Name changes. Their Accepts are recorded against them |
| F9 | Press the name, then Cancel | Back to the tickets, **still the first cook** |
| F10 | A wrong PIN during a handover | Refused. Nobody is signed out by a failed attempt |

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
| J2 | Kitchen shift open 24 hours, place an order | Accepted, cooked, **and payable.** Flagged, never refused |
| J2a | Craft shift open 24 hours | **No new sales at all.** Different message from the kitchen |
| J2b | Overdue shift, order that was open BEFORE the day ran out | Settles normally. Still blocks the close |
| J2c | Close the overdue shift | Late orders **named on the close screen**, then it closes |
| J2d | Open a fresh shift | Those orders are **on the pass**, and payable |
| J2d2 | Pay one of them on that fresh shift | **Goes through.** No "came in after the shift" refusal |
| J2d3 | Leave one unpaid and try to close the fresh shift | **Blocked.** It is an ordinary order now |
| J2f | Two kitchen shifts somehow open at once | The till uses the one opened most recently |
| J2g | Set the tablet's clock a few days behind, open a shift, take an order | **Payable.** A device clock never decides this |
| J2h | Any fresh shift, any old order | Never flagged late. A shift under a day judges nothing |
| J2e | The shift that shelved them | Its takings and summary do not include them |
| J3 | Close it and open a fresh one | Normal service. Fresh code, fresh float |
| J3a | Close an overdue shift, watch the bar | **Banner and badge go at once**, without a refresh |
| J3c | Two shifts open on one side | Says so, and names the one still waiting |
| J3e | Open a kitchen shift, try to open another | **Refused**, naming the open one's code |
| J3f | With a kitchen shift open, open a craft one | **Allowed.** The two sides are independent |
| J3d | Close them one after another | Each closes. The notice counts down and then goes |
| J3b | Close it with the network briefly off, then back | Still says closed. Never reverts to overdue |
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

### L. The reporting API

**Currently switched off** at the function's execute permission, so only L9 and
L10 apply. The rest are for whenever it is turned back on. See
`docs/18-reports-api.md`.

| # | Do this | Must be true |
|---|---|---|
| L0 | Call any report while it is off | Refused by Appwrite before any code runs |
| L1 | Call any report with no key | **401.** Nothing is served |
| L2 | Call with a wrong key | 401, and it says no more than that |
| L3 | Call with the right key | Data, with `currency` on the response |
| L4 | POST to a report | **405.** This API never writes |
| L5 | Read an order from it | **No customer email, no phone.** Name is there |
| L6 | `summary` for a day, against the shift close for that day | Takings agree to the pesewa |
| L7 | `?module=craft` | Craft only. Compare against Reports → Craft shop |
| L8 | Page with `cursor` to the end | Stops on `next_cursor: null`, and nothing is missed |
| L9 | POST an empty body to the function's URL | **No email is sent.** The sweep only runs on the timer |
| L10 | Wait for the hour | The stock sweep and daily digest still run |

### M. Bulk stock upload

| # | Do this | Must be true |
|---|---|---|
| M1 | Download the template and upload it unchanged | Reads clean. Two products, five pieces |
| M2 | Upload a file with a category that does not exist | **Nothing added.** Names the line and the real categories |
| M3 | Upload with an unknown consignor code | Refused. Nobody is credited by guesswork |
| M4 | Two rows, same name, different categories | Refused. A later row is never silently ignored |
| M5 | A piece with two sizes | One product, two sizes, quantities added up |
| M6 | Mix a sized and an unsized row under one name | Refused. Otherwise the count is read twice |
| M7 | A price cell reading "120 or 130" | Refused, **not read as 120** |
| M8 | A name containing a comma | Survives. One product, not two |
| M9 | A good file, imported | Products on the shop floor, priced right |
| M10 | Goods received, after M9 | **A delivery per maker.** Slip prints |
| M11 | That maker's statement | The delivery is in "what you brought in" |
| M12 | Sell an uploaded piece at the till | Consignor credited, stock down by one |

### N. Installed on a device

| # | Do this | Must be true |
|---|---|---|
| N1 | Android Chrome, open the till, Install app | Offers to install. Icon is the cloche, not a screenshot |
| N2 | Open it from the icon | **No address bar, no status bar.** The whole screen |
| N3 | iPad Safari, Share, Add to Home Screen, open it | No Safari chrome. Content clear of the notch and the corners |
| N4 | The same on the kitchen screen | Same again |
| N5 | Install the customer menu on a phone | Installs. Fullscreen, named after the restaurant |
| N6 | Try to install the admin app | Not offered. The back button is wanted there |
| N9 | Walk-in menu header | **No "Collect at the counter".** Says Takeaway |
| N7 | Open the till in a browser tab, as before | Still works, unchanged |
| N8 | On github.io rather than a domain | Opens on the till, not on the site root |

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
