import { useCallback, useEffect, useState } from 'react';
import {
  Button, Spinner, Card, Field, Input, Notice, useToast, Logo, HelpModal, EightySixModal,
  OfflineBar, useOfflineQueue, IdleScreen,
} from '@snpos/ui';
import { applyTheme } from '@snpos/ui';
import {
  account, db, DB_ID, Query, listAll, loadMenu, loadFeatures, humanError, isEnabled,
  articlesFor, featureConfig, HELP_AREAS,
  markUnavailable, markAvailable, isUnavailable, loadMenu as reloadMenu, itemsAvailableNow,
  requireStaff, signOutCompletely, staffProfileFor, loadOpenShifts, modulesForStaff, MODULE_LABELS,
  onQueueChange, startOfflineSync, flushQueue,
} from '@snpos/core';
import type { Settings, Venue, LoadedMenu, FeatureMap, StaffProfile, HelpRole, Doc, Module } from '@snpos/core';
import { TablesView } from './TablesView';
import { OrderView } from './OrderView';
import { ShiftBar, type Shift } from './ShiftBar';
import { KitchenPanel } from './KitchenPanel';

export interface TableRow extends Doc {
  venue_id: string;
  label: string;
  zone?: string;
  seats: number;
  status: 'free' | 'seated' | 'ordered' | 'bill_requested' | 'dirty';
  current_order_id?: string;
  active: boolean;
  sort: number;
}

/**
 * The counter, standing in for a table.
 *
 * A shop sale is not tied to anywhere somebody is sitting, but the bill screen
 * is written around a table and rewriting it for the sake of one field would be
 * two versions of the till drifting apart. So the counter is a table with no
 * seats, exactly as takeaway already was.
 *
 * Its own id, not "takeaway". Sharing one with the restaurant meant a craft
 * till and a takeaway counter were the same place as far as every query was
 * concerned, so unpaid orders from one would surface on the other's bill.
 */
export const COUNTER_TABLE_ID = 'shop-counter';

/**
 * The bar's own counter, and NOT the shop's.
 *
 * The same trap the shop counter already fell into: two tills sharing one
 * table id are the same place as far as every query is concerned, so a drink
 * left unpaid at the bar would surface on the craft counter's bill. A bar and
 * a shop counter are both "no seats", and that is the only thing they have in
 * common.
 */
export const BAR_COUNTER_TABLE_ID = 'bar-counter';

const COUNTER: TableRow = {
  $id: COUNTER_TABLE_ID,
  $createdAt: '',
  $updatedAt: '',
  venue_id: '',
  label: 'Counter',
  seats: 0,
  status: 'free',
  active: true,
  sort: 0,
};

const BAR_COUNTER: TableRow = { ...COUNTER, $id: BAR_COUNTER_TABLE_ID, label: 'The bar' };

export interface PosContext {
  settings: Settings;
  venue: Venue;
  menu: LoadedMenu;
  features: FeatureMap;
  profile: StaffProfile | null;
  userId: string;
  shift: Shift | null;
  /**
   * Other shifts open on this side. Should be none.
   *
   * Only the newest was ever fetched, so any others were invisible: closing
   * the one on screen put the next one there, and every close looked like it
   * had failed when all of them had worked.
   */
  alsoOpen: Shift[];
  reloadShift: () => Promise<void>;
  /** Say what the shift is now, without going back to the database. */
  setShift: (shift: Shift | null) => void;
  /** Which side of the business this till is selling for. */
  module: Module;
  /** Both sides running and this person works on both, so the till can switch. */
  canSwitch: boolean;
  setModule: (m: Module) => void;
}

export function App() {
  const toast = useToast();
  const [ctx, setCtx] = useState<PosContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [openTable, setOpenTable] = useState<TableRow | null>(null);
  const queued = useOfflineQueue(onQueueChange, startOfflineSync);
  const [tab, setTab] = useState<'tables' | 'takeaway' | 'kitchen' | 'counter'>('tables');
  const [helpOpen, setHelpOpen] = useState(false);
  const [offOpen, setOffOpen] = useState(false);
  const [offBusy, setOffBusy] = useState<string | null>(null);

  // Each side of the business has its own open shift, so this asks for one
  // rather than for whichever happened to be first.
  const loadShift = useCallback(
    (venueId: string, module: Module = 'kitchen') => loadOpenShifts(venueId, module),
    [],
  );

  const boot = useCallback(async () => {
    // A customer session is not a staff session. The menu signs guests in
    // anonymously, so "signed in" on its own means nothing here.
    const me = await requireStaff();
    const settings = (await db.getDocument(DB_ID, 'settings', 'main')) as unknown as Settings;
    applyTheme(settings);

    const venues = await listAll<Venue>('venues', [Query.equal('active', true)]);
    const venue = venues[0];
    if (!venue) throw new Error('No venue is set up yet. Add one in the admin app.');

    const [menu, features, profile] = await Promise.all([
      loadMenu(venue.$id),
      loadFeatures(venue.$id),
      staffProfileFor(me),
    ]);

    /**
     * Which side this till is selling for.
     *
     * From the person, not from a setting: somebody who only works the craft
     * counter should find the till already showing baskets rather than having
     * to pick the shop out of a menu at the start of every shift. Where they
     * work both and the business runs both, the till remembers the last choice
     * on this device; one tap, once, on the device that stays where it is.
     */
    const mine = modulesForStaff(profile, settings);
    const theirs: Module[] = (['kitchen', 'bar', 'craft'] as Module[]).filter((m) => mine[m]);
    const canSwitch = theirs.length > 1;
    const remembered = localStorage.getItem('snpos.till.module') as Module | null;
    const startingModule: Module = canSwitch
      ? (remembered && theirs.includes(remembered) ? remembered : theirs[0])
      : theirs[0] ?? 'kitchen';

    // The bar opens standing at the bar; everything else opens on its tables.
    if (startingModule === 'bar') setTab('counter');

    const open = await loadShift(venue.$id, startingModule);

    setCtx({
      settings,
      venue,
      menu,
      features,
      profile,
      userId: me.userId,
      shift: open[0] ?? null,
      alsoOpen: open.slice(1),
      module: startingModule,
      canSwitch,
      setModule: (m) => {
        localStorage.setItem('snpos.till.module', m);
        setCtx((c) => (c ? { ...c, module: m } : c));
        // Land on the tab that side opens on, rather than carrying the last
        // one across. A bar switched to from the kitchen would otherwise open
        // on Tables, and "Takeaway" is not a tab a bar has at all — leaving it
        // selected showed a screen with nothing on it.
        setTab(m === 'bar' ? 'counter' : 'tables');
        // The other side has its own open shift, so switching has to go and
        // find it. Showing the kitchen's shift on the craft till would put the
        // day's takings under the wrong roof.
        void loadShift(venue.$id, m).then((open) =>
          setCtx((c) => (c ? { ...c, shift: open[0] ?? null, alsoOpen: open.slice(1) } : c)));
      },
      // Said directly, rather than discovered by asking again.
      //
      // A shift that has just closed IS closed, and the screen should say so
      // whether or not the next read succeeds. Leaving it to reloadShift meant
      // one failed query left a closed shift on screen with its overdue
      // warning still up, and nothing anywhere to explain why.
      setShift: (s) => setCtx((c) => (c ? { ...c, shift: s } : c)),
      reloadShift: async () => {
        // Whichever side the till is on NOW, not the one it booted on. Reading
        // the captured value meant that after switching counters, opening a
        // shift reloaded the other side's and the new one looked like it had
        // not saved.
        setCtx((c) => {
          if (!c) return c;
          void loadShift(venue.$id, c.module).then((open) =>
            setCtx((x) => (x ? { ...x, shift: open[0] ?? null, alsoOpen: open.slice(1) } : x)));
          return c;
        });
      },
    });
  }, [loadShift]);

  useEffect(() => {
    (async () => {
      try {
        await boot();
        setSignedIn(true);
      } catch (e) {
        // A guest session reaching this page is signed in, just not as staff.
        // Clear it so the sign-in form is not fighting an invisible session.
        if (e instanceof Error && e.name === 'NotStaffError') {
          await signOutCompletely();
          setError(e.message);
        }
        setSignedIn(false);
      }
    })();
  }, [boot]);

  const signIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await account.createEmailPasswordSession(email.trim(), password);
      setSignedIn(true);
      await boot();
    } catch (err) {
      setError(humanError(err));
    } finally {
      setBusy(false);
    }
  };

  if (signedIn === null) return <div className="pos" style={{ display: 'grid', placeItems: 'center' }}><Spinner /></div>;

  if (!signedIn) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: '1.5rem' }}>
        <div style={{ width: '100%', maxWidth: 380 }}>
          <div style={{ display: 'grid', placeItems: 'center', marginBottom: '1rem' }}>
            <Logo size={52} />
          </div>
          <Card title="Terminal sign in">
            <form onSubmit={signIn}>
              <Field label="Email">
                <Input type="email" value={email} autoFocus required onChange={(e) => setEmail(e.target.value)} />
              </Field>
              <Field label="Password">
                <Input type="password" value={password} required onChange={(e) => setPassword(e.target.value)} />
              </Field>
              {error && <div style={{ marginBottom: '1rem' }}><Notice>{error}</Notice></div>}
              <Button type="submit" variant="primary" loading={busy} style={{ width: '100%' }}>Sign in</Button>
            </form>
          </Card>
          <p className="small dim" style={{ textAlign: 'center', marginTop: '1rem' }}>
            One sign-in per device. Staff identify themselves by PIN for actions that need a name against them.
          </p>
        </div>
      </div>
    );
  }

  if (!ctx) {
    return (
      <div className="pos" style={{ display: 'grid', placeItems: 'center' }}>
        {error ? <Notice>{error}</Notice> : <Spinner />}
      </div>
    );
  }

  if (openTable) {
    return (
      <OrderView
        ctx={ctx}
        table={openTable}
        onBack={() => setOpenTable(null)}
        onToast={(m, tone) => toast(m, tone)}
      />
    );
  }

  return (
    <div className="pos">
      {/* Over everything, and only when the till has been left alone. Not
          while a table is open: a bill on screen with a customer in front of
          it is not an idle till, whatever the clock says. */}
      <IdleScreen
        settings={ctx.settings}
        afterMinutes={ctx.settings.idle_minutes ?? 0}
        hasOpenShift={!!ctx.shift}
        module={ctx.module}
        busy={!!openTable}
      />
      <OfflineBar queued={queued} onRetry={() => void flushQueue()} />
      <div className="pos-top">
        <div className="row">
          <Logo size={26} />
          <div>
            <strong>{ctx.venue.name}</strong>
            <div className="who">{ctx.profile?.display_name ?? 'Staff'} · {ctx.profile?.role ?? 'no profile'}</div>
          </div>
        </div>
        {/* Which counter this till is. Only shown to somebody who works both
            sides in a business that runs both, everyone else is already where
            they belong and a switch would just be a way to end up in the wrong
            books. It sits left of the tabs because it changes what they mean. */}
        {ctx.canSwitch && (
          <div className="pos-tabs pos-side">
            {/* Built from what this person may actually work rather than three
                hard-coded buttons, so a bar-only cashier is never offered a
                shop they cannot sell from. */}
            {(['kitchen', 'bar', 'craft'] as Module[])
              .filter((m) => modulesForStaff(ctx.profile, ctx.settings)[m])
              .map((m) => (
                <button
                  key={m}
                  className={ctx.module === m ? 'on' : ''}
                  onClick={() => ctx.setModule(m)}
                >
                  {MODULE_LABELS[m]}
                </button>
              ))}
          </div>
        )}
        {/* A bar is neither a dining room nor a shop counter.
            Most drinks are ordered and paid for standing at the bar, so that
            is the tab it opens on — but a bar with seating runs tabs against
            a table all night, which a craft counter never does. So it gets
            both, and not the kitchen pass: a drink is poured where it is
            ordered, and there is no window to collect it from. */}
        {ctx.module === 'bar' && (
          <div className="pos-tabs">
            <button className={tab === 'counter' ? 'on' : ''} onClick={() => setTab('counter')}>The bar</button>
            <button className={tab === 'tables' ? 'on' : ''} onClick={() => setTab('tables')}>Tables</button>
          </div>
        )}
        {ctx.module === 'kitchen' && (
          <div className="pos-tabs">
            <button className={tab === 'tables' ? 'on' : ''} onClick={() => setTab('tables')}>Tables</button>
            <button className={tab === 'takeaway' ? 'on' : ''} onClick={() => setTab('takeaway')}>Takeaway</button>
            {isEnabled(ctx.features, 'combined_mode') && (
              <button className={tab === 'kitchen' ? 'on' : ''} onClick={() => setTab('kitchen')}>Kitchen</button>
            )}
          </div>
        )}
        <div className="row">
          {isEnabled(ctx.features, 'item_availability') && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setOffOpen(true)}
              title={
                ctx.module === 'craft' ? 'Mark a product as sold out'
                  : ctx.module === 'bar' ? 'Mark a drink as run out'
                  : 'Mark a dish as run out'
              }
            >
              {ctx.module === 'craft' ? 'Sold out' : 'Run out'}
            </Button>
          )}
          {isEnabled(ctx.features, 'help') && (
            <Button size="sm" variant="ghost" onClick={() => setHelpOpen(true)} title="How this works">
              Help
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => account.deleteSession('current').then(() => location.reload())}>
            Sign out
          </Button>
        </div>
      </div>

      {offOpen && (
        <EightySixModal
          // Its words as well as its catalogue: a shop counter should not be
          // told that the kitchen screen will stop showing a luggage strap.
          module={ctx.module}
          // This side's catalogue only. The shop counter listing every dish in
          // the restaurant meant a cashier could take jollof off the menu from
          // a screen that has never sold food.
          items={itemsAvailableNow(ctx.menu, ctx.module).map((item) => ({
            $id: item.$id,
            name: item.name,
            off: isUnavailable(item),
            offSince: item.unavailable_since,
            reason: item.unavailable_reason,
          }))}
          requireReason={featureConfig(ctx.features, 'item_availability', 'require_reason', false)}
          busyId={offBusy}
          onClose={() => setOffOpen(false)}
          onMarkOff={async (i, reason) => {
            setOffBusy(i.$id);
            try {
              await markUnavailable({
                venueId: ctx.venue.$id,
                // The dish itself, not a copy of two of its fields. The write
                // has to carry a value it is not changing; see `carried`.
                item: itemsAvailableNow(ctx.menu, ctx.module).find((x) => x.$id === i.$id)
                  ?? { $id: i.$id, name: i.name },
                userId: ctx.userId,
                userName: ctx.profile?.display_name,
                shiftId: ctx.shift?.$id,
                reason,
              });
              // Reload so the dish disappears from the ordering screen at once
              //, a waiter who can still tap it will still sell it.
              const fresh = await reloadMenu(ctx.venue.$id);
              setCtx((c) => (c ? { ...c, menu: fresh } : c));
              toast(`${i.name} taken off the menu`);
            } catch (e) {
              toast(humanError(e), 'err');
            } finally {
              setOffBusy(null);
            }
          }}
          onRestore={async (i) => {
            setOffBusy(i.$id);
            try {
              await markAvailable({
                item: itemsAvailableNow(ctx.menu, ctx.module).find((x) => x.$id === i.$id) ?? { $id: i.$id },
                userId: ctx.userId,
              });
              const fresh = await reloadMenu(ctx.venue.$id);
              setCtx((c) => (c ? { ...c, menu: fresh } : c));
              toast(`${i.name} back on the menu`);
            } catch (e) {
              toast(humanError(e), 'err');
            } finally {
              setOffBusy(null);
            }
          }}
        />
      )}

      {helpOpen && (
        <HelpModal
          articles={articlesFor(
            (ctx.profile?.role ?? 'waiter') as HelpRole,
            featureConfig<Record<string, string[]>>(ctx.features, 'help', 'audiences', {}),
          )}
          areas={HELP_AREAS}
          title="How this works"
          onClose={() => setHelpOpen(false)}
        />
      )}

      <ShiftBar ctx={ctx} onToast={(m, tone) => toast(m, tone)} />

      <div className="pos-body">
        {/* A shop counter is not a dining room.
            Tables, takeaway and a kitchen view are three answers to "where is
            this food going", and a woven basket is going into a bag. So the
            craft till opens straight onto the counter sale: pick the pieces,
            take the money, done. */}
        {ctx.module === 'craft' ? (
          <OrderView
            ctx={ctx}
            table={COUNTER}
            onBack={() => undefined}
            onToast={(m, t) => toast(m, t)}
          />
        ) : ctx.module === 'bar' && tab !== 'tables' ? (
          /* Straight onto the bar itself: pour, take the money, next customer.
             Its own counter rather than the shop's — see BAR_COUNTER_TABLE_ID. */
          <OrderView
            ctx={ctx}
            table={BAR_COUNTER}
            onBack={() => undefined}
            onToast={(m, t) => toast(m, t)}
          />
        ) : tab === 'tables' ? (
          <TablesView ctx={ctx} onOpen={setOpenTable} />
        ) : tab === 'takeaway' ? (
          <TakeawayList ctx={ctx} onOpen={setOpenTable} />
        ) : (
          <KitchenPanel ctx={ctx} onToast={(m, t) => toast(m, t)} />
        )}
      </div>
    </div>
  );
}

/** Counter and phone orders, which have no table to sit against. */
function TakeawayList({ ctx, onOpen }: { ctx: PosContext; onOpen: (t: TableRow | null) => void }) {
  return (
    <Card title="Takeaway">
      <p className="small dim" style={{ marginTop: 0 }}>
        Orders taken at the counter or over the phone. They go to the kitchen the same way, but are not tied to a
        table.
      </p>
      <Button
        variant="primary"
        onClick={() =>
          onOpen({
            $id: 'takeaway',
            $createdAt: '',
            $updatedAt: '',
            venue_id: ctx.venue.$id,
            label: 'Takeaway',
            seats: 0,
            status: 'free',
            active: true,
            sort: 0,
          })
        }
      >
        Start a takeaway order
      </Button>
    </Card>
  );
}
