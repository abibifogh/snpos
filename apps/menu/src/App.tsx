import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Modal, Spinner, Notice, useToast, Logo, HelpModal, OfflineBar, useOfflineQueue } from '@snpos/ui';
import { applyTheme } from '@snpos/ui';
import {
  ensureGuestSession, db, DB_ID, Query, listAll, loadMenu, visibleSections, computeTotals,
  formatMoney, isAvailable, parseWindows, nextAvailable, describeWindows, loadFeatures, isEnabled,
  articlesFor, HELP_AREAS,
  featureConfig, previewUrl, humanError,
  onQueueChange, startOfflineSync, flushQueue, loadWithFallback,
} from '@snpos/core';
import type {
  Settings, Venue, LoadedMenu, MenuSection, CartLine, FeatureMap, Doc,
} from '@snpos/core';
import { DishSheet } from './DishSheet';
import { CartSheet } from './CartSheet';
import { OrderStatus } from './OrderStatus';
import { myOrders, rememberOrder, orderIdFromHash, showOrderInAddress } from './myOrders';
import type { MyOrder } from './myOrders';

interface TableRow extends Doc {
  venue_id: string;
  label: string;
  zone?: string;
  kind?: 'table' | 'area';
  guest_selectable?: boolean;
  qr_token: string;
  active: boolean;
  sort?: number;
}

/** Everything the menu needs before it can render a single dish. */
interface Boot {
  settings: Settings;
  venue: Venue;
  table: TableRow | null;
  /** Tables and areas the guest may pick when the QR code did not say. */
  seating: TableRow[];
  menu: LoadedMenu;
  features: FeatureMap;
}

export function App() {
  const toast = useToast();
  const [boot, setBoot] = useState<Boot | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * Set when this business does not take orders from phones at all.
   *
   * Kept apart from `error` on purpose. Nothing has gone wrong — the sticker
   * worked, the shop simply sells over a counter — and a page headed "Sorry"
   * would send somebody looking for a member of staff to report a fault.
   */
  const [counterOnly, setCounterOnly] = useState<string | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [openDish, setOpenDish] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  // Set from the address, never from a button. See the note by `groupToken`.
  const [groupMode, setGroupMode] = useState(false);
  const [showCart, setShowCart] = useState(false);
  const [activeSection, setActiveSection] = useState<string | null>(null);
  // Set while a tap is scrolling the page, so the sections flying past on the
  // way do not each take a turn at being "current". Without it, tapping the
  // last tab lights up every tab in between.
  const jumping = useRef(0);
  // Which order's status is on screen, taken from the address so a refresh
  // comes back to it rather than dumping the guest back on the menu.
  const [viewing, setViewing] = useState<string | null>(() => orderIdFromHash());
  const [mine, setMine] = useState<MyOrder[]>(() => myOrders());
  const [historyOpen, setHistoryOpen] = useState(false);
  const queued = useOfflineQueue(onQueueChange, startOfflineSync);

  // Two kinds of QR: /?t=<token> is a specific table, /?v=<token> is a walk-in
  // code that belongs to the venue rather than to anywhere to sit.
  const params = new URLSearchParams(window.location.search);
  const token = params.get('t');
  const walkInToken = params.get('v');
  /**
   * Group ordering has its own address, and is invisible without it.
   *
   * It used to be a tab on the ordinary menu, which meant every walk-in could
   * see the party platters and what a hotel pays for them. Neither is for the
   * dining room to read. The link goes to whoever books groups — a front desk,
   * an events contact — and nobody else has a way in.
   */
  const groupToken = params.get('g');

  useEffect(() => {
    (async () => {
      try {
        // Guests never sign in. An anonymous session is what lets Appwrite
        // accept an order from someone who has only scanned a sticker, and
        // ensureGuestSession checks the session actually stuck rather than
        // assuming it did.
        //
        // Deliberately not fatal. Reading a menu needs no session at all, and a
        // browser that will not keep one should still be able to show somebody
        // what the kitchen is cooking. The complaint belongs at the moment it
        // actually costs them something, which is when they send the order.
        await ensureGuestSession().catch(() => undefined);

        const settings = await loadWithFallback('settings', async () =>
          (await db.getDocument(DB_ID, 'settings', 'main')) as unknown as Settings,
        );
        applyTheme(settings);

        // Ordering from a phone can be switched off. A craft shop where the
        // normal way to buy is to hand something to whoever is on the till has
        // no use for it, and a QR code that opens a menu nobody is watching is
        // worse than no QR code at all.
        //
        // Said plainly rather than shown as a broken page: somebody has scanned
        // a sticker and deserves to know it worked and the shop simply does not
        // take orders this way.
        if (settings.self_order_enabled === false) {
          setCounterOnly(settings.restaurant_name || null);
          return;
        }

        const venues = await listAll<Venue>('venues', [Query.equal('active', true)]);
        let table: TableRow | null = null;
        if (token) {
          const found = await db.listDocuments(DB_ID, 'tables', [Query.equal('qr_token', token), Query.limit(1)]);
          table = (found.documents[0] as unknown as TableRow) ?? null;
        }
        const venue =
          venues.find((v) => v.$id === table?.venue_id) ??
          (walkInToken ? venues.find((v) => v.walkin_token === walkInToken) : undefined) ??
          (groupToken ? venues.find((v) => v.group_token === groupToken) : undefined) ??
          venues[0];
        if (!venue) throw new Error('This restaurant has no venue set up yet.');

        // Only a token that actually matches this venue opens group ordering.
        // A guessed or stale one quietly gets the ordinary menu rather than an
        // error, which tells somebody poking at addresses nothing at all.
        setGroupMode(!!groupToken && venue.group_token === groupToken);

        // Remembered on the device, so a guest whose signal drops between the
        // car park and the table still gets a menu rather than a spinner.
        const [menu, features, allSeating] = await Promise.all([
          loadWithFallback(`menu:${venue.$id}`, () => loadMenu(venue.$id)),
          loadWithFallback(`features:${venue.$id}`, () => loadFeatures(venue.$id)),
          loadWithFallback(`tables:${venue.$id}`, () =>
            listAll<TableRow>('tables', [Query.equal('venue_id', venue.$id)]),
          ).catch(() => [] as TableRow[]),
        ]);
        // Only what the restaurant is happy for a guest to claim. A table
        // somebody else is already sitting at is still offered — two parties
        // choosing the same table is a smaller problem than a guest who cannot
        // say where they are.
        const seating = allSeating
          .filter((t) => t.active !== false && t.guest_selectable !== false)
          .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.label.localeCompare(b.label));
        setBoot({ settings, venue, table, seating, menu, features });
        setActiveSection(visibleSections(menu)[0]?.category.$id ?? null);
      } catch (e) {
        setError(humanError(e));
      }
    })();
  }, [token, walkInToken, groupToken]);

  // The phone's own back and forward buttons move between the menu and an
  // order, so the address stays the single source of truth for which is shown.
  useEffect(() => {
    const onHash = () => setViewing(orderIdFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const addLine = useCallback((line: CartLine) => {
    setCart((c) => {
      // Same dish with identical options merges rather than stacking rows.
      const twin = c.find(
        (l) =>
          l.menu_item_id === line.menu_item_id &&
          l.notes === line.notes &&
          JSON.stringify(l.addons.map((a) => a.option_id).sort()) ===
            JSON.stringify(line.addons.map((a) => a.option_id).sort()),
      );
      if (twin) return c.map((l) => (l === twin ? { ...l, qty: l.qty + line.qty } : l));
      return [...c, line];
    });
    setOpenDish(null);
    toast('Added to your order');
  }, [toast]);

  const totals = useMemo(
    () => (boot ? computeTotals({ lines: cart, settings: boot.settings }) : null),
    [cart, boot],
  );

  /**
   * Keep the tab bar honest while somebody scrolls.
   *
   * The tabs used to change only when tapped, so a guest who scrolled — which
   * is how anybody actually reads a menu — was told they were still in the
   * first section three sections later. The bar became decoration.
   *
   * The current section is the last one whose heading has passed under the
   * bar. Not "the most visible": on a long section the heading is off screen
   * for most of the reading, and on a short one two headings share the view.
   * Where the reader has got to is a position, not an area.
   */
  useEffect(() => {
    if (!boot) return;
    const bar = 56; // the sticky tab bar, in px

    const pick = () => {
      if (Date.now() < jumping.current) return;
      const seen = Array.from(document.querySelectorAll<HTMLElement>('section.section[id^="sec-"]'));
      if (seen.length === 0) return;
      let current = seen[0];
      for (const el of seen) {
        if (el.getBoundingClientRect().top - bar <= 1) current = el;
      }
      setActiveSection(current.id.slice(4));
    };

    // One measurement per frame at most. A scroll event can fire dozens of
    // times a frame on a phone, and reading getBoundingClientRect on every one
    // of them forces the browser to re-lay-out mid-scroll — which is felt as
    // the page stuttering under the thumb.
    let queued = 0;
    const onScroll = () => {
      if (queued) return;
      queued = requestAnimationFrame(() => { queued = 0; pick(); });
    };

    pick();
    // Plain scroll rather than IntersectionObserver: the question is "which
    // heading is above the line", and a scroll position answers it directly
    // instead of being reconstructed from a dozen intersection callbacks.
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      if (queued) cancelAnimationFrame(queued);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [boot, groupMode]);

  /**
   * Follow the highlighted tab along the bar.
   *
   * The bar is scrolled directly rather than with scrollIntoView, which was a
   * mistake: scrollIntoView moves EVERY scrollable ancestor, the page
   * included. Scrolling the page fired the listener above, which changed the
   * current section, which scrolled the page again — a loop that reads, on a
   * phone, as the whole menu shaking.
   *
   * Setting scrollLeft on the bar itself cannot touch the page. And it only
   * moves when the tab is actually out of view, so a guest scrolling within
   * one long section is not fighting an animation the whole way down.
   */
  useEffect(() => {
    if (!activeSection) return;
    const bar = document.querySelector<HTMLElement>('.cat-nav');
    const tab = bar?.querySelector<HTMLElement>(`button[data-cat="${activeSection}"]`);
    if (!bar || !tab) return;

    const left = tab.offsetLeft;
    const right = left + tab.offsetWidth;
    const edge = 24; // a little air, so the tab is never flush against the rim
    if (left >= bar.scrollLeft + edge && right <= bar.scrollLeft + bar.clientWidth - edge) return;

    bar.scrollTo({ left: left - bar.clientWidth / 2 + tab.offsetWidth / 2, behavior: 'smooth' });
  }, [activeSection]);


  if (counterOnly !== null) {
    return (
      <div className="centered">
        <div>
          <h2>Please order at the counter</h2>
          <p className="dim">
            {counterOnly ? `${counterOnly} does not` : 'This shop does not'} take orders from phones.
            Bring what you would like to whoever is on the till.
          </p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="centered">
        <div>
          <h2>Sorry</h2>
          <p className="dim">{error}</p>
        </div>
      </div>
    );
  }

  if (!boot) {
    return (
      <div className="centered">
        <Spinner />
      </div>
    );
  }

  // Straight to the live status page rather than a dead confirmation screen.
  // "Sent to the kitchen" answers the question for about ninety seconds; this
  // keeps answering it — and now survives a refresh, because it is in the
  // address rather than only in memory.
  if (viewing) {
    return (
      <OrderStatus
        orderId={viewing}
        settings={boot.settings}
        venue={boot.venue}
        onBack={() => {
          showOrderInAddress(null);
          setViewing(null);
          setCart([]);
        }}
      />
    );
  }

  const { settings, venue, table, seating, menu, features } = boot;
  // The link opens group ordering; the feature switch still decides whether
  // group ordering exists at all. An old link doing something an admin has
  // since turned off would be the worst of both.
  const inGroupMode = groupMode && isEnabled(features, 'group_orders');

  // Two menus, one list. Group-only sections are hidden from the ordinary
  // menu and are the only thing shown on the group one — a hotel party
  // ordering platters does not want the a la carte list, and a walk-in
  // should not be offered a set meal for twenty.
  const sections = visibleSections(menu).filter((sec) =>
    inGroupMode ? sec.category.group_only : !sec.category.group_only,
  );
  const venueHours = parseWindows(venue.opening_hours);
  const venueOpen = isAvailable(venueHours);
  const preordersOn = isEnabled(features, 'preorders');
  const allowWhenClosed = featureConfig(features, 'preorders', 'allow_when_closed', true);
  const canOrderNow = venueOpen || (preordersOn && allowWhenClosed);

  const dish = openDish ? menu.byId[openDish] : null;
  // Guests get only the chapters written for them, and only if the restaurant
  // wants the link there at all.
  const guestHelp =
    isEnabled(features, 'help') && featureConfig(features, 'help', 'show_on_customer_menu', true)
      ? articlesFor('guest', featureConfig<Record<string, string[]>>(features, 'help', 'audiences', {}))
      : [];

  return (
    <div className="menu-app">
      <OfflineBar queued={queued} onRetry={() => void flushQueue()} />
      <header className="menu-header">
        <div className="row" style={{ justifyContent: 'center', gap: '0.55rem' }}>
          <Logo size={26} />
          <h1 style={{ margin: 0 }}>{venue.name || settings.restaurant_name}</h1>
        </div>
        <div className="sub">
          {inGroupMode
            ? 'Group ordering'
            : table
              ? `Table ${table.label}`
              : walkInToken
                ? 'Collect at the counter'
                : 'Takeaway'}
          {venueOpen ? ' · Open now' : ' · Closed'}
          {/* The way back to an order already placed. Only shown when there is
              one, and it is the only route back after a refresh — without it a
              guest who reloads has no way to reach their own order again. */}
          {mine.length > 0 && (
            <>
              {' · '}
              <button className="linkish" onClick={() => setHistoryOpen(true)}>
                {mine.length === 1 ? 'Your order' : `Your orders (${mine.length})`}
              </button>
            </>
          )}
          {guestHelp.length > 0 && (
            <>
              {' · '}
              <button className="linkish" onClick={() => setHelpOpen(true)}>How this works</button>
            </>
          )}
        </div>
      </header>

      {historyOpen && (
        <Modal
          title="Your orders"
          onClose={() => setHistoryOpen(false)}
          footer={<Button onClick={() => setHistoryOpen(false)} style={{ width: '100%' }}>Close</Button>}
        >
          <p className="dim small" style={{ marginTop: 0 }}>
            Placed from this phone today. Tap one to see where it has got to.
          </p>
          {mine.map((o) => (
            <button
              key={o.id}
              className="my-order"
              onClick={() => {
                setHistoryOpen(false);
                showOrderInAddress(o.id);
                setViewing(o.id);
              }}
            >
              <span style={{ fontWeight: 600 }}>{o.no ? `Order ${o.no}` : 'Your order'}</span>
              <span className="dim small">
                {new Date(o.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
            </button>
          ))}
        </Modal>
      )}

      {helpOpen && (
        <HelpModal
          articles={guestHelp}
          areas={HELP_AREAS}
          title="How this works"
          onClose={() => setHelpOpen(false)}
        />
      )}

      {inGroupMode && (
        <div className="banner banner-info">
          <strong>Ordering for a group.</strong> Set meals and platters, with one bill. We'll ask for your booking
          reference so the kitchen and the front desk can find you.
        </div>
      )}

      {!venueOpen && (
        <div className={canOrderNow ? 'banner' : 'banner banner-info'}>
          {canOrderNow ? (
            <>
              <strong>We're closed right now.</strong> You can still order — pick a time when we're open and we'll have
              it ready.
              {nextAvailable(venueHours) && (
                <> Next open {nextAvailable(venueHours)!.toLocaleString([], { weekday: 'long', hour: '2-digit', minute: '2-digit' })}.</>
              )}
            </>
          ) : (
            <>
              <strong>We're closed.</strong> {venueHours ? describeWindows(venueHours) : ''} Please come back during
              opening hours.
            </>
          )}
        </div>
      )}

      <nav className="cat-nav">
        {sections.map((s) => (
          <button
            key={s.category.$id}
            data-cat={s.category.$id}
            className={`${activeSection === s.category.$id ? 'on' : ''} ${s.open ? '' : 'shut'}`}
            onClick={() => {
              // Held for the length of the smooth scroll. Everything the page
              // flies past on the way would otherwise claim the highlight in
              // turn, and the tab you tapped would light up last.
              jumping.current = Date.now() + 900;
              setActiveSection(s.category.$id);
              document.getElementById(`sec-${s.category.$id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }}
          >
            {s.category.name}
          </button>
        ))}
      </nav>

      {sections.map((section) => (
        <Section
          key={section.category.$id}
          section={section}
          settings={settings}
          onPick={(id) => setOpenDish(id)}
        />
      ))}

      {sections.length === 0 && (
        <div style={{ padding: '2rem 1rem' }}>
          <Notice tone="warn">
            {inGroupMode
              ? 'No group menu has been set up yet. Ask an admin to mark a category as group-only.'
              : 'The menu is not ready yet. Please ask a member of staff.'}
          </Notice>
        </div>
      )}

      {cart.length > 0 && totals && (
        <div className="cart-bar">
          <Button variant="primary" onClick={() => setShowCart(true)}>
            View order · {cart.reduce((n, l) => n + l.qty, 0)} item
            {cart.reduce((n, l) => n + l.qty, 0) === 1 ? '' : 's'} · {formatMoney(totals.total, settings)}
          </Button>
        </div>
      )}

      {dish && (
        <DishSheet
          entry={dish}
          settings={settings}
          onClose={() => setOpenDish(null)}
          onAdd={addLine}
        />
      )}

      {showCart && (
        <CartSheet
          cart={cart}
          setCart={setCart}
          settings={settings}
          venue={venue}
          table={table}
          seating={seating}
          groupMode={inGroupMode}
          features={features}
          venueOpen={venueOpen}
          menu={menu}
          onClose={() => setShowCart(false)}
          onPlaced={(orderNo, orderId) => {
            setShowCart(false);
            rememberOrder({ id: orderId, no: orderNo, at: new Date().toISOString(), venueId: venue.$id });
            setMine(myOrders());
            showOrderInAddress(orderId);
            setViewing(orderId);
          }}
          onError={(m) => toast(m, 'err')}
        />
      )}
    </div>
  );
}

function Section({
  section,
  settings,
  onPick,
}: {
  section: MenuSection;
  settings: Settings;
  onPick: (id: string) => void;
}) {
  const windows = parseWindows(section.category.availability);
  const next = section.open ? null : nextAvailable(windows);

  return (
    <section className="section" id={`sec-${section.category.$id}`}>
      <h2>{section.category.name}</h2>
      {section.category.description && <div className="when">{section.category.description}</div>}
      {!section.open && (
        <div className="when">
          Not available right now
          {next && ` — from ${next.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`}
        </div>
      )}
      {section.entries.map((entry) => {
        const img = previewUrl(entry.item.image_id, 'menu', settings, 160, 160);
        const unavailable = !section.open || entry.soldOut;
        return (
          <button
            key={entry.item.$id}
            className="dish"
            disabled={unavailable}
            onClick={() => onPick(entry.item.$id)}
          >
            <div className="body">
              <div className="name">{entry.item.name}</div>
              {entry.item.description && <div className="desc">{entry.item.description}</div>}
              <div className="price">
                {formatMoney(entry.price, settings)}
                {entry.soldOut && <span className="dim"> · sold out</span>}
              </div>
            </div>
            {img ? <img src={img} alt="" /> : <div className="noimg" />}
          </button>
        );
      })}
    </section>
  );
}
