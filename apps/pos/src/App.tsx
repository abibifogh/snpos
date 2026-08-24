import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button, Spinner, Card, Field, Input, Notice, useToast, Logo, HelpModal, EightySixModal,
  OfflineBar, useOfflineQueue, IdleScreen, ThemeButton,
} from '@snpos/ui';
import { applyTheme } from '@snpos/ui';
import {
  account, db, DB_ID, Query, listAll, loadMenu, loadFeatures, humanError, isEnabled,
  articlesFor, featureConfig, HELP_AREAS,
  markUnavailable, markAvailable, isUnavailable, loadMenu as reloadMenu, itemsAvailableNow,
  requireStaff, signOutCompletely, staffProfileFor, loadOpenShifts, modulesForStaff, MODULE_LABELS,
  onQueueChange, startOfflineSync, flushQueue,
  lockKey, lockProblem, subscribeCollection, wakesScreen, latestMovement,
} from '@snpos/core';
import type {
  Settings, Venue, LoadedMenu, FeatureMap, StaffProfile, HelpRole, Doc, Module, Unlocker, Order,
} from '@snpos/core';
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
  /**
   * Who is standing here, when somebody unlocked their way in.
   *
   * What a till may sell follows the person at it, not the account that was
   * signed in this morning. Absent means those are the same person.
   */
  working?: StaffProfile | null;
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

  /**
   * Locked on purpose, and it survives a reload.
   *
   * A lock a refresh clears is a lock anybody clears, because reloading a page
   * is not a skill. So the fact lives on the device rather than in a variable,
   * keyed per venue and per side — two tills in one building are two doors,
   * and locking the bar must not shut the shop counter.
   */
  const lockStore = ctx ? lockKey(ctx.venue.$id, ctx.module) : '';
  const [locked, setLocked] = useState(false);
  /**
   * Everybody who could open it again. Read once; PINs rarely change mid-shift.
   *
   * Whole profiles rather than names and PINs, because whoever opens the door
   * is then the person standing at the till, and what they may work is on
   * their profile. See `working`.
   */
  const [staff, setStaff] = useState<StaffProfile[]>([]);
  /**
   * Who is actually at this till, when that is not who signed into it.
   *
   * A till is signed in once, in the morning, usually by whoever opens up —
   * often a manager or the owner. Everybody else reaches it through the lock
   * screen. Until now the PIN only opened the door: the screen came back with
   * the SIGNED-IN person's reach on it, so a bartender who let themselves in
   * with a bar-only PIN could switch the till to the kitchen or the shop and
   * sell from either.
   *
   * That is the wrong way round. The PIN says who is here; it should decide
   * what this till is for as long as they are. Null until somebody unlocks,
   * which is the ordinary case of the person who signed in still being there.
   */
  const [working, setWorking] = useState<StaffProfile | null>(null);
  /**
   * Who the DEVICE is signed in as, kept apart from who is standing at it.
   *
   * One sign-in per till, done once in the morning by whoever opens up.
   * Everybody else reaches it by PIN, and it is their name that belongs on
   * the work — so this is only what to fall back to when nobody has unlocked.
   */
  const [device, setDevice] = useState<{ profile: StaffProfile | null; userId: string } | null>(null);
  /**
   * The same answer, readable from inside the context built at boot.
   *
   * setModule lives in a closure made once, and a piece of state captured
   * there would be whoever was at the till when the app started — which is
   * exactly the stale answer this is here to stop.
   */
  const whoIsHere = useRef<StaffProfile | null>(null);
  /*
    WHOEVER IS AT THE TILL IS WHO THE WORK IS RECORDED AGAINST.

    Orders were tagged with the account that signed the device in — the
    manager who opened up, or the address the till was set up with — whoever
    was actually standing there and had just typed their PIN. A name on an
    order is how a question gets asked of the right person, and the wrong name
    on it asks the wrong one.

    The same swap covers what they may DO, which is the other half of the same
    mistake: a bar-only cashier letting themselves into a till signed in by
    the owner should not inherit the owner's reach.
  */
  useEffect(() => {
    whoIsHere.current = working;
    setCtx((c) => {
      if (!c) return c;
      const person = working ?? device?.profile ?? null;
      // Their auth account where they have one, their staff record where they
      // do not — the admin's name lookup matches on either. See nameOf.
      const id = working ? (working.user_id || working.$id) : (device?.userId ?? c.userId);
      if (c.working === working && c.profile === person && c.userId === id) return c;
      return { ...c, working, profile: person, userId: id };
    });
  }, [working, device]);

  useEffect(() => {
    if (!lockStore) return;
    try {
      setLocked(window.localStorage.getItem(lockStore) === '1');
    } catch {
      // A browser refusing storage is a till that cannot stay locked across a
      // reload. Worth nothing more than not crashing over.
    }
  }, [lockStore]);

  useEffect(() => {
    if (!ctx) return;
    void listAll<StaffProfile & Doc>('staff_profiles')
      .then((rows) => setStaff(rows))
      .catch(() => setStaff([]));
  }, [ctx?.venue.$id]);

  const lock = () => {
    /*
      Refused when nobody could open it again.

      A lock nobody can undo is a broken till, not a secure one: whoever is
      standing there would be stranded with a shift open and a queue in front
      of them, and the only way back would be clearing the browser's storage.
    */
    const problem = lockProblem(staff);
    if (problem) { toast(problem, 'err'); return; }
    setLocked(true);
    /*
      And nobody is at the till any more.

      Left set, the next person to unlock would be working under the last
      one's name for as long as it took them to be recognised — and if they
      never were, for the rest of the shift.
    */
    setWorking(null);
    try { window.localStorage.setItem(lockStore, '1'); } catch { /* see above */ }
  };

  const unlock = (who?: Unlocker) => {
    setLocked(false);
    try { window.localStorage.removeItem(lockStore); } catch { /* see above */ }
    /*
      And the till becomes theirs.

      Matched back to the full profile: the lock screen is handed a narrow
      shape — a name and a PIN — because that is all it needs to check one, and
      what somebody may WORK is a different question living on the same row.
    */
    const person = who ? staff.find((p) => p.$id === who.$id) ?? null : null;
    setWorking(person);
    /*
      If this till is showing a side they do not work, it moves.

      Refusing the switch alone would leave a bartender looking at the craft
      counter with no way off it, which is worse than the hole being closed:
      the door opened, and the room behind it is one they may not be in.
    */
    if (person) {
      const mine = modulesForStaff(person, ctx?.settings ?? null);
      if (ctx && !mine[ctx.module]) {
        const first = (['kitchen', 'bar', 'craft'] as Module[]).find((m) => mine[m]);
        if (first) ctx.setModule(first);
      }
    }
  };
  /**
   * An order arriving, so the clock gets out of its way.
   *
   * The till never had this. The kitchen screen woke for its tickets and the
   * till woke for nothing at all, so a customer's QR order — the one kind that
   * arrives with nobody standing at the counter, which is precisely when the
   * screensaver is up — landed behind a clock and waited there to be found.
   *
   * Watched here rather than in the views underneath. Those come and go with
   * the tab somebody last pressed: the table grid is not mounted on the
   * takeaway tab, and the pass is not mounted at all unless combined mode is
   * on, so anything relying on them would wake on some tabs and not others.
   * The screensaver belongs to the whole app, and so does noticing.
   */
  const [wakeSignal, setWakeSignal] = useState(0);
  /** How far this screen has been told about. Only the poll below reads it. */
  const seenUpTo = useRef('');

  const venueId = ctx?.venue.$id;
  const side = ctx?.module;
  useEffect(() => {
    if (!venueId) return undefined;
    const off = subscribeCollection<Order>('orders', (order) => {
      if (wakesScreen(order, { module: side, venueId })) setWakeSignal((n) => n + 1);
    });
    return off;
  }, [venueId, side]);

  /*
    And a look on a timer, because the live connection drops silently.

    The same net the kitchen keeps under itself, for the same reason: the case
    where nothing is telling this screen anything is exactly the case where a
    ticket sits behind a clock unseen. One small read a minute, skipped while
    the tab is in the background, and it wakes only for something that moved
    after the last look.
  */
  useEffect(() => {
    if (!venueId) return undefined;
    let alive = true;
    /*
      A fresh bookmark whenever the till changes sides.

      The mark belongs to one side's orders. Carrying the kitchen's over to the
      bar would compare two unrelated timelines, and whichever side happened to
      be busier last would decide whether the first look woke anything. Cleared
      here, so the look below sets the baseline and wakes for nothing.
    */
    seenUpTo.current = '';
    const look = async () => {
      if (!alive || document.hidden) return;
      try {
        /*
          One small page, narrowed by the database rather than in the browser.

          Not loadOpenOrders, which reads every order the venue has ever taken
          and filters them here — fine once at startup on a screen that wants
          them all, wasteful every minute on a till that only wants to know
          whether anything moved. The status list is an index on this
          collection, so the server does the work; the side is checked here,
          because orders written before that column existed carry none and a
          filter on it would step straight over them.
        */
        const page = await db.listDocuments(DB_ID, 'orders', [
          Query.equal('venue_id', venueId),
          Query.equal('status', ['SCHEDULED', 'PENDING', 'ACCEPTED', 'PREPARING', 'READY']),
          Query.limit(40),
        ]);
        if (!alive) return;
        const open = page.documents as unknown as Order[];
        const moved = latestMovement(open.filter((o) => wakesScreen(o, { module: side })));
        if (!moved) return;
        // Never on the first pass: everything is new to a screen that has just
        // loaded, and a till would then be unable to fall asleep at all.
        if (seenUpTo.current && moved > seenUpTo.current) setWakeSignal((n) => n + 1);
        seenUpTo.current = moved;
      } catch {
        // Offline, most likely. The next tick tries again.
      }
    };
    const timer = window.setInterval(look, 60_000);
    const now = () => void look();
    document.addEventListener('visibilitychange', now);
    window.addEventListener('online', now);
    void look();
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', now);
      window.removeEventListener('online', now);
    };
  }, [venueId, side]);

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

    // What this device is signed in as, so the swap above has something to
    // fall back to when the till is nobody's in particular.
    setDevice({ profile, userId: me.userId });

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
      working: null,
      setModule: (m) => {
        /*
          REFUSED HERE, not only by which buttons get drawn.

          The switcher only ever offered sides somebody may work, which reads
          like a rule and is a drawing. Everything else in this system that
          decides who may do what is checked where it happens, and this was the
          exception — one call from anywhere and the till was selling from a
          side its user has no business on.
        */
        const at = whoIsHere.current ?? profile;
        if (!modulesForStaff(at, settings)[m]) {
          toast(`${at?.display_name ?? 'You'} is not set to work the ${MODULE_LABELS[m].toLowerCase()}.`, 'err');
          return;
        }
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

  /**
   * The sides the person standing here may work.
   *
   * Not the sides the ACCOUNT signed into this device may work. A till is
   * signed in once in the morning, usually by whoever opens up, and reached by
   * PIN by everybody else all day — so a bar-only bartender who unlocked a
   * till that was signed in by the owner was being offered the kitchen and the
   * shop, and could sell from either.
   */
  const sidesHere = (['kitchen', 'bar', 'craft'] as Module[])
    .filter((m) => modulesForStaff(ctx.profile, ctx.settings)[m]);

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
        wakeSignal={wakeSignal}
        locked={locked}
        staff={staff}
        onUnlock={unlock}
      />
      <OfflineBar queued={queued} onRetry={() => void flushQueue()} />
      <div className="pos-top">
        <div className="row pos-whoami">
          <Logo size={26} />
          <div>
            <strong>{ctx.venue.name}</strong>
            <div className="who">{ctx.profile?.display_name ?? 'Staff'} · {ctx.profile?.role ?? 'no profile'}</div>
          </div>
        </div>
        {/* The two strips of buttons, held together.
            On a wide screen this box is not there at all — `display: contents`
            — and the strips sit in the top row as they always have. On a phone
            it becomes the second line of the bar, so that the switcher and the
            tabs have the width to be read instead of being squeezed to nothing
            between the name on the left and the buttons on the right. */}
        <div className="pos-strips">
        {/* Which counter this till is. Only shown to somebody who works both
            sides in a business that runs both, everyone else is already where
            they belong and a switch would just be a way to end up in the wrong
            books. It sits left of the tabs because it changes what they mean. */}
        {/* Worked out here rather than read from the boot, because the answer
            changes the moment somebody unlocks: a till signed in by a manager
            and opened by a bartender is a bar till until they walk away. */}
        {sidesHere.length > 1 && (
          <div className="pos-tabs pos-side">
            {/* Built from what this person may actually work rather than three
                hard-coded buttons, so a bar-only cashier is never offered a
                shop they cannot sell from. */}
            {/* `ctx.profile` IS whoever is standing here — it follows the
                PIN, not the sign-in. See the swap where `working` is read. */}
            {sidesHere.map((m) => (
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
        {/*
          THE BAR HAS NO TABLES TAB.

          It had one, on the reasoning that a bar with seating runs tabs
          against a table all night. This bar does not: a drink is poured,
          paid for and handed over where it is ordered, and the second tab was
          a wrong turning offering a dining room that belongs to the kitchen.

          A bar with seating would want it back, and it is one strip of buttons
          to restore. Nothing else here assumes it is gone — see the body
          below, which sends the bar to its counter whatever `tab` happens to
          say, so a remembered value cannot strand somebody on a blank screen.
        */}
        {ctx.module === 'kitchen' && (
          <div className="pos-tabs">
            <button className={tab === 'tables' ? 'on' : ''} onClick={() => setTab('tables')}>Tables</button>
            <button className={tab === 'takeaway' ? 'on' : ''} onClick={() => setTab('takeaway')}>Takeaway</button>
            {isEnabled(ctx.features, 'combined_mode') && (
              <button className={tab === 'kitchen' ? 'on' : ''} onClick={() => setTab('kitchen')}>Kitchen</button>
            )}
          </div>
        )}
        </div>
        <div className="row pos-acts">
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
          {/*
            Stepping away from an open drawer.

            Not sign out: signing out ends the session, drops the shift off
            this screen and makes coming back a matter of an email and a
            password. Somebody going to the store room for two minutes wants
            the till exactly as they left it, behind a PIN.
          */}
          {/* Light or dark, from the room this screen is standing in. The
              setting lived in the admin app, which is where nobody working a
              till ever is. */}
          <ThemeButton />
          <Button size="sm" variant="ghost" onClick={lock} title="Lock this till">
            Lock
          </Button>
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
        ) : ctx.module === 'bar' ? (
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
