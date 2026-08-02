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
 * feature's config — see `audienceFor`.
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
        'Terminal — where orders are taken and bills are settled. Waiters and cashiers live here.',
        'Kitchen — the queue of what needs cooking, with an alarm when something is running late.',
        'Customer menu — what a guest sees when they scan the QR code on their table.',
        'Admin — the menu, prices, staff, stock, expenses and reports. Managers and owners.',
      ),
      p('You do not need to close one to use another; they are separate web pages and a device can be left on whichever one it is for.'),
      note('If a screen ever looks blank or stuck, reload the page first. That fixes most of it, and nothing is lost — orders live on the server, not in the browser.'),
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
        'If a dish has choices — protein, spice, size — a panel opens for them. Required choices must be answered before the dish can be added.',
        'Add a note to a line for anything unusual: "no pepper", "well done". The kitchen sees it in red.',
        'Tap Send to kitchen. Only then does the kitchen see it.',
      ),
      h('Adding to a table later'),
      p('Open the same table again and add more. Everything stays on one bill until it is settled, so a second round does not become a second order to chase.'),
      h('Takeaway and counter orders'),
      p('Use the Takeaway tab for anything with no table behind it — walk-ins at the counter, phone orders. It reaches the kitchen exactly the same way.'),
      note('Nothing is sent to the kitchen until you tap Send. A half-built order sitting on the screen is invisible to them, which is deliberate — it means you can build it while the guest changes their mind.'),
    ],
  },

  {
    id: 'payments',
    title: 'Settling a bill',
    summary: 'How payment is recorded — and why the system never takes money itself.',
    area: 'pos',
    audience: ['waiter', 'cashier', 'cook', 'manager', 'admin'],
    body: [
      p('This system records payments. It does not take them. The guest pays exactly as they always have — cash, your card machine, mobile money — and a member of staff then tells the system what happened.'),
      steps(
        'Open the table and tap Bill.',
        'Choose how they paid. Split across more than one method if they did.',
        'Enter a tip if there is one; it is kept separate from sales, because it is not yours.',
        'Tap Mark as paid.',
      ),
      h('Splitting a bill'),
      p('Split evenly between however many people, or take part payment now and the rest later. The table stays open until the whole bill is settled.'),
      h('Emailing the receipt'),
      p('If the guest gave an email address when ordering it is already there. If not, you can type one in, or skip it — skipping is a normal answer and is recorded as such.'),
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
      p('A code a guest types in when ordering is checked on the server before it counts — an expired or invented code simply does not apply, and the price they see stays the real one.'),
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
        'New — just arrived. Tap Accept to say you have seen it.',
        'Accepted — you know about it. Tap Start when it goes on.',
        'Cooking — in progress. Tap Ready when it can go out.',
        'Ready — waiting to be collected.',
      ),
      h('The alarm'),
      p('Each dish has an expected prep time. When a ticket passes it, the ticket turns red and an alarm sounds. It gets more insistent the longer nobody touches it.'),
      p('There is deliberately no snooze. Accepting the ticket stops it — which is the point, because it means the alarm can only be silenced by someone who has actually looked.'),
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
      p('Someone opens a shift at the start of service and enters the float — the money already in the drawer. Orders can be taken without a shift, but nothing can be settled, so open one first.'),
      h('Closing'),
      steps(
        'Settle or transfer any open bills. Nothing is left dangling.',
        'Count the drawer and enter what is actually there. You are asked before being shown what was expected — counting blind is what makes the answer worth anything.',
        'Go through the stock check: mark each item OK, LOW or OUT.',
        'Confirm. The system compares expected against counted and records the difference.',
      ),
      h('Being over or short'),
      p('A difference is recorded, not hidden, and a large one asks for an explanation. This is not an accusation — drawers drift for honest reasons, and a system that quietly rounded it away would be useless the day it mattered.'),
      note('Marking an ingredient OUT sets it to zero, and the shift summary that goes out at close lists anything that has been low three shifts running separately from anything low for the first time. Repeatedly low is a different problem from newly low.'),
      note('Whether you can open or close a shift is set per person, not by job title. On a quiet shift the cook is the cashier, and an admin can grant exactly that.', 'warn'),
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
      p('A dish can sit in several categories and will appear in each one during that category\'s hours — so the same dish can be on the lunch menu and the dinner menu without being entered twice. The first category ticked is its main one.'),
      h('Dishes'),
      p('Name, description, price, a photo, and how long it takes to prepare. The prep time is what the kitchen alarm counts against, so a guess that is roughly right is much better than leaving it at the default.'),
      h('Options'),
      p('Built once under Menu → Options and attached to as many dishes as you like — "Choose your protein", "How spicy". A choice can add nothing to the price: set it to 0.'),
      h('Duplicating'),
      p('Both dishes and option groups have a Duplicate button. The copy opens in the editor with "(copy)" on the name so you can change the one thing that differs before saving it.'),
      h('Stations'),
      p('A station is where food is cooked — hot line, grill, bar, pastry. Set them up under Kitchen → Stations, and each dish either names one or inherits its main category\'s.'),
      note('Stations are not pickup points. A station is inside the kitchen; a pickup point is where a customer collects. Pickup points live under Venues.', 'warn'),
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
        'Add your ingredients under Stock — name, the unit you count in, what it costs you, how much you have.',
        'Open a dish under Menu, and fill in "What it\'s made from": ingredient, how much per portion, and a wastage percentage.',
        'That is the whole link. From then on, closing a shift deducts what should have been used.',
      ),
      h('Wastage'),
      p('The skin of an onion was bought and paid for even though it never reaches the plate. Putting 10% there is not padding — leaving it out flatters every margin on your menu in the same direction.'),
      h('What it tells you'),
      list(
        'What each dish costs you, and your margin at the price you charge.',
        'What stock you should have left at the end of a shift, to compare against what you actually have.',
        'Which dishes use an ingredient — shown on the Stock list, alongside a warning for any ingredient no dish uses.',
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
        'Choose a category. The list is yours — edit it under Expenses → Categories.',
        'Say who the money went to: a supplier, a member of staff, the open market, or someone else.',
        'Enter the amount and which payment method it came out of. Cash paid out reduces what the drawer should hold, automatically.',
        'Attach a photo or PDF of the receipt. Only managers and admins can see it.',
      ),
      h('Buying stock'),
      p('If the money bought ingredients, list them under "Stock bought" — ingredient, quantity, unit cost. They go into stock as you save, so the shopping trip and the delivery are one job instead of two. The unit cost you enter becomes that ingredient\'s cost from then on.'),
      h('Categories and your accounts'),
      p('Each category names which line of the accounts it lands on. That is what makes a category more than a label: "Gas refill" can sit under Utilities rather than everything piling into Other.'),
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
      note('Obvious PINs are refused — 1111, 1234, and the other usual ones. A PIN that everybody can guess is the same as no PIN.', 'warn'),
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
    summary: 'What the numbers on the Reports page actually mean.',
    area: 'admin',
    audience: MGMT,
    body: [
      list(
        'Sales — the total of bills actually settled. Unpaid orders are not counted, because they are not money.',
        'Discounts given — shown separately rather than netted off, so "how much did we give away" stays a question you can answer.',
        'Tips — kept out of sales entirely. They are owed to staff, not earned by the restaurant.',
        'Best sellers — ranked by money, not by count, because that is what pays the rent.',
        'Busiest hours — for deciding who to roster and when.',
        'Emailed receipts — whether receipts actually reached people, and the reason when one did not.',
      ),
      h('Accounts'),
      p('Every closed shift posts a double-entry record. If it ever says "out of balance", something is genuinely wrong and worth raising rather than ignoring.'),
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
      p('Set the from-name and from-address under Settings → Email. The address must be one your email provider has verified, or every receipt will be rejected — the Reports page shows you the reason when that happens.'),
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
      p('You pay at the end, with your server, exactly as usual — there is nothing to pay for here.'),
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
      p('Reload the page. If it is still blank, hold the reload button (or press Ctrl+Shift+R, Cmd+Shift+R on a Mac) to load a fresh copy. Nothing is lost — everything lives on the server.'),
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
