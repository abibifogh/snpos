import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import type { ReactNode } from 'react';
import { account, db, DB_ID, applyThemeSettings } from './lib';
import type { Models } from 'appwrite';
import { requireStaff, signOutCompletely, staffProfileFor, formatMoney, setReadOnly, viewAsProblem, viewAsWords } from '@snpos/core';
import type { Settings, StaffProfile } from '@snpos/core';

interface SessionValue {
  user: Models.User<Models.Preferences> | null;
  /**
   * The profile every screen decides from: whose sidebar, which pages, which
   * buttons. The signed-in person's own, or, while an owner is viewing as
   * someone, that person's. See viewAs.
   */
  profile: StaffProfile | null;
  /** The signed-in person's own profile, whoever is being viewed as. */
  realProfile: StaffProfile | null;
  /** Who the owner is viewing the app as, or null. Nothing saves while set. */
  viewAs: StaffProfile | null;
  startViewAs: (p: StaffProfile) => void;
  stopViewAs: () => void;
  settings: Settings | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshSettings: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const Ctx = createContext<SessionValue>({} as SessionValue);
export const useSession = () => useContext(Ctx);

/**
 * Money, in the business's own currency, from wherever the settings are.
 *
 * Thirty-two pages each wrote `settings ? formatMoney(n, settings) : String(n)`
 * at the top; this is that line, once. Before the settings have loaded a
 * figure shows as the bare number rather than nothing.
 */
export const useMoney = () => {
  const { settings } = useContext(Ctx);
  return (minor: number) => (settings ? formatMoney(minor, settings) : String(minor));
};

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Models.User<Models.Preferences> | null>(null);
  const [profile, setProfile] = useState<StaffProfile | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [viewAs, setViewAs] = useState<StaffProfile | null>(null);

  /*
    Viewing as someone is a lens, not a sign-in. The session is still the
    owner's; the profile the screens read is the other person's, and every
    write is refused at the database wrapper so nothing is saved as the
    owner from somebody else's screen. Kept for the tab only, so a reload
    keeps the view and closing the tab ends it.
  */
  const VIEW_KEY = 'admin.viewAs';
  const startViewAs = (p: StaffProfile) => {
    const why = viewAsProblem(profile, p);
    if (why) throw new Error(why);
    setViewAs(p);
    setReadOnly(viewAsWords(p));
    try { window.sessionStorage.setItem(VIEW_KEY, JSON.stringify(p)); } catch { /* a private window forgets; fine */ }
  };
  const stopViewAs = () => {
    setViewAs(null);
    setReadOnly(null);
    try { window.sessionStorage.removeItem(VIEW_KEY); } catch { /* nothing kept */ }
  };
  // Picked up again after a reload, once the owner's own profile is known.
  useEffect(() => {
    if (!profile || viewAs) return;
    try {
      const kept = window.sessionStorage.getItem(VIEW_KEY);
      if (!kept) return;
      const p = JSON.parse(kept) as StaffProfile;
      if (viewAsProblem(profile, p)) { window.sessionStorage.removeItem(VIEW_KEY); return; }
      setViewAs(p);
      setReadOnly(viewAsWords(p));
    } catch { /* nothing kept */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  const loadSettings = useCallback(async () => {
    const doc = (await db.getDocument(DB_ID, 'settings', 'main')) as unknown as Settings;
    setSettings(doc);
    applyThemeSettings(doc);
    return doc;
  }, []);

  const loadProfile = useCallback(async (userId: string, email?: string) => {
    setProfile(await staffProfileFor({ userId, email }));
  }, []);

  // Settings are readable without a session so the login screen can already be
  // branded; the profile needs one.
  useEffect(() => {
    (async () => {
      try {
        await loadSettings();
      } catch {
        /* not provisioned yet, the login screen explains it */
      }
      try {
        // Being signed in is not enough: the customer menu hands every guest
        // an anonymous session, and one of those must not open the admin app.
        const staff = await requireStaff();
        const me = await account.get();
        setUser(me);
        await loadProfile(staff.userId, me.email);
      } catch (e) {
        // A guest session here is signed in but has no business being so.
        // Clear it, or the login screen fights something invisible.
        if (e instanceof Error && e.name === 'NotStaffError') await signOutCompletely();
        setUser(null);
      } finally {
        setLoading(false);
      }
    })();
  }, [loadSettings, loadProfile]);

  const signIn = async (email: string, password: string) => {
    // Any session already on the device, very likely a guest one from the
    // customer menu on a shared phone, is replaced, not added to.
    await signOutCompletely();
    await account.createEmailPasswordSession(email, password);
    const staff = await requireStaff();
    const me = await account.get();
    setUser(me);
    await loadProfile(staff.userId, me.email);
    await loadSettings();
  };

  const signOut = async () => {
    stopViewAs();
    try {
      await account.deleteSession('current');
    } finally {
      setUser(null);
      setProfile(null);
    }
  };

  return (
    <Ctx.Provider
      value={{
        user,
        profile: viewAs ?? profile,
        realProfile: profile,
        viewAs,
        startViewAs,
        stopViewAs,
        settings,
        loading,
        signIn,
        signOut,
        refreshSettings: async () => {
          await loadSettings();
        },
        refreshUser: async () => {
          setUser(await account.get());
        },
      }}
    >
      {children}
    </Ctx.Provider>
  );
}
