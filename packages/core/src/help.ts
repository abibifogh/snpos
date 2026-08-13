/**
 * The user manual.
 *
 * Written here rather than kept in the database because it describes how the
 * software works, and the software is what changes it: a manual that can drift
 * out of step with the build it ships in is worse than none, since people stop
 * believing it and then stop reading it.
 *
 * What the restaurant *does* control is who sees which chapter. A cook does not
 * need the chapter on accounts, and burying the one page they do need under
 * twelve they don't is how a manual goes unread. Visibility lives in the `help`
 * feature's config, see `audienceFor`.
 */

export type HelpRole = 'guest' | 'cook' | 'waiter' | 'cashier' | 'manager' | 'admin';

export const HELP_ROLES: { role: HelpRole; label: string }[] = [
  { role: 'guest', label: 'Customers' },
  { role: 'cook', label: 'Cooks' },
  { role: 'waiter', label: 'Waiters' },
  { role: 'cashier', label: 'Cashiers' },
  { role: 'manager', label: 'Managers' },
  { role: 'admin', label: 'Admins' },
];

export type HelpBlock =
  | { kind: 'p'; text: string }
  | { kind: 'h'; text: string }
  | { kind: 'steps'; items: string[] }
  | { kind: 'list'; items: string[] }
  | { kind: 'note'; text: string; tone?: 'info' | 'warn' };

export interface HelpArticle {
  id: string;
  title: string;
  summary: string;
  /** Where this is mostly used, for grouping in the contents. */
  area: 'general' | 'admin' | 'pos' | 'kitchen' | 'menu';
  /** Who this is written for. The starting point an admin can change. */
  audience: HelpRole[];
  body: HelpBlock[];
}

const p = (text: string): HelpBlock => ({ kind: 'p', text });
const h = (text: string): HelpBlock => ({ kind: 'h', text });
const steps = (...items: string[]): HelpBlock => ({ kind: 'steps', items });
const list = (...items: string[]): HelpBlock => ({ kind: 'list', items });
const note = (text: string, tone: 'info' | 'warn' = 'info'): HelpBlock => ({ kind: 'note', text, tone });

const ALL_STAFF: HelpRole[] = ['cook', 'waiter', 'cashier', 'manager', 'admin'];
const MGMT: HelpRole[] = ['manager', 'admin'];

export const HELP_ARTICLES: HelpArticle[] = [
  {
    id: 'getting_started',
    title: 'What this system is, in one page',
    summary: 'The four screens and which one you are meant to be looking at.',
    area: 'general',
    audience: ALL_STAFF,
    body: [
      p('There is one system with four screens. They all talk to the same information, so an order taken on one appears on the others straight away.'),
      list(
        'Terminal, where orders are taken and bills are settled. Waiters and cashiers live here.',
        'Kitchen, the queue of what needs cooking, with an alarm when something is running late.',
        'Customer menu, what a guest sees when they scan the QR code on their table.',
        'Admin, the menu, prices, staff, stock, expenses and reports. Managers and owners.',
      ),
      p('You do not need to close one to use another; they are separate web pages and a device can be left on whichever one it is for.'),
      note('If a screen ever looks blank or stuck, reload the page first. That fixes most of it, and nothing is lost, orders live on the server, not in the browser.'),
          h('If you also run a shop'),
      p(
        'The same four screens serve a craft shop selling on consignment. The till becomes a counter, the '
        + 'admin app gains a Craft shop group, and the kitchen screen simply has nothing to do with it. '
        + 'Which sides you run is a pair of switches under Settings.',
      ),
],
  },

  {
    id: 'taking_orders',
    title: 'Taking an order',
    summary: 'Seating a table, adding dishes, and sending them to the kitchen.',
    area: 'pos',
    audience: ['waiter', 'cashier', 'cook', 'manager', 'admin'],
    body: [
      steps(
        'On the Terminal, tap the table the guests are sitting at.',
        'Tap dishes to add them. Tap a dish again to add another of the same.',
        'If a dish has choices, protein, spice, size, a panel opens for them. Required choices must be answered before the dish can be added.',
        'Add a note to a line for anything unusual: "no pepper", "well done". The kitchen sees it in red.',
        'Tap Send to kitchen. Only then does the kitchen see it.',
      ),
      h('Adding to a table later'),
      p('Open the same table again and add more. Everything stays on one bill until it is settled, so a second round does not become a second order to chase.'),
      h('Takeaway and counter orders'),
      p('Use the Takeaway tab for anything with no table behind it, walk-ins at the counter, phone orders. It reaches the kitchen exactly the same way.'),
      note('Nothing is sent to the kitchen until you tap Send. A half-built order sitting on the screen is invisible to them, which is deliberate; it means you can build it while the guest changes their mind.'),
    ],
  },

  {
    id: 'payments',
    title: 'Settling a bill',
    summary: 'How payment is recorded, and why the system never takes money itself.',
    area: 'pos',
    audience: ['waiter', 'cashier', 'cook', 'manager', 'admin'],
    body: [
      p('This system records payments. It does not take them. The guest pays exactly as they always have, cash, your card machine, mobile money, and a member of staff then tells the system what happened.'),
      steps(
        'Open the table and tap Bill.',
        'Choose how they paid. Split across more than one method if they did.',
        'Enter a tip if there is one; it is kept separate from sales, because it is not yours.',
        'Tap Mark as paid.',
      ),
      h('Cash: two boxes, two questions'),
      p(
        'Amount to pay is how much of this bill is being settled. Cash given is what the customer '
        + 'actually handed over. They are separate on purpose: change comes off what was handed over, '
        + 'never off the bill, so somebody paying half a bill with a large note still gets the right change.',
      ),
      p(
        'Three shortcuts save the arithmetic at the counter: Pay all fills in the whole bill, Half fills '
        + 'in half, and Exact cash matches the cash to whatever is being paid.',
      ),
      note(
        'If the cash given is less than the amount being recorded, the till refuses it. Better caught at '
        + 'the counter than at the close, when the drawer disagrees and nobody remembers why.',
      ),
      h('Part payment'),
      p(
        'Type less than the total and the rest stays owed. The table stays open until the whole bill is '
        + 'settled, so a party paying in pieces is just several payments against the same bill.',
      ),
      h('Emailing the receipt'),
      p('If the guest gave an email address when ordering it is already there. If not, you can type one in, or skip it, skipping is a normal answer and is recorded as such.'),
      note('Only people whose profile allows it can mark a bill paid. If the button is greyed out for you, that is a setting an admin controls, not a fault.', 'warn'),
    ],
  },

  {
    id: 'discounts',
    title: 'Discounts',
    summary: 'Giving one, and the limit on how much you may give.',
    area: 'pos',
    audience: ['waiter', 'cashier', 'manager', 'admin'],
    body: [
      p('A discount can be applied to a whole bill or to one line. A guest may also have arrived with a code, which the system checks itself.'),
      h('Your limit'),
      p('Each person has a maximum discount they may give without a manager. If you try to go beyond yours the system stops you and says so. That limit is set per person in Admin → Staff, so ask a manager rather than assuming it is broken.'),
      h('Codes from guests'),
      p('A code a guest types in when ordering is checked on the server before it counts, an expired or invented code simply does not apply, and the price they see stays the real one.'),
    ],
  },

  {
    id: 'kitchen_screen',
    title: 'The kitchen screen',
    summary: 'Accepting tickets, the alarm, and what the colours mean.',
    area: 'kitchen',
    audience: ['cook', 'manager', 'admin'],
    body: [
      p('Every ticket moves through four states, and moving it is how everyone else knows where the food is.'),
      list(
        'New, just arrived. Tap Accept to say you have seen it.',
        'Accepted, you know about it. Tap Start when it goes on.',
        'Cooking, in progress. Tap Ready when it can go out.',
        'Ready, waiting to be collected.',
      ),
      h('The alarm'),
      p('Each dish has an expected prep time. When a ticket passes it, the ticket turns red and an alarm sounds. It gets more insistent the longer nobody touches it.'),
      p('There is deliberately no snooze. Accepting the ticket stops it, which is the point, because it means the alarm can only be silenced by someone who has actually looked.'),
      note('The alarm needs the screen to have been tapped once after the browser opens; that is a browser rule about sound, not a setting. Entering your PIN counts as that tap.'),
      h('Stations'),
      p('If your kitchen has stations set up, the tabs across the top filter to just yours. All shows everything.'),
    ],
  },

  {
    id: 'shifts',
    title: 'Opening and closing a shift',
    summary: 'The cash drawer, the count, and the stock check at close.',
    area: 'pos',
    audience: ['cashier', 'cook', 'manager', 'admin'],
    body: [
      h('Opening'),
      p('Someone opens a shift at the start of service and enters the float, the money already in the drawer. Orders can be taken without a shift, but nothing can be settled, so open one first.'),
      h('Closing'),
      steps(
        'Settle or transfer any open bills. Nothing is left dangling.',
        'Count the drawer and enter what is actually there. You are asked before being shown what was expected, counting blind is what makes the answer worth anything.',
        'Go through the stock check. What it asks depends on a setting, see below.',
        'Confirm. The system compares expected against counted and records the difference.',
      ),
      h('The stock check'),
      p('An admin chooses which of two questions staff are asked, under Settings. Both end in the same place, an OK, Low or Out against every ingredient. The difference is who decides which.'),
      note('This is the kitchen\u2019s check only. Closing a shop counter shift does not ask it: ingredients are recipes and shelves, and the shop\u2019s stock moves through deliveries and sales, which count themselves.'),
      list(
        'Tap OK, Low or Out, quick, and honest about being a glance at a shelf rather than a measurement. Fine where the same person closes most nights.',
        'Type how much is left, staff enter the amount actually on the shelf and the system works out the status from that ingredient\'s own low level. Slower, and it buys two things tapping cannot.',
      ),
      p('The two things: the same four crates get filed the same way whoever is closing, because nobody is judging. And what was counted can be measured against what the recipes say should have gone, which is the only way over-portioning, waste and theft ever show up at all.'),
      p('The list is grouped the way your shelves are, in the order somebody walks the kitchen. Under each ingredient is the guide an admin wrote for it, "OK = 10pcs or more · Low = under 10pcs", in the units on the shelf rather than the units in the database. Set those under Stock; without them, "low" means whatever each person thinks it means.'),
      note('When staff type amounts, a shift will not close with rows left blank; it names what is still to count. Type 0 for anything that has run out. The ingredient nobody looked at is exactly the one that runs out on Saturday.'),
      h('Money in and money out'),
      p(
        'The close opens with four figures before it asks you to count anything: what the drawers started '
        + 'with, what came in, what was paid out, and what should therefore be in hand. A night where half '
        + 'the takings went straight back out on a delivery and a quiet night used to look identical on '
        + 'this screen.',
      ),
      h('A day is the limit'),
      p(
        'No shift may stay open longer than 24 hours. A shift running two days measures today\u2019s cash '
        + 'against yesterday morning\u2019s float, and every figure that comes out of it is meaningless.',
      ),
      p(
        'The two sides stop differently, because they work differently.'
      ),
      list(
        'The KITCHEN keeps cooking, and keeps taking money. Anything that came in after the day was up is '
        + 'flagged when you settle it, so you know it belongs to the night before, but it is never '
        + 'refused. A customer must always be able to pay for food they have eaten.',
        'The SHOP COUNTER stops at the beginning. A sale is rung up and paid for in one movement, so '
        + 'there is nothing to gain from starting one that cannot be finished.',
      ),
      p(
        'Anything that was already open BEFORE the day ran out is settled the ordinary way, and still has '
        + 'to be before the shift can close.',
      ),
      h('Orders that move to the next shift'),
      p(
        'When you close an overdue shift, the orders it took after the day was up do not hold it open. '
        + 'They are named on the close screen, moved off that shift, and appear on the pass the moment a '
        + 'new shift is opened. Nothing is cancelled and nothing is written off: the food was cooked and '
        + 'is still owed for, on a night that has not already ended.',
      ),
      p(
        'Once an order has moved, it is an ordinary order of the shift that picked it up. It is paid there '
        + 'like anything else, and it holds THAT shift open until it is.',
      ),
      p(
        'If somebody settles a late order before you close, that is fine too. It simply lands on the shift '
        + 'that was open when the money was taken, which is where it belongs.',
      ),
      note(
        'This is the ONLY case where a shift may close with an order still open. Everything else keeps '
        + 'the ordinary rule, because a shift that closes over an unpaid bill loses the money silently.',
        'warn',
      ),
      p(
        'You are warned from 20 hours. Nothing is ever closed automatically: closing means writing down '
        + 'what was counted in the drawer, and a system that has never seen the drawer would be inventing '
        + 'that number. If one is left open, a manager gets an email.',
      ),
      note(
        'Shift codes say which counter they belong to. The bistro\u2019s start with BIST and the shop\u2019s '
        + 'with CRAF, so two rows in a list can be told apart without opening either.',
      ),
      h('Being over or short'),
      p('A difference is recorded, not hidden, and a large one asks for an explanation. This is not an accusation, drawers drift for honest reasons, and a system that quietly rounded it away would be useless the day it mattered.'),
      note('Marking an ingredient OUT sets it to zero, and the shift summary that goes out at close lists anything that has been low three shifts running separately from anything low for the first time. Repeatedly low is a different problem from newly low.'),
      note('Whether you can open or close a shift is set per person, not by job title. On a quiet shift the cook is the cashier, and an admin can grant exactly that.', 'warn'),
      h('What you personally finished with'),
      p(
        'Closing the shift balances the drawer. It does not say who left with what, and on a shift worked by ' +
        'three people that is a different question. Use Hand over cash when you finish. See the chapter ' +
        'on handing your cash over.',
      ),
    ],
  },

  {
    id: 'menu_setup',
    title: 'Setting up the menu',
    summary: 'Categories, dishes, options, photos and stations.',
    area: 'admin',
    audience: MGMT,
    body: [
      h('Categories first'),
      p('Every dish belongs to at least one category. A category can have its own available hours, which is how Lunch stops showing at nine in the evening.'),
      p('A dish can sit in several categories and will appear in each one during that category\'s hours, so the same dish can be on the lunch menu and the dinner menu without being entered twice. The first category ticked is its main one.'),
      h('Dishes'),
      p('Name, description, price, a photo, and how long it takes to prepare. The prep time is what the kitchen alarm counts against, so a guess that is roughly right is much better than leaving it at the default.'),
      h('Options'),
      p('Built once under Menu → Options and attached to as many dishes as you like, "Choose your protein", "How spicy". A choice can add nothing to the price: set it to 0.'),
      h('Duplicating'),
      p('Both dishes and option groups have a Duplicate button. The copy opens in the editor with "(copy)" on the name so you can change the one thing that differs before saving it.'),
      h('Stations'),
      p('A station is where food is cooked, hot line, grill, bar, pastry. Set them up under Kitchen → Stations, and each dish either names one or inherits its main category\'s.'),
      note('Stations are not pickup points. A station is inside the kitchen; a pickup point is where a customer collects. Pickup points live under Venues.', 'warn'),
          h('Who may change it'),
      p(
        'Adding, editing and deleting are for managers and owners. Everybody else with the page can look '
        + 'at it, and the Edit button says View. Looking a price up and creating a product are different '
        + 'jobs, and anybody who can create one is somebody whose slip reaches the floor at a price '
        + 'customers get charged.',
      ),
],
  },

  {
    id: 'recipes_stock',
    title: 'Ingredients, recipes and stock',
    summary: 'How selling a dish takes ingredients off the shelf.',
    area: 'admin',
    audience: MGMT,
    body: [
      p('Ingredients are what you buy and count. Recipes say how much of each one a portion of a dish uses. Without recipes, selling food and counting stock are two unrelated activities.'),
      steps(
        'Add your ingredients under Stock, name, the unit you count in, what it costs you, how much you have.',
        'Open a dish under Menu, and fill in "What it\'s made from": ingredient, how much per portion, and a wastage percentage.',
        'That is the whole link. From then on, closing a shift deducts what should have been used.',
      ),
      h('Wastage'),
      p('The skin of an onion was bought and paid for even though it never reaches the plate. Putting 10% there is not padding, leaving it out flatters every margin on your menu in the same direction.'),
      h('What it tells you'),
      list(
        'What each dish costs you, and your margin at the price you charge.',
        'What stock you should have left at the end of a shift, to compare against what you actually have.',
        'Which dishes use an ingredient, shown on the Stock list, alongside a warning for any ingredient no dish uses.',
      ),
      note('A dish with stock tracking switched on but no recipe is flagged in the dish list. That combination silently does nothing at all, so it is worth fixing or turning off.', 'warn'),
    ],
  },

  {
    id: 'expenses',
    title: 'Recording money paid out',
    summary: 'Categories, who was paid, receipts, and buying stock.',
    area: 'admin',
    audience: ['cashier', 'manager', 'admin'],
    body: [
      steps(
        'Choose a category. The list is yours, edit it under Expenses → Categories.',
        'Say who the money went to: a supplier, a member of staff, the open market, or someone else.',
        'Enter the amount and which payment method it came out of. Cash paid out reduces what the drawer should hold, automatically.',
        'Attach a photo or PDF of the receipt. Only managers and admins can see it.',
      ),
      h('Buying stock'),
      p('If the money bought ingredients, list them under "Stock bought", ingredient, quantity, unit cost. They go into stock as you save, so the shopping trip and the delivery are one job instead of two. The unit cost you enter becomes that ingredient\'s cost from then on.'),
      h('Categories and your accounts'),
      p('Each category names which line of the accounts it lands on. That is what makes a category more than a label: "Gas refill" can sit under Utilities rather than everything piling into Other.'),
      h('What it can be paid out of'),
      p(
        'By default, only cash. That is not tidiness: money taken from the drawer has to be missing from the ' +
        'drawer when it is counted at the end of the shift, so a wrong entry surfaces within hours. An expense ' +
        'recorded against mobile money reduces nothing anybody counts.',
      ),
      p(
        'An owner can widen it under Settings \u2192 Cash and shifts, for a place that genuinely pays ' +
        'suppliers by transfer. Those entries then rest on the receipt rather than on a count.',
      ),
    ],
  },

  {
    id: 'staff',
    title: 'Staff, PINs and permissions',
    summary: 'Adding someone, and deciding what they may do.',
    area: 'admin',
    audience: MGMT,
    body: [
      p('Most staff never need an email address or a password. The device is signed in once; a PIN says which person is doing something.'),
      steps(
        'Admin → Staff → Add person. Name, job, and a four-digit PIN.',
        'Tick what they may do: open a shift and the cash drawer, close a shift, take payment, and how much discount they may give.',
        'Only tick "give them a login" for people who need the admin app on their own device.',
      ),
      h('Permissions are per person'),
      p('These are not decided by job title. On a quiet shift the cook is the cashier, and this is where you say so for that particular cook.'),
      note('Obvious PINs are refused, 1111, 1234, and the other usual ones. A PIN that everybody can guess is the same as no PIN.', 'warn'),
          h('Which side they work on'),
      p(
        'Where a business runs both a kitchen and a craft shop, each person is set to Kitchen only, '
        + 'Craft shop only, or Both. Somebody set to the shop finds the till already showing products and '
        + 'never meets a station or a waste log.',
      ),
      note(
        'This is not a permission. It is about keeping somebody\u2019s screens to the work they actually do. '
        + 'The question only appears when both sides are switched on, because otherwise there is nothing '
        + 'to choose.',
      ),
],
  },

  {
    id: 'qr_codes',
    title: 'QR codes for tables and walk-ins',
    summary: 'Letting guests order from their own phone.',
    area: 'admin',
    audience: MGMT,
    body: [
      p('Each table has its own QR code, printed from Admin → Tables. A guest scans it and gets the menu with their table already known, so what they order arrives at the right place.'),
      p('There is also one walk-in code, for a counter or a takeaway queue where there is no table. Orders from it arrive marked for collection.'),
      note('A guest ordering from their phone never pays through it. The order reaches the kitchen and the bill is settled by staff exactly as any other.'),
    ],
  },

  {
    id: 'reports',
    title: 'Reading the reports',
    summary: 'What every number on the Reports page means, and what it is compared against.',
    area: 'admin',
    audience: MGMT,
    body: [
      p('Pick your dates at the top. Everything below changes together; there is one date range for the whole page, not one per panel.'),

      h('The four figures at the top'),
      p('Each one shows a total, and underneath it, how that total compares with the period before. Everything on this page is built around that second line, because a total on its own cannot tell you whether it was a good week.'),
      list(
        'Revenue, money from bills that were actually settled. An order sitting unpaid is not counted, because it is not money yet.',
        'Costs, expenses recorded in this period: the market run, the gas, the repair. Only what somebody entered. Money that left the building without being recorded cannot appear here.',
        'Kept, revenue minus costs. What the business held on to. It is not profit in the accountant\'s sense: rent, wages and anything else you have not recorded as an expense are not in it.',
        'Average order, revenue divided by the number of bills. The quickest early warning there is: takings can hold steady while this quietly falls, which means more people spending less each.',
      ),
      note('Every comparison is against the SAME LENGTH of time immediately before, the 30 days before your 30 days. Not "last month". Comparing 30 days with a 31-day month reports the extra day as growth.'),
      p('An arrow and a colour say which way it moved. Green with an arrow up is good, except on Costs, where up is red, because spending more is not an achievement.'),
      p('A dash instead of a percentage means there was nothing to compare against. Going from no takings to some takings is not "up 100%", it is your first week, and the system will not dress that up as growth.'),

      h('Money in and out'),
      p('Revenue and costs on one chart. Blue is money in, orange is money out, and the gap between the two lines is what you kept; you can read it without doing any arithmetic.'),
      p('The three buttons change the grouping. They answer different questions:'),
      list(
        'By day, what happened on a particular day. Use it to check a day you remember being unusual.',
        'By week, is this week beating last week? A day is too noisy to judge a business by; a week absorbs one bad Tuesday.',
        'By month, is the business actually growing? Nothing shorter can tell you, because a good month can hide inside a bad quarter and the other way round.',
      ),
      p('Touch or hover anywhere on the chart and it shows that day\'s revenue, costs and what you kept. "Show the figures" turns the whole chart into a table if you would rather read the numbers, or need to copy one.'),
      note('A day with no takings shows as zero rather than being skipped. A line that quietly leaves out the days you were closed draws a business that trades seven days a week.'),

      h('Which days actually earn'),
      p('The average taken on each day of the week, an average, not a total, and the difference matters. A month holds five Mondays and only four Sundays, so totalling would tell you Monday is your better day when it is only the more frequent one.'),
      p('This is the panel to look at before changing opening hours or deciding which night to staff heavily.'),

      h('Standouts'),
      list(
        'Best day and quietest day, the actual dates, so you can think about what was different. A wedding party, a power cut, rain.',
        'A typical day, the average across the days you actually traded. Days you were closed are left out, so a restaurant that shuts on Mondays is not told its typical day is a fifth worse than every day it opens.',
      ),

      h('The rest of the page'),
      list(
        'Discounts given, shown separately rather than netted off, so "how much did we give away" stays a question you can answer.',
        'Covers, how many people ate, and the spend per head. The same takings from twenty people and from sixty are very different businesses.',
        'Where the money came from, cash, card, mobile money. Worth watching: a drift towards cash is worth understanding.',
        'Best sellers, ranked by money, not by how many were sold, because that is what pays the rent. A cheap dish can top a count and contribute little.',
        'Busiest hours, for deciding who to roster and when.',
        'Emailed receipts, whether receipts actually reached people, and the reason when one did not.',
      ),
      p('Tips never appear in revenue anywhere on this page. They are owed to staff, not earned by the restaurant, and counting them as takings would overstate both the sales and the tax.'),

      h('Accounts'),
      p('Every closed shift posts a double-entry record. If it ever says "out of balance", something is genuinely wrong and worth raising rather than ignoring.'),

      h('Taking it away with you'),
      p('"Download PDF" gives you the page laid out for paper, for a meeting, or a lender, or a file. "Spreadsheet" gives you every order in the period as a CSV, for doing your own sums.'),
      h('If you run two sides'),
      p(
        'With a kitchen and a craft shop both switched on, every figure here can be read for one side or for ' +
        'the whole business. The Both / Kitchen / Craft shop buttons sit beside the download buttons, because ' +
        'what you are looking at is what you will download.',
      ),
    ],
  },

  {
    id: 'branding',
    title: 'Colours, currency and email',
    summary: 'Making it look like your restaurant.',
    area: 'admin',
    audience: MGMT,
    body: [
      p('Admin → Settings holds the restaurant name, your colours, the currency and how tax behaves. The colours flow through every screen, including the icon in the browser tab.'),
      h('Receipts by email'),
      p('Set the from-name and from-address under Settings → Email. The address must be one your email provider has verified, or every receipt will be rejected, the Reports page shows you the reason when that happens.'),
    ],
  },

  {
    id: 'order_from_phone',
    title: 'Ordering from your phone',
    summary: 'For guests scanning the code on the table.',
    area: 'menu',
    audience: ['guest'],
    body: [
      steps(
        'Browse the menu and tap anything to see it.',
        'Make any choices the dish asks for, and add a note if you need something changed.',
        'Add it to your order. Add as much as you like before sending.',
        'Send the order. It goes straight to the kitchen.',
      ),
      p('You pay at the end, with your server, exactly as usual; there is nothing to pay for here.'),
      p('If you give an email address, your receipt is sent there. If you would rather not, skip it; nothing else changes.'),
      note('If the restaurant is closed, you can still place an order for later. The kitchen stays quiet until it is time to cook it.'),
    ],
  },

  {
    id: 'troubleshooting',
    title: 'When something goes wrong',
    summary: 'The handful of problems that actually happen, and what to do.',
    area: 'general',
    audience: ALL_STAFF,
    body: [
      h('The screen is blank or stuck'),
      p('Reload the page. If it is still blank, hold the reload button (or press Ctrl+Shift+R, Cmd+Shift+R on a Mac) to load a fresh copy. Nothing is lost, everything lives on the server.'),
      h('"Could not reach the server"'),
      p('Check the device is on the internet by opening any other website. If other sites work and this one does not, tell an admin: it is usually a setting on the server side, not the device.'),
      h('A button is greyed out'),
      p('Almost always a permission set against your name rather than a fault. Ask a manager to check your profile under Admin → Staff.'),
      h('The kitchen alarm is silent'),
      p('Tap anywhere on the kitchen screen once. Browsers refuse to play sound until the page has been touched, and the screen may have been reloaded since anyone last touched it.'),
      h('A receipt did not arrive'),
      p('Admin → Reports, at the bottom, lists every receipt and the reason any of them failed. Check the guest\'s spam folder too.'),
    ],
  },
  {
    id: 'craft_till',
    title: 'Selling at the shop counter',
    summary: 'The till in craft mode: one screen, pick, charge, done.',
    area: 'pos',
    audience: ALL_STAFF,
    body: [
      p(
        'A shop counter is not a dining room. There are no tables to seat anybody at, nothing goes to a '
        + 'kitchen, and the whole sale happens while the customer stands there. So the craft till is one '
        + 'screen: the products on the left, the sale on the right.',
      ),
      h('Getting to it'),
      p(
        'It is the same till as the restaurant, at the same address. Where a business runs both sides, a '
        + 'Kitchen / Craft shop switch sits at the top. It changes what every tab contains, not which tab '
        + 'is showing: the products, the open shift and where the money lands all follow it.',
      ),
      note(
        'The device remembers your last choice, so a till that lives on the craft counter opens on the '
        + 'craft counter. Somebody set to work only the shop never sees the switch at all; they are '
        + 'already where they belong.',
      ),
      h('Making a sale'),
      steps(
        'Tap the pieces the customer is buying.',
        'If a piece comes in sizes, the till asks which before it can price the line.',
        'Press Take payment. It rings the sale up and opens the payment straight away.',
        'Put what they paid against each way of paying, take the money, done.',
      ),
      p(
        'The till stays where it is afterwards, cleared and ready for the next customer. There is nothing '
        + 'to go back to.',
      ),
      h('Paying two ways at once'),
      p(
        'A customer at a counter often puts part of a basket on a card and the rest in cash. So the '
        + 'payment box does not ask you to choose one: every way of paying has its own amount box, and you '
        + 'type what went on each. The running total is on screen the whole time, so nobody is adding up '
        + 'two numbers in their head with a queue waiting.',
      ),
      list(
        'The amounts have to add up to the sale.',
        'More than the sale is refused. That is a typo, not a tip; the tip has its own box.',
        'Less than the sale is allowed, but you have to tick to say you meant it. The rest stays owing on '
        + 'the sale and the sale stays on the counter until somebody pays it.',
      ),
      p(
        'There is no "cash given" box here. That question only exists to work out change, and the change '
        + 'is the note in your hand minus what the sale took. Type what the sale took.',
      ),
      note(
        'Press All on a line to put the whole sale on it, which is what most sales are. Once one line has '
        + 'something in it, Rest fills whatever is left onto another.',
      ),
      h('What have I sold today'),
      p(
        'Press This shift on the bar at the top. It lists every sale on this shift, what each came to, and '
        + 'anything paid out of the drawer, with money in and money out at the top. A receipt can be '
        + 'printed or emailed again from the same list.',
      ),
      h('Money paid out of the drawer'),
      p(
        'Press Record spend. Transport, a repair, anything paid out at the counter. Record it as it '
        + 'happens: money that left the drawer without a record is a shortage at the end of the night that '
        + 'nobody can explain. It is filed against the shop, not the kitchen.',
      ),
      h('Prices with a range'),
      p(
        'A product with sizes shows a range rather than one price, because with sizes there is no single '
        + 'price. A size with none left is still shown, marked "none left", so somebody asking for the '
        + 'large is told rather than left wondering why it is missing.',
      ),
      h('If a sale goes wrong'),
      p(
        'A sale rung up but not paid for stays on the counter and can be settled later from the same '
        + 'screen. It never appears on the kitchen display; a woven basket is not something anybody cooks.',
      ),
      note(
        'Nothing can be sold with no shift open. Open one from the bar at the top first, and note that the '
        + 'shop\u2019s shift is its own: opening the kitchen\u2019s does not open this one.',
        'warn',
      ),
      h('Sale numbers'),
      p(
        'Shop sales count on their own sequence with their own prefix, so a shop receipt and a restaurant '
        + 'receipt can never wear the same number. An owner sets the prefix under Settings.',
      ),
    ],
  },
  {
    id: 'craft_shop',
    title: 'Selling other people\u2019s work: the craft shop',
    summary: 'Consignors, what they are owed, and how the shop keeps its half straight.',
    area: 'admin',
    audience: MGMT,
    body: [
      p(
        'A consignment shop sells things it does not own. Somebody brings work in, the shop sells it, keeps an ' +
        'agreed share and owes the rest. That last part is the whole business, and it is where a paper system ' +
        'goes wrong first.',
      ),
      h('Turning it on'),
      steps(
        'Settings \u2192 What this business runs. Switch on Craft shop.',
        'You can have both sides on at once. A kitchen with a craft corner is one business, not two systems: one till, one set of staff, one Reports page you can read either way.',
        'A new group appears in the sidebar: Categories, Products, Consignors, Goods received and Payouts.',
      ),
      h('Consignors'),
      p(
        'Add each person who leaves work with you. They get a short code that goes on the label tied to every ' +
        'piece, their own commission rate, and the number you pay them on.',
      ),
      p(
        'The commission is what the SHOP keeps. Thirty percent means a GH\u20b5 100 basket earns the shop ' +
        'GH\u20b5 30 and the maker GH\u20b5 70.',
      ),
      h('A share, or a fixed amount'),
      p(
        'Not every agreement is a percentage. "Two cedis a basket, whatever you sell it for" is a real ' +
        'deal, and forcing it into a percentage makes it a different number at every price. So the box ' +
        'asks which kind first: a share of each sale, or a fixed amount per piece.',
      ),
      list(
        'A share takes its percentage of whatever the piece sells for.',
        'A fixed amount takes the same figure per piece however it is priced or discounted, and never more ' +
        'than the sale itself. A GH\u20b5 2 commission on a piece sold for GH\u20b5 1 takes the cedi, not two.',
      ),
      p(
        'The same choice sits on each product, for a piece negotiated on its own terms. Leave it blank and ' +
        'the maker\u2019s usual terms apply.',
      ),
      note(
        'Changing somebody\u2019s terms never rewrites the past. What was agreed is written onto each sale ' +
        'as it happens, so what a maker has already earned stays what they earned.',
      ),
      h('Booking work in'),
      steps(
        'Craft shop \u2192 Goods received \u2192 Receive a delivery.',
        'Pick the maker, then type straight down the page, one row per piece, with its price and how many.',
        'Each delivery gets a reference like INT-0007. Both of you keep it, so a question months later has one thing to look at.',
        'Everything booked in goes onto the shop floor immediately at the price you set.',
        'A delivery slip opens straight away, while the maker is still at the counter.',
      ),
      h('The delivery slip'),
      p(
        'A proper page, not a screenshot: the pieces, how many of each came in, what each one earns THEM, '
        + 'the agreed commission, and a line for each of you to sign. The commission is on it deliberately, '
        + 'because a maker who signs a slip that does not mention it has agreed to nothing.',
      ),
      note(
        'The money on the slip is theirs, after commission, not the shelf price. Two figures for the same '
        + 'basket on one piece of paper is how an argument starts. The quantities are what was handed over '
        + 'on the day, so a slip reprinted next year reads exactly as it did at the counter.',
      ),
      p(
        'Print it, or choose Save as PDF in the print dialog to send it on. Reprint any time from the Slip '
        + 'button on the delivery.',
      ),
      h('Booking a whole crate in at once'),
      p(
        'Ninety pieces is not ninety forms. Craft shop \u2192 Products \u2192 Upload a spreadsheet takes a file '
        + 'and books the lot in.',
      ),
      steps(
        'Download the template. It comes with example rows showing the two shapes a row can take.',
        'Delete the examples, paste your own rows in, save it as CSV.',
        'Choose the file. Nothing is written yet.',
        'Read what it says it found, then press the button.',
      ),
      p(
        'A piece with no sizes is one row. A piece with sizes is one row per size, all sharing the same name, '
        + 'and they become one product the till asks about. The category has to already exist and the maker\u2019s '
        + 'short code has to match one on your list.',
      ),
      note(
        'It is all of the file or none of it. Anything wrong is listed with the line it is on, and nothing is '
        + 'added until it is fixed. Importing the good rows and reporting the rest would leave you half loaded '
        + 'with no way to tell by looking which pieces went in.',
      ),
      note(
        'Every upload creates a proper delivery, one per maker, exactly as if it had been booked in at the '
        + 'counter. So a slip can be printed for it and it appears in the "what you brought in" part of that '
        + 'maker\u2019s statement. Pieces the shop owns outright get no delivery, because there is nobody to '
        + 'give a slip to.',
      ),
      h('Sizes'),
      p(
        'A basket in small, medium and large is one product and three prices. Open the product under Craft shop ' +
        '\u2192 Products and add a row per size, each with its own price and count.',
      ),
      p(
        'The till then asks which size before it can add the line, and the product list shows a price range ' +
        'rather than a single figure, because with sizes there is no single figure.',
      ),
      note(
        'Removing a size that has already sold something switches it off rather than deleting it. Its name is ' +
        'on old receipts and on somebody\u2019s statement, and those have to keep making sense.',
      ),
      h('What you owe, and paying it'),
      p(
        'Nothing stores a balance. Every sale credits a ledger, every payment debits it, and what somebody is ' +
        'owed is the sum. That is deliberate: a stored total is one careless edit away from being both ' +
        'unarguable and wrong, and in a disagreement with a maker holding their own notebook you would have ' +
        'no evidence.',
      ),
      steps(
        'Craft shop \u2192 Payouts shows who is waiting, most owed first.',
        'Open their statement to see where every figure came from.',
        'Send the money the way you always do: mobile money, cash, transfer.',
        'Then press Record a payment inside the statement, so the figure and its workings are on one screen.',
      ),
      h('What is on a statement'),
      p('Four questions, in the order a maker asks them:'),
      list(
        'What they brought in: each delivery, when, how many pieces, and what it is worth to them.',
        'What has sold: the piece, how many, and what each earned them.',
        'What they have been paid, and when.',
        'What is left to sell, and what that is worth to them.',
      ),
      p(
        'Then the balance: owed at the start, earned, paid, owed at the end. The shop\u2019s own share is '
        + 'not printed on it. It was agreed at intake and signed for on the delivery slip, and repeating it '
        + 'beside every line turns handing somebody a settlement into starting the negotiation again.',
      ),
      p(
        'Print or save as PDF prints the statement itself, as its own page, rather than the screen it is '
        + 'sitting on. It is something you can hand over.',
      ),
      note(
        'Recording a payment takes a moment to show in the balance. The payment is written by this app and '
        + 'the line that moves the balance is written by the system itself, because a balance anybody can '
        + 'type into is not evidence of anything. If it says it is still catching up, reopen the statement '
        + 'in a minute.',
      ),
      note(
        'A maker is credited when the bill is PAID, not when it is rung up. An order cancelled or walked out ' +
        'on owes nobody anything.',
      ),
      note(
        'Somebody who has stopped consigning stays on the payouts list until they are settled. Marking them ' +
        'inactive only hides them from the day-to-day lists.',
        'warn',
      ),
    ],
  },
  {
    id: 'two_sides',
    title: 'Running a kitchen and a shop together',
    summary: 'Two counters, two sets of books, one system.',
    area: 'admin',
    audience: MGMT,
    body: [
      p(
        'With both sides switched on, the two are kept apart everywhere it matters: separate shifts, separate ' +
        'expenses, separate takings. They take money at different counters and answer to different people, so ' +
        'one figure covering both would be a figure neither side could act on.',
      ),
      h('On the till'),
      list(
        'A Kitchen / Craft shop switch appears at the top, left of the tabs.',
        'It changes what every tab contains, not which tab is showing: the catalogue, the open shift and where a sale lands all follow it.',
        'The device remembers the last choice, so a till that lives on the craft counter opens on the craft counter.',
      ),
      h('Staff who only work one side'),
      p(
        'Setup \u2192 Staff \u2192 Which side do they work on. Somebody set to Craft shop only finds the till ' +
        'already showing baskets and never sees the kitchen\u2019s dishes, its stations or its waste log.',
      ),
      note(
        'This is not a permission. It is about keeping somebody\u2019s screens to the work they actually do.',
      ),
      h('Shifts'),
      list(
        'Each side opens and closes its own. Closing one leaves the other exactly where it was.',
        'The kitchen screen always runs the kitchen\u2019s shift; the craft shift is opened from the till with the switch set to Craft shop.',
        'An unpaid plate of jollof can never hold the craft shop open, and vice versa.',
      ),
      h('Reading it back'),
      p(
        'Shifts, Expenses and Reports all carry a Both / Kitchen / Craft shop filter. Both is the default, ' +
        'because the first question is usually what the whole business did.',
      ),
    ],
  },
  {
    id: 'cash_handover',
    title: 'Handing your cash over at the end',
    summary: 'Switched off for now. How it works when it is back on.',
    area: 'pos',
    audience: ALL_STAFF,
    body: [
      note(
        'Switched off for now, at the owner\u2019s request. The Hand over cash button is not on any '
        + 'screen. Nothing recorded before it was switched off has been lost, and the rest of this '
        + 'chapter describes it as it works when it is on.',
        'warn',
      ),
      p(
        'A shift is not a person. Three people can work one shift, take money in turn out of the same drawer ' +
        'and leave at different times, so closing the shift, which happens once at the end, cannot say ' +
        'who left with what.',
      ),
      p('This is how you say it, so there is a record in your name rather than a note on somebody\u2019s pad.'),
      h('Doing it'),
      steps(
        'On the till or the kitchen screen, press Hand over cash.',
        'Type how much you are handing over.',
        'Say where it is going: a manager, the safe, the next shift, the owner.',
        'Say who is taking it. Both names go on the record, because the conversation this settles is always between two people.',
        'Press Record it.',
      ),
      note(
        'It does not move any money and it does not close the shift. Hand the cash over the way you always ' +
        'do, then write it down here.',
      ),
      note(
        'You can do this whenever you finish, not only at the close. People leave at different times.',
      ),
      h('If you get it wrong'),
      p(
        'Nothing here can be edited afterwards, on purpose: a record somebody can quietly revise is not ' +
        'evidence of anything. Record a second entry with the right figure and tell a manager. Both stay on ' +
        'the record, which is the point.',
      ),
      h('What a manager sees'),
      p(
        'Admin \u2192 Shifts \u2192 Details lists what each person handed over, to whom and at what time, ' +
        'every trip, not just the total. Two trips to the safe and one of twice the size are different ' +
        'evenings, and only one of them is worth asking about.',
      ),
    ],
  },
];

/** Group the contents the way the reader thinks about it. */
export const HELP_AREAS: { area: HelpArticle['area']; label: string }[] = [
  { area: 'general', label: 'Getting started' },
  { area: 'pos', label: 'On the terminal' },
  { area: 'kitchen', label: 'In the kitchen' },
  { area: 'admin', label: 'Running the place' },
  { area: 'menu', label: 'For customers' },
];

/**
 * Who may read an article.
 *
 * The admin's choice wins where they have made one; otherwise the audience the
 * article was written for applies. Storing only the differences means a new
 * chapter in a later version arrives with a sensible audience already set
 * rather than being invisible to everyone until somebody notices.
 */
export function audienceFor(article: HelpArticle, overrides: Record<string, string[]> = {}): HelpRole[] {
  const set = overrides[article.id];
  return Array.isArray(set) ? (set as HelpRole[]) : article.audience;
}

/** The articles one person may read, in reading order. */
export function articlesFor(role: HelpRole, overrides: Record<string, string[]> = {}): HelpArticle[] {
  const order = HELP_AREAS.map((a) => a.area);
  return HELP_ARTICLES.filter((a) => audienceFor(a, overrides).includes(role)).sort(
    (a, b) => order.indexOf(a.area) - order.indexOf(b.area),
  );
}
