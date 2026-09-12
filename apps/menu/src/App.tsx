import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Modal, Spinner, Notice, useToast, Logo, HelpModal, OfflineBar, StaleBar, useOfflineQueue } from '@snpos/ui';
import { applyTheme } from '@snpos/ui';
import {
  ensureGuestSession, db, DB_ID, Query, listAll, loadMenu, visibleSections, computeTotals, selfOrderModule,
  formatMoney, isAvailable, parseWindows, nextAvailable, describeWindows, loadFeatures, isEnabled,
  articlesFor, HELP_AREAS,
  featureConfig, previewUrl, humanError,
  onQueueChange, startOfflineSync, flushQueue, loadWithFallback, screenShouldReset, screenClaim,
  bookingTotals, dietChips, matchesDiet, parseOmissions, dietaryLabels, couldBeWords,
  needsChoosing, defaultPicks, longDayWords, timeWords,
} from '@snpos/core';
import type {
  Settings, Venue, LoadedMenu, MenuSection, MenuEntry, CartLine, FeatureMap, Doc, GroupMeal,
} from '@snpos/core';
import { DishSheet } from './DishSheet';
import { DietTags } from './DietTags';
import { CartSheet } from './CartSheet';
import { GroupSheet } from './GroupSheet';
import { GroupDays } from './GroupDays';
import { BasketPanel } from './BasketPanel';
import { OrderStatus } from './OrderStatus';
import { ScreenThanks } from './ScreenThanks';
import { ScreenAttract } from './ScreenAttract';
import { useWakeLock } from './useWakeLock';
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

/**
 * The mark that says this device is one of the restaurant's own screens.
 *
 * Per browser, not per address. See the note where it is read.
 */
const SCREEN_DEVICE_KEY = 'snpos-screen';

/**
 * Which venue's counter this screen is standing on.
 *
 * Kept beside the flag above because the two are learnt at the same moment and
 * lost at the same moment. A screen launched from its home-screen icon arrives
 * with no token — see the note on `start_url` in sync-sw.mjs — and a business
 * with more than one venue would otherwise land its counter screen on
 * whichever venue happened to be first in the list.
 */
const SCREEN_VENUE_KEY = 'snpos-screen-venue';

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
   * Kept apart from `error` on purpose. Nothing has gone wrong, the sticker
   * worked, the shop simply sells over a counter, and a page headed "Sorry"
   * would send somebody looking for a member of staff to report a fault.
   */
  const [counterOnly, setCounterOnly] = useState<string | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  /*
    A group booking is a basket per MEAL, not one basket and not one a day.

    A party staying four nights eats eight times, and lunch and dinner on the
    same Tuesday are two sittings cooked hours apart. Held here rather than
    inside the booking sheet because the MENU has to know which sitting a dish
    is being added to: the sheet is where the booking is read back, and by
    then it is too late to ask.
  */
  /**
   * The diet a guest has filtered to, or none.
   *
   * Not remembered between visits. A shared counter tablet is everybody, and
   * the next person to pick it up should be looking at the whole menu rather
   * than at somebody else's restriction with no obvious way back.
   */
  const [diet, setDiet] = useState('');
  const [groupMeals, setGroupMeals] = useState<GroupMeal[]>([]);
  const [activeMeal, setActiveMeal] = useState<string | null>(null);
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
  /**
   * This device is a screen the restaurant owns, not a customer's phone.
   *
   * Set only once the token has been matched against the venue, so a guessed
   * or stale address gets the ordinary walk-in menu rather than a mode it was
   * not given.
   */
  const [screenMode, setScreenMode] = useState(() => {
    /*
      REMEMBERED ON THIS DEVICE, not read from the address every time.

      A counter screen is a fixed thing: set up once, switched on every morning,
      never typed into again. The address is the fragile part — a bookmark
      saved without the query string, a browser restoring a tab, a home-screen
      shortcut made from the wrong page, somebody tapping the venue's own link
      to check something. Any of those quietly turns the display back into an
      ordinary phone menu, which does not stay awake, has no invitation on it,
      and follows an order to a status page and sits there.

      None of that announces itself. So once a screen token has been matched
      against the venue, this device knows what it is until somebody says
      otherwise. See `screenMode=off` below for the way out.
    */
    try {
      return window.localStorage.getItem(SCREEN_DEVICE_KEY) === '1';
    } catch {
      return false;
    }
  });
  /*
    A screen at rest.

    The display spends almost all day showing nobody anything, and a menu left
    sitting there reads as somebody else's half-finished order — there is
    nothing on it saying it is for you, or that it is for ordering at all. So
    between customers it shows the invitation instead, and the menu opens on a
    touch.

    Starts true, so a screen switched on in the morning is already inviting
    rather than waiting to be reset by a member of staff.
  */
  const [attract, setAttract] = useState(true);

  /*
    A counter screen stays awake; a phone is left alone.

    A tablet that dims and sleeps is a screen nobody walks up to — worse than
    useless, because it reads as broken or switched off and people go and queue
    instead. Holding a CUSTOMER's phone awake would flatten a battery they need
    for the rest of their evening to solve a problem they do not have.
  */
  useWakeLock(screenMode);

  /** The order just sent, while the thank-you is up. */
  const [thanks, setThanks] = useState<
    { no: string; eta?: number; emailed: boolean; fromOpening?: boolean; doors?: number } | null
  >(null);

  /*
    A screen clears itself between customers.

    Everything left on a shared display belongs to the last person who stood
    at it: a basket half filled, the menu scrolled to the puddings, an order
    already sent. The next person should walk up to the invitation and nothing
    else. Two minutes of nobody touching it — see screenShouldReset, which is
    deliberately generous, because this throws work away rather than dimming a
    panel, and a customer reading an allergen label must not look up to find
    their order gone.

    The address is wiped with it. `#order/...` survives a reload, so a screen
    that ever showed one carried it into the next morning.
  */
  const lastTouched = useRef(Date.now());
  useEffect(() => {
    if (!screenMode) return undefined;
    const touched = () => { lastTouched.current = Date.now(); };
    const events = ['pointerdown', 'keydown', 'touchstart', 'wheel'] as const;
    for (const e of events) window.addEventListener(e, touched, { passive: true });

    const timer = window.setInterval(() => {
      // Never over a sheet that is sending. See screenShouldReset.
      if (!screenShouldReset({ lastTouchedAt: lastTouched.current }, Date.now())) return;
      // Already back at the invitation with nothing to clear: leave it alone
      // rather than re-rendering the same screen every ten seconds all day.
      if (attract && cart.length === 0 && !thanks && !viewing) return;
      setCart([]);
      setThanks(null);
      setShowCart(false);
      setOpenDish(null);
      showOrderInAddress(null);
      setViewing(null);
      setAttract(true);
    }, 10_000);

    return () => {
      for (const e of events) window.removeEventListener(e, touched);
      window.clearInterval(timer);
    };
  }, [screenMode, attract, cart.length, thanks, viewing]);

  /*
    And the address is cleared the moment a screen recognises itself.

    Not only on the timer above: a display that was showing an order when it
    was last switched off would otherwise come back to it, sit behind the
    invitation, and hand it to whoever tapped first.
  */
  useEffect(() => {
    if (screenMode && viewing) {
      showOrderInAddress(null);
      setViewing(null);
    }
  }, [screenMode, viewing]);

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
   * dining room to read. The link goes to whoever books groups, a front desk,
   * an events contact, and nobody else has a way in.
   */
  const groupToken = params.get('g');
  /**
   * A screen that stays put and serves one customer after another.
   *
   * Read here rather than looked up, because everything else about this mode
   * is a matter of what happens AFTER an order is sent. The menu itself, the
   * prices and the ordering are the walk-in's, unchanged.
   */
  const screenToken = params.get('s');
  /**
   * An address saying outright that this device is a counter screen.
   *
   * This is what the home-screen icon opens, because "add to home screen"
   * throws the token away and starts the app at the manifest's address
   * instead. See the note on `start_url` in sync-sw.mjs for why an installed
   * menu is a counter screen by definition.
   *
   * A declaration, not a token, and it deliberately proves nothing. There is
   * nothing here to protect: screen mode only takes things away — the order
   * history, the receipts, the way back to somebody's bill — and holds the
   * display awake. The token still exists and still does its job, which is
   * saying WHICH counter this is.
   */
  const screenDeclared = params.get('screen') === '1';
  /**
   * Opened from an icon rather than in a browser tab.
   *
   * The declaration above only reaches an icon made AFTER it existed, because
   * the address on a shortcut is baked in the moment somebody taps "add to
   * home screen" and cannot be changed from here. Without this, every counter
   * would have to have its icon deleted and made again.
   *
   * Both questions are asked because browsers disagree about which one they
   * answer: `display-mode` is the standard and `navigator.standalone` is what
   * iOS has always used.
   */
  const installed = (() => {
    try {
      const standalone = ['fullscreen', 'standalone', 'minimal-ui'].some(
        (mode) => window.matchMedia(`(display-mode: ${mode})`).matches,
      );
      const ios = (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
      return standalone || ios;
    } catch {
      // An old browser that cannot answer is left alone rather than guessed at.
      return false;
    }
  })();

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
        /*
          The counter this screen was set up on, when the address no longer
          says. A home-screen icon opens with no token at all, so without this
          a two-venue business would find its counter screen quietly serving
          the other branch's menu.
        */
        let rememberedVenue: string | null = null;
        try {
          rememberedVenue = window.localStorage.getItem(SCREEN_VENUE_KEY);
        } catch {
          // A browser refusing storage falls through to the first venue, which
          // is right for the single-venue business that is nearly everybody.
        }

        const venue =
          venues.find((v) => v.$id === table?.venue_id) ??
          (walkInToken ? venues.find((v) => v.walkin_token === walkInToken) : undefined) ??
          (screenToken ? venues.find((v) => v.screen_token === screenToken) : undefined) ??
          (groupToken ? venues.find((v) => v.group_token === groupToken) : undefined) ??
          (rememberedVenue ? venues.find((v) => v.$id === rememberedVenue) : undefined) ??
          venues[0];
        if (!venue) throw new Error('This restaurant has no venue set up yet.');

        // Only a token that actually matches this venue opens group ordering.
        // A guessed or stale one quietly gets the ordinary menu rather than an
        // error, which tells somebody poking at addresses nothing at all.
        setGroupMode(!!groupToken && venue.group_token === groupToken);
        /*
          A matched token switches this device into screen mode for good; an
          address that says so explicitly switches it back. Anything else —
          most importantly an address with no token at all — leaves whatever
          this device already is, which is the whole point of remembering.
        */
        const verdict = screenClaim({
          tokenMatched: !!screenToken && venue.screen_token === screenToken,
          declared: screenDeclared,
          turnedOff: params.get('screenMode') === 'off',
          installed,
          // A table's QR code, a walk-in link, a group's link: an address that
          // belongs to one particular guest, who must keep their own order.
          guestToken: !!token || !!walkInToken || !!groupToken,
        });
        if (verdict.screen !== null) {
          setScreenMode(verdict.screen);
          try {
            if (verdict.screen) {
              window.localStorage.setItem(SCREEN_DEVICE_KEY, '1');
              if (verdict.rememberVenue) window.localStorage.setItem(SCREEN_VENUE_KEY, venue.$id);
            } else if (verdict.forget) {
              window.localStorage.removeItem(SCREEN_DEVICE_KEY);
              window.localStorage.removeItem(SCREEN_VENUE_KEY);
            }
            /* Otherwise this visit is not a screen and the device's own
               setting is left alone: see `forget` on ScreenVerdict. Somebody
               opening a guest link on the counter tablet has not dismantled
               the counter. */
          } catch {
            // A browser refusing storage means the address has to carry the
            // token every time, which is how this worked before.
          }
        }

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
        // somebody else is already sitting at is still offered, two parties
        // choosing the same table is a smaller problem than a guest who cannot
        // say where they are.
        const seating = allSeating
          .filter((t) => t.active !== false && t.guest_selectable !== false)
          .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.label.localeCompare(b.label));
        setBoot({ settings, venue, table, seating, menu, features });
        // The first section of the menu this guest is actually being shown.
        // Reading it off the whole catalogue could open the page on a heading
        // that is not in the list below it.
        const side = selfOrderModule(settings);
        setActiveSection(
          visibleSections(menu).find((sec) => (sec.category.module ?? 'kitchen') === side)?.category.$id ?? null,
        );
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

  /*
    Group mode, worked out here rather than after the loading guard below.

    addLine reads it to decide which basket a dish goes into, and a const
    declared further down the component is not merely unset at that point, it
    throws. That exact mistake has already cost this app a cart button that
    did nothing; see the note beside `chosenSeat` in CartSheet.
  */
  const inGroupMode = groupMode && isEnabled(boot?.features ?? {}, 'group_orders');

  const addLine = useCallback((line: CartLine) => {
    if (inGroupMode) {
      if (!activeMeal) { toast('Pick a meal first'); return; }
      setGroupMeals((all) => all.map((d) => {
        if (d.key !== activeMeal) return d;
        // Same dish, same options, same day merges rather than stacking.
        const twin = d.lines.find(
          (l) => l.menu_item_id === line.menu_item_id
            && l.notes === line.notes
            && JSON.stringify(l.addons.map((a) => a.option_id).sort())
              === JSON.stringify(line.addons.map((a) => a.option_id).sort()),
        );
        return {
          ...d,
          lines: twin
            ? d.lines.map((l) => (l === twin ? { ...l, qty: l.qty + line.qty } : l))
            : [...d.lines, line],
        };
      }));
      setOpenDish(null);
      toast('Added to that meal');
      return;
    }
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
  }, [toast, inGroupMode, activeMeal]);

  /**
   * One of something, straight from the row, with no sheet in between.
   *
   * Only ever reached for a dish with nothing to decide — Dish sends anything
   * that needs a choice to the sheet instead — so the defaults ARE the order.
   * Options chosen for somebody are still carried, which is what makes a dish
   * with a pre-answered required choice addable at all.
   */
  const quickAdd = useCallback((entry: MenuEntry) => {
    const picks = defaultPicks(entry.groups);
    addLine({
      key: `${entry.item.$id}-${Date.now()}`,
      menu_item_id: entry.item.$id,
      name: entry.item.name,
      unit_price: entry.price,
      qty: 1,
      addons: entry.groups.flatMap(({ group, options }) =>
        (picks[group.$id] ?? []).flatMap((id) => {
          const option = options.find((o) => o.$id === id);
          return option
            ? [{ option_id: option.$id, group_id: group.$id, name: option.name, price_delta: option.price_delta }]
            : [];
        })),
      station: entry.station,
      station_key: entry.stationKey,
    });
  }, [addLine]);

  const totals = useMemo(
    () => (boot ? computeTotals({ lines: cart, settings: boot.settings }) : null),
    [cart, boot],
  );

  /*
    A group used to be offered only the slots the kitchen serves walk-ins in,
    read from the venue's opening hours. That is wrong for a party — the
    booking is an arrangement made with the kitchen weeks ahead, and the
    kitchen opens for it — and it left the form unusable at a venue whose
    hours had never been filled in, with nothing on screen to say why. The
    picker now takes any date and any time between BOOKING_OPENS and
    BOOKING_CLOSES; see GroupDays.
  */
  /* A booking is priced day by day, because each day becomes its own order and
     the sum of the tickets has to be the figure the hotel agreed to. */
  const booking = useMemo(
    () => bookingTotals(
      groupMeals,
      boot?.settings ?? ({} as Settings),
      featureConfig(boot?.features ?? {}, 'group_orders', 'pack_fee', 0),
    ),
    [groupMeals, boot],
  );

  /**
   * Keep the tab bar honest while somebody scrolls.
   *
   * The tabs used to change only when tapped, so a guest who scrolled, which
   * is how anybody actually reads a menu, was told they were still in the
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
    // of them forces the browser to re-lay-out mid-scroll, which is felt as
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
   * current section, which scrolled the page again, a loop that reads, on a
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
  // keeps answering it, and now survives a refresh, because it is in the
  // address rather than only in memory.
  /**
   * A shared screen never opens somebody's order status.
   *
   * The status page follows one order through to collection and stays on it,
   * which is right on the phone of the person who ordered and wrong on a
   * tablet that the next customer will pick up within the minute. On this
   * screen the thank-you IS the confirmation, and it clears itself.
   */
  /*
    Between customers, the invitation rather than the menu.

    Only on a screen, and only when there is nothing in the basket: somebody
    who has started choosing and paused to read a label must not have their
    order swept away, which is exactly what a timed reset would do.

    Ahead of the thank-you check below, because a thank-you sets attract on its
    way out and both being true for one render would flash the menu between
    them.
  */
  if (screenMode && attract && !thanks && cart.length === 0) {
    return (
      <ScreenAttract
        venueName={boot.venue?.name ?? boot.settings.restaurant_name}
        onStart={() => setAttract(false)}
      />
    );
  }

  if (screenMode && thanks) {
    return (
      <ScreenThanks
        orderNo={thanks.no}
        etaMinutes={thanks.eta}
        fromOpening={thanks.fromOpening}
        openingWaitMinutes={thanks.doors}
        emailed={thanks.emailed}
        onDone={() => {
          setThanks(null);
          setCart([]);
          showOrderInAddress(null);
          // Not to the menu: to the invitation. A menu sitting on a counter is
          // what the next customer walks past.
          setAttract(true);
        }}
      />
    );
  }

  /*
    A shared screen never shows an order.

    Two reasons, and either alone would be enough. It is the LAST person's
    order — their food, their name, their money — in front of whoever walks up
    next. And the address survives everything: `#order/...` is still there
    after a reload, so a screen that ever showed one showed it again every
    morning, behind the invitation, waiting for the first customer to tap past
    it and land on a stranger's receipt instead of the menu.
  */
  if (viewing && !screenMode) {
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

  /**
   * One side of the business, never both.
   *
   * A guest who scans a table code is in the dining room, and the shop's
   * baskets and beads were appearing on that menu alongside the food. Worse
   * than untidy: nothing here says which side an order is for, so a basket
   * ordered from a phone became a kitchen ticket, landed on the pass and
   * alarmed a cook about a woven basket nobody can cook.
   */
  const side = selfOrderModule(settings);

  // Two menus, one list. Group-only sections are hidden from the ordinary
  // menu and are the only thing shown on the group one, a hotel party
  // ordering platters does not want the a la carte list, and a walk-in
  // should not be offered a set meal for twenty.
  /*
    A group's menu is not on a timetable either.

    `visibleSections` hides a category outside its serving window and marks
    the rest closed, which greys their dishes out and prints "Not available
    right now" over them. That is right for a walk-in, who can only be served
    what is being cooked now — and wrong for a booking, where the whole point
    is a sitting on another day. A group looking at Tuesday's set menu on a
    Friday would find it greyed out and unaddable with no way to say when they
    meant.

    So the group menu takes every group-only section, whatever the clock says,
    and treats it as open.
  */
  const onSide = inGroupMode
    ? menu.sections
      .filter((sec) => (sec.category.module ?? 'kitchen') === side)
      .filter((sec) => sec.category.group_only)
      .map((sec) => ({ ...sec, open: true }))
    : visibleSections(menu)
      .filter((sec) => (sec.category.module ?? 'kitchen') === side)
      .filter((sec) => !sec.category.group_only);

  /*
    The chips, and what they hide.

    Built from what is actually on this menu, so a chip never leads to an
    empty page. Filtering keeps a dish that IS the diet and one that COULD be
    with something left out; the card says which, so nobody is told a dish is
    vegetarian when what is true is that it can be made so. A section with
    nothing left drops out rather than sitting there empty.
  */
  const chips = dietChips(
    onSide.flatMap((sec) => sec.entries.map((e) => ({
      tags: e.item.tags,
      omissions: parseOmissions(e.item.omissions),
    }))),
  );

  const sections = !diet ? onSide : onSide
    .map((sec) => ({
      ...sec,
      entries: sec.entries.filter((e) => matchesDiet(e.item.tags, parseOmissions(e.item.omissions), diet)),
    }))
    .filter((sec) => sec.entries.length > 0);
  const venueHours = parseWindows(venue.opening_hours);
  const venueOpen = isAvailable(venueHours);
  const preordersOn = isEnabled(features, 'preorders');
  const allowWhenClosed = featureConfig(features, 'preorders', 'allow_when_closed', true);
  const canOrderNow = venueOpen || (preordersOn && allowWhenClosed);

  /* The sitting a tapped dish goes into, which is what the basket beside the
     menu has to show. Null until a meal is chosen. */
  const openMeal = groupMeals.find((m) => m.key === activeMeal) ?? null;

  const dish = openDish ? menu.byId[openDish] : null;
  // Guests get only the chapters written for them, and only if the restaurant
  // wants the link there at all.
  const guestHelp =
    isEnabled(features, 'help') && featureConfig(features, 'help', 'show_on_customer_menu', true)
      ? articlesFor('guest', featureConfig<Record<string, string[]>>(features, 'help', 'audiences', {}))
      : [];

  return (
    <div className="menu-app">
      {/* A guest's phone holding an old copy of the menu orders from old
          prices and cannot see a dish added this morning. It is also the
          likeliest reason a link "does not show the changes". */}
      <StaleBar />
      <OfflineBar queued={queued} onRetry={() => void flushQueue()} />
      <header className="menu-header">
        <div className="row" style={{ justifyContent: 'center', gap: '0.55rem' }}>
          <Logo size={26} />
          <h1 style={{ margin: 0 }}>{venue.name || settings.restaurant_name}</h1>
        </div>
        <div className="sub">
          {/*
            Where the guest IS, not where the order is going.

            A walk-in used to be labelled "Collect at the counter", which is an
            instruction rather than a place, given before anybody has ordered
            anything.

            And nothing at all on a shared screen. "Takeaway" on a tablet fixed
            to a counter tells the person standing at it something they can see
            for themselves, and it is the first line on the page — the most
            valuable line there is, spent saying where they are standing.
            Whether the kitchen is open still matters, so that stays.
          */}
          {screenMode
            ? (venueOpen ? 'Open now' : 'Closed')
            : (
              <>
                {inGroupMode ? 'Group ordering' : table ? `Table ${table.label}` : 'Takeaway'}
                {/* Whether the doors are open this minute is the walk-in's
                    question, not the group's. See the banner below. */}
                {!inGroupMode && (venueOpen ? ' · Open now' : ' · Closed')}
              </>
            )}
          {/* The way back to an order already placed. Only shown when there is
              one, and it is the only route back after a refresh, without it a
              guest who reloads has no way to reach their own order again. */}
          {/* Never on a shared screen. "Your orders" is a list kept on this
              device, and on a counter tablet this device is everybody — it
              would offer each customer the last few strangers' orders, and
              open them. Hidden rather than only stopped from growing, because
              a screen may have been used as a walk-in before it was a screen. */}
          {!screenMode && mine.length > 0 && (
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

      {/*
        A group link whose token this venue does not recognise.

        It used to fall through to the ordinary menu without a word, on the
        reasoning that somebody guessing at addresses should learn nothing.
        That reasoning was worth less than it cost. A token is replaced from
        the Tables page and every link already handed out stops working at
        that moment, so the common holder of an unrecognised token is not an
        attacker but a hotel with last month's link — and both they and the
        restaurant had no way at all to find that out. A guest quietly served
        the à la carte menu orders from it, at the wrong prices, believing
        they are booking a group.

        Somebody guessing learns only that their guess was wrong, which the
        ordinary menu already told them.
      */}
      {groupToken && !groupMode && (
        <div className="banner banner-info">
          <strong>This group ordering link is not recognised.</strong> It may have been replaced with a newer one.
          This is the ordinary menu; please ask whoever sent it for the current link.
        </div>
      )}

      {/*
        A group link that lands on the ordinary menu.

        The token matched this venue, so somebody was given this link on
        purpose, but group ordering is switched off. Without a word here the
        guest simply gets the à la carte menu and nobody can tell whether the
        link is wrong, the feature is off, or the app is broken.
      */}
      {groupMode && !inGroupMode && (
        <div className="banner banner-info">
          <strong>Group ordering is not switched on at the moment.</strong> This is the ordinary menu. Please
          order at the counter, or ask the front desk to turn group ordering on.
        </div>
      )}

      {/* A group staying more than one night books every night at once, so
          the day being ordered for is chosen before the food, not after. */}
      {inGroupMode && (
        <GroupDays
          meals={groupMeals}
          setMeals={setGroupMeals}
          activeKey={activeMeal}
          setActiveKey={setActiveMeal}
        />
      )}

      {/*
        Opening hours say nothing to a group.

        A party books a sitting for a Tuesday three weeks out, agreed with the
        kitchen, which opens for it. Telling them "We're closed right now,
        next open Saturday 13:00" is answering a question they did not ask
        about a day they are not booking, and it reads as a refusal — somebody
        holding a link for a booking in November was being told the doors are
        shut this evening.
      */}
      {!venueOpen && !inGroupMode && (
        <div className={canOrderNow ? 'banner' : 'banner banner-info'}>
          {canOrderNow ? (
            <>
              <strong>We're closed right now.</strong> You can still order, pick a time when we're open and we'll have
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

      {/*
        What a guest can eat, above the categories.

        First thing on the menu after the notices, because somebody with a
        restriction is looking for it before they look at the food. Shown only
        when this menu has something to offer at least one of them, so it
        never appears as a row of dead ends.
      */}
      {chips.length > 0 && (
        <div className="diet-chips" role="group" aria-label="Show dishes for a diet">
          {chips.map((c) => (
            <button
              key={c.key}
              className={diet === c.key ? 'on' : ''}
              aria-pressed={diet === c.key}
              onClick={() => setDiet(diet === c.key ? '' : c.key)}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}
      {diet && (
        <div className="diet-note">
          <span>
            Showing what is {dietaryLabels([diet])[0]?.label.toLowerCase() ?? diet}, and what can be made so.
          </span>
          <Button onClick={() => setDiet('')}>Show everything</Button>
        </div>
      )}

      {/*
        Menu on the left, basket on the right — above a tablet's width.

        Below it the aside is hidden by CSS and the bar at the foot of the
        page takes over, which is the only thing that works in one column.
        Both read the same state, so they cannot disagree. See BasketPanel.
      */}
      <div className="menu-layout">
      <div className="menu-col">
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
          onQuickAdd={quickAdd}
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
      </div>

      {/* On a group booking the panel shows the sitting being filled, which is
          the one a tapped dish is going into. The others are a tab away in the
          sheet, and are named on the strip above the menu. */}
      {inGroupMode ? (
        <BasketPanel
          title="This booking"
          subtitle={openMeal
            ? `${longDayWords(openMeal.at)}, ${timeWords(openMeal.at)}`
            : 'No meal chosen yet'}
          lines={openMeal?.lines ?? []}
          settings={settings}
          total={booking.total}
          totalLabel={`${groupMeals.length} sitting${groupMeals.length === 1 ? '' : 's'}`}
          actionLabel={`See the booking · ${formatMoney(booking.total, settings)}`}
          onAction={() => setShowCart(true)}
          onQty={(lineKey, qty) => setGroupMeals((all) => all.map((m) => (m.key === activeMeal
            ? { ...m, lines: m.lines.map((l) => (l.key === lineKey ? { ...l, qty } : l)).filter((l) => l.qty > 0) }
            : m)))}
          empty={openMeal
            ? 'Nothing on this sitting yet. Tap Add beside a dish.'
            : 'Add a meal above, then choose the food for it.'}
        />
      ) : (
        <BasketPanel
          title="Your order"
          lines={cart}
          settings={settings}
          total={totals?.total ?? 0}
          totalLabel="Total"
          actionLabel="Check the order"
          onAction={() => setShowCart(true)}
          onQty={(lineKey, qty) => setCart((c) => c
            .map((l) => (l.key === lineKey ? { ...l, qty } : l))
            .filter((l) => l.qty > 0))}
          empty="Nothing yet. Tap Add beside a dish."
        />
      )}
      </div>

      {/*
        The phone's basket: a bar across the foot of the page that opens it.

        Hidden above the breakpoint, where the panel beside the menu is the
        basket instead. It says what is in there rather than only what it
        costs — "2 sittings · 16 portions" is the thing somebody checks
        against the guests in front of them, and a figure alone is not.
      */}
      {inGroupMode ? groupMeals.length > 0 && (
        <div className="cart-bar">
          <button type="button" className="cart-bar-btn" onClick={() => setShowCart(true)}>
            <span className="cart-bar-what">
              <strong>See the booking</strong>
              <span className="cart-bar-sub">
                {groupMeals.length} sitting{groupMeals.length === 1 ? '' : 's'} · {booking.portions} portion
                {booking.portions === 1 ? '' : 's'}
              </span>
            </span>
            <span className="cart-bar-money">{formatMoney(booking.total, settings)}</span>
          </button>
        </div>
      ) : cart.length > 0 && totals && (
        <div className="cart-bar">
          <button type="button" className="cart-bar-btn" onClick={() => setShowCart(true)}>
            <span className="cart-bar-what">
              <strong>View your order</strong>
              <span className="cart-bar-sub">
                {cart.reduce((n, l) => n + l.qty, 0)} item
                {cart.reduce((n, l) => n + l.qty, 0) === 1 ? '' : 's'}
              </span>
            </span>
            <span className="cart-bar-money">{formatMoney(totals.total, settings)}</span>
          </button>
        </div>
      )}

      {dish && (
        <DishSheet
          entry={dish}
          settings={settings}
          showDiet
          onClose={() => setOpenDish(null)}
          onAdd={addLine}
        />
      )}

      {showCart && inGroupMode && (
        <GroupSheet
          meals={groupMeals}
          setMeals={setGroupMeals}
          settings={settings}
          venue={venue}
          features={features}
          onClose={() => setShowCart(false)}
          onPlaced={(booked: { id: string; orderNo: string; at: string }[]) => {
            setShowCart(false);
            setActiveMeal(null);
            for (const b of booked) rememberOrder({ id: b.id, no: b.orderNo, at: b.at, venueId: venue.$id });
            toast(`Booking sent: ${booked.length} meal${booked.length === 1 ? '' : 's'}`);
          }}
          onError={(m: string) => toast(m)}
        />
      )}

      {showCart && !inGroupMode && (
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
          onPlaced={(orderNo, orderId, _slot, etaMinutes, emailed, closedWhenPlaced, doorMinutes) => {
            setShowCart(false);
            /**
             * A shared screen keeps no history of who ordered what.
             *
             * "Your orders" is a list on this device, and on a counter tablet
             * this device is everybody. Remembering them would show each
             * customer the last five strangers' orders and offer to open them.
             */
            if (!screenMode) {
              rememberOrder({ id: orderId, no: orderNo, at: new Date().toISOString(), venueId: venue.$id });
              setMine(myOrders());
            }
            if (screenMode) {
              setThanks({
                no: orderNo, eta: etaMinutes, emailed: !!emailed,
                fromOpening: closedWhenPlaced, doors: doorMinutes,
              });
              return;
            }
            showOrderInAddress(orderId);
            setViewing(orderId);
          }}
          onError={(m) => toast(m, 'err')}
        />
      )}
    </div>
  );
}

/**
 * One dish on the menu, with the two things somebody wants from it.
 *
 * The whole row used to be a single button that opened a sheet. That is one
 * tap too many for a hotel ordering twelve of the same wrap — they know what
 * they want and the sheet has nothing to tell them — and at the same time the
 * description was clamped to two lines with no way to read the rest without
 * opening that sheet. So the two jobs are now two buttons, said out loud.
 *
 * Add only adds where there is nothing to decide. A dish sold in sizes, or
 * with a choice the kitchen needs made, opens the sheet instead and the
 * button says so, because adding one of those silently sends the pass a
 * ticket with a hole in it. See needsChoosing.
 */
function Dish({
  entry, settings, unavailable, onOpen, onQuickAdd,
}: {
  entry: MenuEntry;
  settings: Settings;
  unavailable: boolean;
  onOpen: () => void;
  onQuickAdd: (entry: MenuEntry) => void;
}) {
  /*
    The full description, in place.

    Not a measurement of whether the text is actually clamped: that needs the
    element on screen and re-measuring on every resize and font change, and it
    gets the answer wrong on the pass where it matters. The button is offered
    where there is plainly more to read, and closing it again is a tap.
  */
  const [more, setMore] = useState(false);
  const img = previewUrl(entry.item.image_id, 'menu', settings, 160, 160);
  const long = (entry.item.description ?? '').length > 90;
  const decide = needsChoosing(entry.groups, entry.variants ?? []);

  return (
    <div className={`dish${unavailable ? ' dish-off' : ''}`}>
      <div className="body">
        <div className="name">{entry.item.name}</div>
        {entry.item.description && (
          <div className={more ? 'desc desc-all' : 'desc'}>{entry.item.description}</div>
        )}
        {/* Shown on every menu, not only the group one. A guest at a table has
            the same question a hotel booker does, and until now the ordinary
            menu never answered it. */}
        <DietTags
          tags={entry.item.tags}
          couldBe={couldBeWords(entry.item.tags, parseOmissions(entry.item.omissions))}
        />
        <div className="price">
          {formatMoney(entry.price, settings)}
          {entry.soldOut && <span className="dim"> · sold out</span>}
        </div>
        <div className="dish-actions">
          {long && (
            <button type="button" className="linkish" onClick={() => setMore((m) => !m)}>
              {more ? 'View less' : 'View more'}
            </button>
          )}
          <button type="button" className="linkish" onClick={onOpen} disabled={unavailable}>
            {decide ? 'Choose options' : 'Open'}
          </button>
          <Button
            size="sm"
            variant="primary"
            disabled={unavailable}
            onClick={() => (decide ? onOpen() : onQuickAdd(entry))}
          >
            {entry.soldOut ? 'Sold out' : 'Add'}
          </Button>
        </div>
      </div>
      {img ? <img src={img} alt="" /> : <div className="noimg" />}
    </div>
  );
}

function Section({
  section,
  settings,
  onPick,
  onQuickAdd,
}: {
  section: MenuSection;
  settings: Settings;
  onPick: (id: string) => void;
  /** Straight into the basket, for a dish with nothing to decide. */
  onQuickAdd: (entry: MenuEntry) => void;
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
          {next && `, from ${next.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`}
        </div>
      )}
      {section.entries.map((entry) => (
        <Dish
          key={entry.item.$id}
          entry={entry}
          settings={settings}
          unavailable={!section.open || entry.soldOut}
          onOpen={() => onPick(entry.item.$id)}
          onQuickAdd={onQuickAdd}
        />
      ))}
    </section>
  );
}
