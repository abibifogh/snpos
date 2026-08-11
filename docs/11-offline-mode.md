# 11, Offline mode

**In plain terms:** if the internet drops, the restaurant keeps serving. Orders
still reach the kitchen, bills still get settled, and everything catches up by
itself when the connection comes back. Staff see a small banner telling them
they're offline and how many things are waiting to send, no guessing.

The rest of this doc is the technical detail.

## 11.1 What works offline, and what can't

| Works offline | Why |
| --- | --- |
| Browsing the menu on a staff terminal | Menu is cached locally per venue |
| Taking an order (waiter/counter) | Written to a local queue, sent on reconnect |
| Kitchen display showing queued tickets | Same local store, shared over the venue LAN |
| Accepting / rejecting / marking ready | State changes queue like any other write |
| Settling a bill, splitting, tips | Payments are records, not gateway calls; nothing external to reach |
| Opening a shift, recording an expense | Local, reconciled on sync |
| Closing a shift | **Allowed but held**: the close is computed locally and posted to the ledger only once every device has synced (see 11.5) |

| Doesn't work offline | Why, and what to do instead |
| --- | --- |
| Customer QR ordering | The customer's phone needs internet of its own to reach the menu. If guest wifi is down, waiters take orders on the terminal. This is worth saying out loud in training |
| A kitchen screen in a *different building* from the terminal | Offline mode covers one venue's local network, not the gap between two sites |
| Reports and dashboards | Read-only historical data; they simply show "last updated at HH:MM" |
| Adding a new staff member or changing prices | Admin writes require the server, deliberately |

## 11.2 How it's built

- **Local store**: IndexedDB via a thin repository layer. Every read in the apps
  goes through this layer, so the UI has no idea whether it's online.
- **Outbox**: every write becomes a queued mutation `{id, type, payload,
  idem_key, created_at, attempts}`. The queue is durable across app restarts and
  tablet reboots.
- **Sync worker**: drains the outbox in creation order whenever connectivity
  returns, with exponential backoff. Because every mutation carries an
  `idem_key`, replaying one that actually did reach the server is harmless, the
  server recognises it and returns the existing record.
- **Server IDs**: records created offline get a locally generated ID that is
  also the server ID (Appwrite accepts client-supplied IDs), so an order created
  offline keeps the same identity forever and references never break.
- **Order numbers**: offline devices allocate from a pre-issued block
  (each device is handed a range at shift open) so two tablets can't mint the
  same order number. Ranges are per venue.
- **Cache warming**: on shift open, the device pulls the full menu, add-ons,
  tables, staff list and open orders for its venue, so it starts the day
  self-sufficient.

## 11.3 Kitchen sync without the internet

The kitchen screen and the terminals are usually on the same wifi, so an
internet outage shouldn't stop an order reaching the kitchen ten feet away.

- Devices discover each other on the LAN and gossip queued orders directly
  (WebRTC data channel over a locally-discovered peer, with the KDS acting as
  the rendezvous point).
- The KDS remains the authority on what's been accepted. When the internet
  returns, the server reconciles, and because the KDS's accept/reject events
  carry timestamps and device IDs, the server can order them correctly.
- If peer discovery fails (guest/staff wifi isolation is a common cause), the
  system degrades to "orders queue until internet returns", and the terminal
  prints or shows a warning that the kitchen may not have seen the order. **A
  silent failure here is the dangerous one**, so the UI is explicit about it.

## 11.4 Conflicts

Conflicts are rare but must resolve predictably rather than cleverly.

| Conflict | Rule |
| --- | --- |
| Two devices edit the same open ticket | Line items merge (they're separate records); quantity edits use last-write-wins by device timestamp |
| An order accepted on the KDS and cancelled on a terminal, both offline | **Kitchen wins**, food may already be cooking. The cancellation becomes a void requiring a manager |
| Two devices take payment for the same bill | Both payments are kept; the bill shows as overpaid and the POS forces a manager to void one. Never silently discarded; that's someone's money |
| Menu price changed centrally while a device was offline | The order keeps the price snapshot it took at the time. Receipts stay truthful |
| Stock count entered on two devices | Latest by timestamp wins, both are kept in the audit log |

Anything the rules can't settle becomes a **conflict item** in the manager's
dashboard rather than being resolved silently.

## 11.5 Shift close while offline

A close that posts to the accounts while a terminal still holds unsent orders
would post a false figure. So:

1. The wizard runs normally and the close is computed and stored locally.
2. The shift enters `closing` and stops accepting new orders.
3. The system waits for every device registered to that venue's shift to report
   an empty outbox. The wizard shows which device is outstanding, by name.
4. Once all clear, `shift-close` runs on the server and posts the ledger
   entries.
5. If a device is genuinely lost or broken, an admin can force the close with a
   reason. It's recorded, and any orders that later arrive from that device are
   posted as a prior-period adjustment rather than being dropped.

## 11.6 Testing it

Offline behaviour that isn't tested doesn't work. Added to the Stage 7 script:

- Take 5 orders with wifi off, restore, confirm all 5 arrive exactly once.
- Take an order offline, kill the app, reopen, the order must still be queued.
- Settle a bill offline on two terminals at once, confirm the overpayment is
  flagged rather than lost.
- Close a shift with one terminal still offline; confirm the close waits and
  names that terminal.
