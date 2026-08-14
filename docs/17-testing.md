# Testing

Two halves. The arithmetic is checked by machine on every change. The parts
that need a real database, a real till and a real person are a checklist.

---

## The automatic half

```
npm test          # the logic suite
npm run verify    # typecheck (apps AND tests), tests, schema check, build. Before deploying.
```

162 tests, no database, about half a second. They cover the sums that decide what
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
| `seating.test.ts` | That the ticket names the place the guest actually picked, in the guest's own words. |
| `expenses.test.ts` | Whether a drawer is counted short for money it never held, and who spending is filed against. |
| `timing.test.ts` | How long a ticket has, when it is late, whether all its lines arrived, and reading the options chosen on a line — including that unreadable options say so rather than reading as a plain dish. |
| `cost-accounts.test.ts` | Which accounts add up to the dashboard's Costs figure: that no choice means all of them, that what is left out is reported rather than dropped, and that an expense with no account still lands somewhere it can be chosen. |
| `ledger.test.ts` | Which way round every account is held, what the statements come to, what an entry must satisfy to be posted, and depreciation by both methods. Also the bargain archiving strikes: an archived account is off every list that offers a choice and still on every report it already appears in, and an account with no flag at all is in use. |
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
| C8a | Take a dish added before the craft work off the menu | **Works.** No "missing required attribute" |
| C8b | Put it back | Works too |
| C8c | Take a craft one-off piece off, then look at it in admin | **Still marked a one-off** |
| C9 | Close a craft shift | **No OK / Low / Out shelf check.** Money in and money out shown |
| C10 | Close a kitchen shift | Shelf check still there, money in and out above it |
| C11 | Record spend from the craft till | Saved against the shop. **No ingredient list** on the form |
| C11a | Open Record expense | **No keyboard until a box is tapped.** Amount is blank, not 0.00 |
| C8d | Press Sold out | **No keyboard.** The list is readable straight away |
| C11b | Pick an item whose cost is not set | Cost box **blank**, nothing to clear first |
| C11c | Record spend before Provision has run | **Still saves.** Says the money source could not be kept |
| C11e | Record 5 kg of rice for GH₵120 | Line shows **GH₵24.00 per kg**. No unit price to type |
| G9 | Record spend, answer "from the money taken this shift" | Close the shift: **Should be in hand is lower by it** |
| G10 | Record spend, answer "from my own money" | Recorded, listed at close, **not taken off the count** |
| G11 | This shift → Money out | Every spend listed, with where the money came from |
| G20 | Take one cash sale and one card sale, open This shift | **Two figures, named.** Not one lump |
| G21 | Leave an order unpaid, and reject another | Neither appears in money in. Nothing to count |
| G22 | Pay half a bill, then look | The half that was paid is counted, under its method |
| G23 | Void a payment, then look | Gone from the figures. Money taken back was not taken |
| G24 | A sale with a tip | Counted, and said to be a tip rather than a sale |
| G12 | Press Correct on one, change the amount | Saved. Close screen uses the new figure |
| G13 | Close the shift, press Correct again | **Not offered.** That is an admin's from here |
| G14 | Admin → Expenses, switch a closed shift's spend to own money | Saved, and **that shift is worked out again** |
| G15 | Look at the shift after G14 | Expected and over/short have moved. **Counted is untouched** |
| G16 | An ingredient with "Counted at the end of a shift" off | **Not on the closing list.** Still enterable on a spend |
| G17 | Record 4 trips of transport on an expense | Line saved and costed. **Stock quantity does not move** |
| G18 | Record 5 kg of rice on the same expense | Rice goes up by 5. Only the overhead is skipped |
| G19 | The money-source dropdown | Reads **From my shift** and **From petty cash** |
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

### P. The books

| # | Do this | Must be true |
|---|---|---|
| P1 | Close a shift, then Accounting → Trial balance | The night's takings and costs are on it, and it balances |
| P2 | Profit & loss for this month | Income less costs. **No assets on it** |
| P3 | Balance sheet | Balances. Profit shows as **Profit kept in the business** |
| P4 | Journal → New entry, one line only | Refused, and it says an entry needs two sides |
| P5 | Two lines that do not agree | Refused **as you type**, with the amount it is out by |
| P6 | A line with a debit AND a credit | Refused. A line is one or the other |
| P7 | Post a balanced entry | On the journal, and on the trial balance |
| P8 | Reverse it | **Both entries stay.** The net effect is nought |
| P9 | Reverse the same entry again | Refused. Already reversed |
| P10 | Add an oven at GH₵2,400 over 48 months | Worth GH₵2,400 until a month is charged |
| P11 | Post depreciation for this month | GH₵50 charged. Worth GH₵2,350 |
| P12 | Post the same month again | **Nothing charged twice.** Says it was already done |
| P13 | The balance sheet after P11 | Equipment less accumulated depreciation, and it still balances |
| P14 | Mark it sold last month, post this month | Nothing charged. It stopped when it went |
| P15 | Give a manager Accounting and nothing under it | Page opens, **no tabs**, and it says why |
| P15a | Add Profit & loss and Trial balance | Those two tabs, and no others |
| P15b | Type the address with the journal tab as that manager | **Nothing shown.** The tab is the permission, not the button |
| P15c | Give a bookkeeper the journal and the bank, not the chart | They can post and reconcile, **not rename accounts** |
| P15d | Settings → who can open what | Accounting's parts **indented under it**, not loose in Money |
| P15e | The sidebar for that bookkeeper | **One Accounting link**, not six |
| P16 | Journal → Edit an entry, change a figure | Saved in place. **One entry, not two** |
| P17 | Look at the audit log after P16 | The old figures are there, under journal_edited |
| P18 | Edit an entry so it no longer balances | Refused, with the amount it is out by |
| P19 | Try to edit an entry that has been reversed | Refused. Edit the reversal instead |
| P20 | Record an expense with **no shift open** | On the trial balance straight away |
| P21 | Record one during a shift, then close the shift | On the books **once**, not twice |
| P22 | Reconcile → tick postings, enter the statement figure | Difference goes to nought, and it says Agreed |
| P23 | Enter a figure that does not match | Says how much is unexplained, and does not call it rounding |
| P24 | Agree it, then come back | The settled postings are off the list, counted as brought forward |
| P25 | Upload a bank CSV with Date, Narration, Amount | Lines imported. Day-first dates read right |
| P26 | Upload one with Money In and Money Out instead | Same result. Out comes in negative |
| P27 | Upload a file with neither | **Nothing imported**, and it names the missing columns |
| P28 | Upload the same file twice | Nothing added twice, and it says how many were already there |
| P29 | A bank line matching a posting to the pesewa, same day | Shown as **same day** |
| P30 | One matching two days later | Shown as **2d apart**, not silently accepted |
| P31 | One a pesewa out | **Not matched.** Near enough is not matched |
| P32 | Press Tick all the matches | Every matched posting ticks. Difference moves |
| P33 | A bank charge the books never had, press Record it | Posts with the statement's date and figure. Cannot be posted twice |
| P34 | Journal, an entry with no receipt, press Attach | Photo uploads. Turns into View |
| P35 | Press View | Opens the receipt |
| P36 | Close a period → close up to last month end | Says closed up to that date |
| P37 | Post a journal entry dated inside it | **Refused**, naming both dates |
| P38 | Edit an entry that sits inside it | Refused |
| P39 | Move an open entry back into it | Refused. That was the way round the rule |
| P40 | Post depreciation for a closed month | Refused |
| P41 | Close a shift while today is inside the lock | Refused, and it says why |
| P42 | Reopen to an earlier date | Warned first, then done, **with your name on it** |
| P43 | The history after P42 | Both acts listed, the reopening marked in red |
| P44 | Give somebody the journal but not Close a period | They can post; they cannot move the line |
| P45 | Profit & loss, press a cost line | Every posting behind it, **adding to that figure** |
| P46 | Read the running column to the bottom | It ends on the figure you pressed |
| P47 | Press a balance sheet line | Everything **from the beginning**, not just this month |
| P48 | A posting with a receipt attached | View opens it from inside the list |
| P49 | Change the dates, press the same line again | The list changes with them |
| P50 | Erase a period's orders only, then open the profit and loss | Figures **still there**, and the page said so beforehand |
| P51 | Erase the same period with **The books** ticked | Accounting figures go too |
| P52 | Journal → Delete on an entry | Warned, then gone. Statements move with it |
| P53 | The audit log after P52 | What it said is there, under journal_deleted |
| P54 | Delete one half of a reversal | Refused. The other half would say the opposite |
| P55 | Delete an entry inside a closed period | Refused |

### E. Permissions

| # | Do this | Must be true |
|---|---|---|
| E5 | Admin → Erase records, erase a day of orders | **They are gone and stay gone** after a reload |
| E6 | Look at any order left from a neighbouring day | Still has its items. Nothing was stripped |
| E7 | Run an erase as a manager, not an admin | Refused, **and it says so**. Nothing half-deleted |
| E8 | Admin → Orders, open a paid order, Cancel it | Gone from **This shift** in the kitchen. Record still readable |
| E9 | The shift's takings after E8 | Lower by that order. Counted cash untouched |
| E10 | Delete a paid order entirely | Order, items **and its payments** all gone |
| E11 | The closed shift after E10 | Takings and over/short worked out again |
| E12 | Open Orders as a manager | **No Cancel, no Delete.** Admins only |
| E1 | Sign in as a cashier, open Products | Can look. **No Add, no Save, no Delete** |
| E2 | Staff set to "Craft shop only" | No kitchen pages, no stations, no waste |
| E3 | Staff set to "Both" | Both groups in the sidebar |
| E4 | Manager after Settings was last saved | **Craft pages visible** |
| E13 | Untick a manager's Orders, save, reload | **Stays unticked.** It does not come back |
| E14 | Untick a page no other role has | Same. It was the case that silently failed |
| E14a | Untick several, **press Save**, then reload the app | All still unticked. The save keeps what the ticking decided |
| E14b | Grant a manager most of the app, then save | Saves. The whole thing fits in the field it is stored in |
| E15 | Tick Settings for a manager | They can open it. The dash is gone; every row is a real choice |
| E16 | Sign in as an admin after E15 | Still sees everything. Nothing here can lock the owner out |
| E17 | Mark a manager kitchen-only, open Shifts | **No Craft shop tab, and no craft shifts in the list** |
| E18 | The same on Reports and Expenses | Kitchen figures only, with no tab offering the other side |
| E19 | Scroll to the bottom of any admin page | **The last row is clear of the edge**, not against it |
| E20 | The same on a phone | Clear of the browser's own bar too |
| E21 | Shifts → Details → Details on an expense | The things bought, with quantity, each and paid |
| E22 | The same on a taxi with nothing itemised | Says so plainly rather than showing an empty table |
| E23 | An expense with an overhead line on it | That line is marked as not stocked |
| E24 | Any expense row in a shift's details | Says **what it was paid with and whose money**, every row |
| E25 | Open that expense | Both given their own block, with what the drawer count does about it |
| E26 | An expense saved before the method was recorded | Says **Not recorded** rather than guessing |
| E27 | This shift → Money out on the till | Same two facts, same words |

### F. The kitchen still works

Run these every time. The restaurant is the part that is already earning.

| # | Do this | Must be true |
|---|---|---|
| F1 | Scan a table QR, order as a guest | Lands on the kitchen screen with an estimate |
| F1a | The status page after ordering | **Order something else** is the obvious next step, full width |
| F2 | Order with several dishes | Estimate adds the prep times, never past an hour |
| F2a | Order while one 15 min ticket is already cooking | Quoted **its own time plus what is left on that one** |
| F2b | Order with three tickets ahead | All three counted, not just the first |
| F2c | Order on an empty pass | Just its own cooking time. Nothing added |
| F2d | A craft sale sitting unpaid, then a kitchen order | The shop sale adds **nothing** to the kitchen wait |
| F3 | Leave a ticket past its time | Late pill and alarm, at the moment the ticket predicted |
| F3l | A 20 min order, watch it reach 20 | **Late and ringing at 20, not 25.** No silent cushion |
| F3m | Let an order go late, then press Ready | **Late tag gone, clock stopped.** Says Ready |
| F3s | Leave that ready ticket an hour | Still no Late tag, still no sound, clock still stopped |
| F3t | A ready ticket nobody has paid for | **Unpaid**, with the amount, in place of Late |
| F3u | Take the payment on it | Unpaid tag goes. Collected can be pressed |
| F3n | Order as a guest called Ama, look at the ticket | **Ama**, beside the order number, not in the small grey |
| F3o | Answer "where are you sitting?" with Table 7 | Ticket says **Table 7**, not "Table order" |
| F3p | Order from an area, eg Poolside or Notice board area | Ticket says **that exact name**, never "Table Poolside" |
| F3q | Retire that table in admin, look at the open ticket | Still named. The plate still has to get there |
| F3r | A takeaway order | Says Takeaway. No table invented |
| F16 | Kitchen, ready order, take **half** the payment | **Ticket stays on the pass**, marked Part paid |
| F16a | Read that ticket | Says **how much is left**, not what the bill came to |
| F16b | Take a deposit on an order still cooking | Part paid shows at the top too, not only when ready |
| F17 | Press Collect & take the rest, pay the balance | Now it clears off the pass, once |
| F18 | Take half, then look at the till's floor plan | Table still shows its bill, marked part paid |
| F19 | Take half at the till, reopen that table | The order is there and the balance is what is left |
| F20 | Discount an order 100%, cook it, look at the ticket | **No charge** tag. Button says Collected · nothing to pay |
| F21 | Press it | Goes off the pass. **No payment recorded**, nothing added to takings |
| F22 | Open the payment box on such an order | Says **Nothing to pay**. No method, no amount, no tip asked |
| F23 | The same order at the till | Settles without asking for a figure |
| F24 | Close the shift after F21 | **Not blocked**, and the takings are unchanged |
| F25 | A comped order already stuck from before this | Also stops blocking. Judged on the total, not a flag |
| F26 | A comped order still on the pass | **Does** block, as uncollected. Nothing to do with money |
| F27 | A real unpaid bill | Blocks, as it always did |
| F3i | Sleep the kitchen tablet an hour, wake it, let a ticket go late | **It rings.** The sound comes back with the screen |
| F3j | Wake it and look before any order is late | Either no banner, or a red bar offering to turn sound back on |
| F3k | Press that bar | Bar goes. Test the late sound from settings and it plays |
| F3a | A 20 minute dish on an **empty** pass | Counts down from **20**. Says "20 min of cooking" |
| F3g | Leave a ticket 5 min before accepting it | Shows about **15 left**. The clock started when placed |
| F3aa | A 20 minute dish behind 14 minutes of other tickets | Counts down from **34**, and still says 20 min of cooking |
| F3ab | Let that one reach 25 minutes | **Not late.** It is inside what the customer was told |
| F3ac | Let it reach 35 | Late, and ringing. The promise is what broke |
| F3ad | A busy night, five tickets deep | The later ones are not all red at once |
| F3h | Leave one unaccepted past its prep time, then accept | Already over, and the pill agrees |
| F3b | Let it run past 20 | "due now", then "1 min over". The pill follows at the grace |
| F3c | Place an order and watch the ticket land | Items appear within a second or two. **No warning at all** |
| F3d | Watch a normal order for a minute | Never says "nothing is listed". That is for real faults |
| F3v | Order **three different dishes** at once | All three on the ticket. **Amounts add up to the order** |
| F3w | Order five dishes on a slow connection | Still all five. The screen keeps asking until they add up |
| F3x | Void a line at the till, watch the ticket | No warning. A void is not a missing line |
| F3y | Order three dishes, read the total on the ticket | **Adds up to all three.** Not one of them |
| F3z | Admin → Orders, open one, press Recheck total | Says it already matches, or corrects it and says by how much |
| F3e | An order genuinely sent with no lines | Says so, after a minute, in warning colour |
| F4 | Cancel within two minutes | Cancelled. After two minutes, refused |
| F5 | Close a shift with an unpaid order | Blocked, and it names the order |
| F6 | Close a shift properly | Summary email arrives, with the stock table |
| F11 | Order as a guest, leaving an email | Accept it: **"we have your order"** arrives. Mark ready: **"your order is ready"** arrives |
| F12 | The ready email, for a collection order | Names the pickup point in words, not a code |
| F13 | Accept the same order twice | One email, not two |
| F14 | Switch the Receipts feature off, accept an order | No email, and the function's log **says that is why** |
| F15 | Order without leaving an email | No email, and the log says the order had none |
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
| N13 | Admin → Tables, create the screen ordering link | An address ending `?s=` appears |
| N13a | Open the screen link, read the header | **No "Takeaway".** Open now or Closed, and nothing else |
| N13b | Open the walk-in link | Still says Takeaway, unchanged |
| N14 | Open it and send an order | **Thank you for your order**, the number, and the wait |
| N14a | Order on the screen leaving the email box empty | **No promise of an email.** Just the wait |
| N14b | Order giving an email, with Receipts on | Says an email will come when it is ready. And it does |
| N15 | Wait without touching it | Menu comes back **on its own**, about 20 seconds |
| N16 | Press "Order something else" first | Menu comes back at once. Basket empty |
| N17 | Order twice in a row on that screen | **No "Your orders" list.** Nobody sees the last customer's |
| N18 | The walk-in QR, unchanged | Still goes to the live status page as before |
| N19 | Order on the screen while the pass is busy | The wait quoted **includes the queue** |
| N7 | Open the till in a browser tab, as before | Still works, unchanged |
| N8 | On github.io rather than a domain | Opens on the till, not on the site root |
| N10 | Landscape till, Record expense, tap Amount | **Save is still on screen** with the keyboard up |
| N11 | Scroll that form with the keyboard up | Everything reachable. Nothing hidden behind the keys |
| N12 | The same on a phone held upright | Unchanged from before |

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
