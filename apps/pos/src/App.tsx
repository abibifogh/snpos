import { useCallback, useEffect, useState } from 'react';
import {
  Button, Spinner, Card, Field, Input, Notice, useToast, Logo, HelpModal, EightySixModal,
  OfflineBar, useOfflineQueue,
} from '@snpos/ui';
import { applyTheme } from '@snpos/ui';
import {
  account, db, DB_ID, Query, listAll, loadMenu, loadFeatures, humanError, isEnabled,
  articlesFor, featureConfig, HELP_AREAS,
  markUnavailable, markAvailable, isUnavailable, loadMenu as reloadMenu, itemsAvailableNow,
  requireStaff, signOutCompletely, staffProfileFor, loadOpenShift, modulesForStaff,
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
 */
const COUNTER: TableRow = {
  $id: 'takeaway',
  $createdAt: '',
  $updatedAt: '',
  venue_id: '',
  label: 'Counter',
  seats: 0,
  status: 'free',
  active: true,
  sort: 0,
};

export interface PosContext {
  settings: Settings;
  venue: Venue;
  menu: LoadedMenu;
  features: FeatureMap;
  profile: StaffProfile | null;
  userId: string;
  shift: Shift | null;
  reloadShift: () => Promise<void>;
  /** Which side of the business this till is selling for. */
  module: Module;
  /** Both sides running and this person works on both — so the till can switch. */
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
  const [tab, setTab] = useState<'tables' | 'takeaway' | 'kitchen'>('tables');
  const [helpOpen, setHelpOpen] = useState(false);
  const [offOpen, setOffOpen] = useState(false);
  const [offBusy, setOffBusy] = useState<string | null>(null);

  // Each side of the business has its own open shift, so this asks for one
  // rather than for whichever happened to be first.
  const loadShift = useCallback(
    (venueId: string, module: Module = 'kitchen') => loadOpenShift(venueId, module),
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
     * on this device — one tap, once, on the device that stays where it is.
     */
    const mine = modulesForStaff(profile, settings);
    const canSwitch = mine.kitchen && mine.craft;
    const remembered = localStorage.getItem('snpos.till.module') as Module | null;
    const startingModule: Module = canSwitch
      ? (remembered === 'craft' || remembered === 'kitchen' ? remembered : 'kitchen')
      : mine.craft ? 'craft' : 'kitchen';

    const shift = await loadShift(venue.$id, startingModule);

    setCtx({
      settings,
      venue,
      menu,
      features,
      profile,
      userId: me.userId,
      shift,
      module: startingModule,
      canSwitch,
      setModule: (m) => {
        localStorage.setItem('snpos.till.module', m);
        setCtx((c) => (c ? { ...c, module: m } : c));
        // The other side has its own open shift, so switching has to go and
        // find it. Showing the kitchen's shift on the craft till would put the
        // day's takings under the wrong roof.
        void loadShift(venue.$id, m).then((s) => setCtx((c) => (c ? { ...c, shift: s } : c)));
      },
      reloadShift: async () => {
        const s = await loadShift(venue.$id, startingModule);
        setCtx((c) => (c ? { ...c, shift: s } : c));
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
            sides in a business that runs both — everyone else is already where
            they belong and a switch would just be a way to end up in the wrong
            books. It sits left of the tabs because it changes what they mean. */}
        {ctx.canSwitch && (
          <div className="pos-tabs pos-side">
            <button
              className={ctx.module === 'kitchen' ? 'on' : ''}
              onClick={() => ctx.setModule('kitchen')}
            >
              Kitchen
            </button>
            <button
              className={ctx.module === 'craft' ? 'on' : ''}
              onClick={() => ctx.setModule('craft')}
            >
              Craft shop
            </button>
          </div>
        )}
        {ctx.module !== 'craft' && (
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
            <Button size="sm" variant="ghost" onClick={() => setOffOpen(true)} title="Mark a dish as run out">
              Run out
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
          items={itemsAvailableNow(ctx.menu).map((item) => ({
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
                item: { $id: i.$id, name: i.name },
                userId: ctx.userId,
                userName: ctx.profile?.display_name,
                shiftId: ctx.shift?.$id,
                reason,
              });
              // Reload so the dish disappears from the ordering screen at once
              // — a waiter who can still tap it will still sell it.
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
              await markAvailable({ item: { $id: i.$id }, userId: ctx.userId });
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
