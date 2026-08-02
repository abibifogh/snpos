import { useCallback, useEffect, useState } from 'react';
import { Button, Spinner, Card, Field, Input, Notice, useToast, Logo, HelpModal, EightySixModal } from '@snpos/ui';
import { applyTheme } from '@snpos/ui';
import {
  account, db, DB_ID, Query, listAll, loadMenu, loadFeatures, humanError, isEnabled,
  articlesFor, featureConfig, HELP_AREAS,
  markUnavailable, markAvailable, isUnavailable, loadMenu as reloadMenu,
} from '@snpos/core';
import type { Settings, Venue, LoadedMenu, FeatureMap, StaffProfile, HelpRole, Doc } from '@snpos/core';
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

export interface PosContext {
  settings: Settings;
  venue: Venue;
  menu: LoadedMenu;
  features: FeatureMap;
  profile: StaffProfile | null;
  userId: string;
  shift: Shift | null;
  reloadShift: () => Promise<void>;
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
  const [tab, setTab] = useState<'tables' | 'takeaway' | 'kitchen'>('tables');
  const [helpOpen, setHelpOpen] = useState(false);
  const [offOpen, setOffOpen] = useState(false);
  const [offBusy, setOffBusy] = useState<string | null>(null);

  const loadShift = useCallback(async (venueId: string): Promise<Shift | null> => {
    const res = await db.listDocuments(DB_ID, 'shifts', [
      Query.equal('venue_id', venueId),
      Query.equal('status', 'open'),
      Query.limit(1),
    ]);
    return (res.documents[0] as unknown as Shift) ?? null;
  }, []);

  const boot = useCallback(async () => {
    const me = await account.get();
    const settings = (await db.getDocument(DB_ID, 'settings', 'main')) as unknown as Settings;
    applyTheme(settings);

    const venues = await listAll<Venue>('venues', [Query.equal('active', true)]);
    const venue = venues[0];
    if (!venue) throw new Error('No venue is set up yet. Add one in the admin app.');

    const [menu, features, profiles, shift] = await Promise.all([
      loadMenu(venue.$id),
      loadFeatures(venue.$id),
      db.listDocuments(DB_ID, 'staff_profiles', [Query.equal('user_id', me.$id), Query.limit(1)]),
      loadShift(venue.$id),
    ]);

    setCtx({
      settings,
      venue,
      menu,
      features,
      profile: (profiles.documents[0] as unknown as StaffProfile) ?? null,
      userId: me.$id,
      shift,
      reloadShift: async () => {
        const s = await loadShift(venue.$id);
        setCtx((c) => (c ? { ...c, shift: s } : c));
      },
    });
  }, [loadShift]);

  useEffect(() => {
    (async () => {
      try {
        await account.get();
        setSignedIn(true);
        await boot();
      } catch {
        setSignedIn(false);
      }
    })().catch((e) => setError(humanError(e)));
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
      <div className="pos-top">
        <div className="row">
          <Logo size={26} />
          <div>
            <strong>{ctx.venue.name}</strong>
            <div className="who">{ctx.profile?.display_name ?? 'Staff'} · {ctx.profile?.role ?? 'no profile'}</div>
          </div>
        </div>
        <div className="pos-tabs">
          <button className={tab === 'tables' ? 'on' : ''} onClick={() => setTab('tables')}>Tables</button>
          <button className={tab === 'takeaway' ? 'on' : ''} onClick={() => setTab('takeaway')}>Takeaway</button>
          {isEnabled(ctx.features, 'combined_mode') && (
            <button className={tab === 'kitchen' ? 'on' : ''} onClick={() => setTab('kitchen')}>Kitchen</button>
          )}
        </div>
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
          items={Object.values(ctx.menu.byId).map((e) => ({
            $id: e.item.$id,
            name: e.item.name,
            off: isUnavailable(e.item),
            offSince: e.item.unavailable_since,
            reason: e.item.unavailable_reason,
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
        {tab === 'tables' ? (
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
