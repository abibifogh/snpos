import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Spinner, Notice, useToast, Logo, HelpModal, OfflineBar, useOfflineQueue } from '@snpos/ui';
import { applyTheme } from '@snpos/ui';
import {
  account, db, DB_ID, Query, listAll, loadMenu, visibleSections, computeTotals,
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
  const [cart, setCart] = useState<CartLine[]>([]);
  const [openDish, setOpenDish] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [groupMode, setGroupMode] = useState(false);
  const [showCart, setShowCart] = useState(false);
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const [placed, setPlaced] = useState<{ orderNo: string; orderId: string; scheduled?: string } | null>(null);
  const queued = useOfflineQueue(onQueueChange, startOfflineSync);

  // Two kinds of QR: /?t=<token> is a specific table, /?v=<token> is a walk-in
  // code that belongs to the venue rather than to anywhere to sit.
  const params = new URLSearchParams(window.location.search);
  const token = params.get('t');
  const walkInToken = params.get('v');

  useEffect(() => {
    (async () => {
      try {
        // Guests never sign in. An anonymous session is what lets Appwrite
        // accept an order from someone who has only scanned a sticker.
        try {
          await account.get();
        } catch {
          await account.createAnonymousSession();
        }

        const settings = await loadWithFallback('settings', async () =>
          (await db.getDocument(DB_ID, 'settings', 'main')) as unknown as Settings,
        );
        applyTheme(settings);

        const venues = await listAll<Venue>('venues', [Query.equal('active', true)]);
        let table: TableRow | null = null;
        if (token) {
          const found = await db.listDocuments(DB_ID, 'tables', [Query.equal('qr_token', token), Query.limit(1)]);
          table = (found.documents[0] as unknown as TableRow) ?? null;
        }
        const venue =
          venues.find((v) => v.$id === table?.venue_id) ??
          (walkInToken ? venues.find((v) => v.walkin_token === walkInToken) : undefined) ??
          venues[0];
        if (!venue) throw new Error('This restaurant has no venue set up yet.');

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
  }, [token, walkInToken]);

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
  // keeps answering it.
  if (placed) {
    return (
      <OrderStatus
        orderId={placed.orderId}
        settings={boot.settings}
        venue={boot.venue}
        onBack={() => {
          setPlaced(null);
          setCart([]);
        }}
      />
    );
  }

  const { settings, venue, table, seating, menu, features } = boot;
  const groupOrdersOn = isEnabled(features, 'group_orders');

  // Two menus, one list. Group-only sections are hidden from the ordinary
  // menu and are the only thing shown on the group one — a hotel party
  // ordering platters does not want the a la carte list, and a walk-in
  // should not be offered a set meal for twenty.
  const sections = visibleSections(menu).filter((sec) =>
    groupMode ? sec.category.group_only : !sec.category.group_only,
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
          {table ? `Table ${table.label}` : walkInToken ? 'Collect at the counter' : 'Takeaway'}
          {venueOpen ? ' · Open now' : ' · Closed'}
          {guestHelp.length > 0 && (
            <>
              {' · '}
              <button className="linkish" onClick={() => setHelpOpen(true)}>How this works</button>
            </>
          )}
        </div>
      </header>

      {helpOpen && (
        <HelpModal
          articles={guestHelp}
          areas={HELP_AREAS}
          title="How this works"
          onClose={() => setHelpOpen(false)}
        />
      )}

      {groupOrdersOn && (
        <div className="menu-modes">
          <button className={groupMode ? '' : 'on'} onClick={() => { setGroupMode(false); setCart(() => []); }}>
            Menu
          </button>
          <button className={groupMode ? 'on' : ''} onClick={() => { setGroupMode(true); setCart(() => []); }}>
            Group order
          </button>
        </div>
      )}

      {groupMode && (
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
            className={`${activeSection === s.category.$id ? 'on' : ''} ${s.open ? '' : 'shut'}`}
            onClick={() => {
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
          <Notice tone="warn">The menu is not ready yet. Please ask a member of staff.</Notice>
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
          groupMode={groupMode}
          features={features}
          venueOpen={venueOpen}
          menu={menu}
          onClose={() => setShowCart(false)}
          onPlaced={(orderNo, orderId, scheduled) => {
            setShowCart(false);
            setPlaced({ orderNo, orderId, scheduled });
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
