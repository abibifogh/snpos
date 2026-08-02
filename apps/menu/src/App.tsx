import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Spinner, Notice, useToast } from '@snpos/ui';
import { applyTheme } from '@snpos/ui';
import {
  account, db, DB_ID, Query, listAll, loadMenu, visibleSections, computeTotals,
  formatMoney, isAvailable, parseWindows, nextAvailable, describeWindows, loadFeatures, isEnabled,
  featureConfig, previewUrl,
} from '@snpos/core';
import type {
  Settings, Venue, LoadedMenu, MenuSection, CartLine, FeatureMap, Doc,
} from '@snpos/core';
import { DishSheet } from './DishSheet';
import { CartSheet } from './CartSheet';

interface TableRow extends Doc { venue_id: string; label: string; qr_token: string; active: boolean }

/** Everything the menu needs before it can render a single dish. */
interface Boot {
  settings: Settings;
  venue: Venue;
  table: TableRow | null;
  menu: LoadedMenu;
  features: FeatureMap;
}

const humanError = (e: unknown) => {
  const m = e instanceof Error ? e.message : String(e);
  if (/Network|fetch failed|Failed to fetch/i.test(m)) return 'Could not reach the restaurant. Check your connection.';
  return m;
};

export function App() {
  const toast = useToast();
  const [boot, setBoot] = useState<Boot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [openDish, setOpenDish] = useState<string | null>(null);
  const [showCart, setShowCart] = useState(false);
  const [activeSection, setActiveSection] = useState<string | null>(null);
  const [placed, setPlaced] = useState<{ orderNo: string; scheduled?: string } | null>(null);

  // The table token comes from the QR code: /?t=<token>
  const token = new URLSearchParams(window.location.search).get('t');

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

        const settings = (await db.getDocument(DB_ID, 'settings', 'main')) as unknown as Settings;
        applyTheme(settings);

        const venues = await listAll<Venue>('venues', [Query.equal('active', true)]);
        let table: TableRow | null = null;
        if (token) {
          const found = await db.listDocuments(DB_ID, 'tables', [Query.equal('qr_token', token), Query.limit(1)]);
          table = (found.documents[0] as unknown as TableRow) ?? null;
        }
        const venue = venues.find((v) => v.$id === table?.venue_id) ?? venues[0];
        if (!venue) throw new Error('This restaurant has no venue set up yet.');

        const [menu, features] = await Promise.all([loadMenu(venue.$id), loadFeatures(venue.$id)]);
        setBoot({ settings, venue, table, menu, features });
        setActiveSection(visibleSections(menu)[0]?.category.$id ?? null);
      } catch (e) {
        setError(humanError(e));
      }
    })();
  }, [token]);

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

  if (placed) {
    return (
      <div className="centered">
        <div>
          <h1 style={{ marginBottom: '0.6rem' }}>Order {placed.orderNo}</h1>
          <p style={{ fontSize: '1.05rem' }}>
            {placed.scheduled
              ? `Booked for ${new Date(placed.scheduled).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}.`
              : 'Sent to the kitchen.'}
          </p>
          <p className="dim small" style={{ marginTop: '0.8rem' }}>
            {placed.scheduled
              ? 'We will start cooking in time for your slot. Pay when you collect.'
              : 'Your server will bring it over. Pay at the end of your meal.'}
          </p>
          <Button
            style={{ marginTop: '1.5rem' }}
            onClick={() => {
              setPlaced(null);
              setCart([]);
            }}
          >
            Order something else
          </Button>
        </div>
      </div>
    );
  }

  const { settings, venue, table, menu, features } = boot;
  const sections = visibleSections(menu);
  const venueHours = parseWindows(venue.opening_hours);
  const venueOpen = isAvailable(venueHours);
  const preordersOn = isEnabled(features, 'preorders');
  const allowWhenClosed = featureConfig(features, 'preorders', 'allow_when_closed', true);
  const canOrderNow = venueOpen || (preordersOn && allowWhenClosed);

  const dish = openDish ? menu.byId[openDish] : null;

  return (
    <div className="menu-app">
      <header className="menu-header">
        <h1>{venue.name || settings.restaurant_name}</h1>
        <div className="sub">
          {table ? `Table ${table.label}` : 'Takeaway'}
          {venueOpen ? ' · Open now' : ' · Closed'}
        </div>
      </header>

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
          features={features}
          venueOpen={venueOpen}
          menu={menu}
          onClose={() => setShowCart(false)}
          onPlaced={(orderNo, scheduled) => {
            setShowCart(false);
            setPlaced({ orderNo, scheduled });
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
