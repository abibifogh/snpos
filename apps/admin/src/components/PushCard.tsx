import { useEffect, useState } from 'react';
import { Button, Card, Notice, useToast } from '@snpos/ui';
import { pushSupport, supportWords, deviceLabel, keyBytes, sameKey, dateTimeWords } from '@snpos/core';
import type { PushEnv, PushSupport } from '@snpos/core';
import { db, DB_ID, ID, Query, humanError } from '../lib';
import { useSession } from '../session';

/** A device's row, as this card needs it. */
interface DeviceRow {
  $id: string;
  user_id: string;
  endpoint: string;
  device_label?: string;
  last_sent_at?: string | null;
  last_error?: string;
}

/** Everything this browser can tell us, gathered once. */
function gather(publicKey?: string): PushEnv {
  const nav = typeof navigator === 'undefined' ? null : navigator;
  return {
    hasServiceWorker: !!nav && 'serviceWorker' in nav,
    hasPushManager: typeof window !== 'undefined' && 'PushManager' in window,
    hasNotification: typeof window !== 'undefined' && 'Notification' in window,
    permission: typeof Notification === 'undefined' ? 'unknown' : Notification.permission,
    standalone: typeof window !== 'undefined'
      && (window.matchMedia?.('(display-mode: standalone)').matches
        || (nav as Navigator & { standalone?: boolean } | null)?.standalone === true),
    userAgent: nav?.userAgent ?? '',
    maxTouchPoints: nav?.maxTouchPoints ?? 0,
    publicKey,
  };
}

/**
 * The service worker this page registered, or null if it never became ready.
 *
 * Bounded, because `ready` waits for ever when registration failed — and a
 * button that spins for ever is worse than one that says it could not start.
 */
async function worker(): Promise<ServiceWorkerRegistration | null> {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<null>((resolve) => { setTimeout(() => resolve(null), 8000); }),
  ]);
}

/**
 * NOTIFICATIONS ON THIS DEVICE.
 *
 * Per device rather than per person, because that is how browsers do it: a
 * phone and a laptop each have to say yes on their own, and each can be
 * switched off without touching the other.
 *
 * Admins only, because the only thing sent is a stock count left waiting for
 * an admin's decision. Saying so rather than hiding the card stops a manager
 * wondering why the owner's phone buzzes and theirs does not.
 */
export function PushCard() {
  const { user, profile, settings } = useSession();
  const toast = useToast();
  const isAdmin = profile?.role === 'admin';

  const [support, setSupport] = useState<PushSupport | null>(null);
  const [row, setRow] = useState<DeviceRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const publicKey = settings?.push_public_key;

  /** Work out where this device stands: can it, and is it already on? */
  const look = async () => {
    const state = pushSupport(gather(publicKey));
    setSupport(state);
    if (state !== 'ok' || !user) return;
    const reg = await worker();
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) { setRow(null); return; }
    /*
      Matched by endpoint, not by user. The browser's subscription is the
      truth about THIS device; a row in the database for another of this
      person's devices says nothing about whether this one is on.
    */
    const mine = await db.listDocuments(DB_ID, 'push_subscriptions', [Query.equal('user_id', user.$id)])
      .then((r) => (r.documents as unknown as DeviceRow[]).find((d) => d.endpoint === sub.endpoint) ?? null)
      .catch(() => null);
    setRow(mine);
  };

  useEffect(() => {
    if (isAdmin) void look().catch((e) => setError(humanError(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, publicKey, user?.$id]);

  const turnOn = async () => {
    if (!user || !publicKey) return;
    setBusy(true);
    setError(null);
    try {
      // Asked only here, on a press. A permission prompt on page load is the
      // one most people refuse, and refused once it cannot be asked again.
      const answer = await Notification.requestPermission();
      if (answer !== 'granted') {
        setSupport(pushSupport(gather(publicKey)));
        setError(answer === 'denied'
          ? String(supportWords('blocked'))
          : 'Notifications were not turned on. Press the button again and choose Allow.');
        return;
      }

      const reg = await worker();
      if (!reg) throw new Error('This page\'s offline worker did not start, so notifications cannot be set up. Reload and try again.');

      /*
        A subscription left over from a different server key cannot be reused
        — subscribing again over it fails. So an old one is dropped first.
        Ordinary on a phone whose Admin was set up before a fresh database.
      */
      const old = await reg.pushManager.getSubscription();
      if (old && !sameKey(old.options?.applicationServerKey, keyBytes(publicKey))) {
        await old.unsubscribe().catch(() => undefined);
      }

      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        // The whole buffer is the key: keyBytes makes a fresh one of exactly
        // that length, so there is no offset or slack to trim.
        applicationServerKey: keyBytes(publicKey).buffer as ArrayBuffer,
      });
      const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
      if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
        throw new Error('The browser gave back an incomplete subscription. Try again, or use another browser.');
      }

      const data = {
        user_id: user.$id,
        endpoint: json.endpoint,
        p256dh: json.keys.p256dh,
        auth: json.keys.auth,
        device_label: deviceLabel(navigator.userAgent, navigator.maxTouchPoints ?? 0),
        // Answered by the server with a notification on this device, which is
        // the only proof that every link in the chain works.
        test_requested_at: new Date().toISOString(),
      };

      // The same device twice is one row, not two notifications per alert.
      const existing = await db.listDocuments(DB_ID, 'push_subscriptions', [Query.equal('user_id', user.$id)])
        .then((r) => (r.documents as unknown as DeviceRow[]).find((d) => d.endpoint === json.endpoint))
        .catch(() => undefined);
      const saved = existing
        ? await db.updateDocument(DB_ID, 'push_subscriptions', existing.$id, data)
        : await db.createDocument(DB_ID, 'push_subscriptions', ID.unique(), data);

      setRow(saved as unknown as DeviceRow);
      toast('Notifications are on. A test should arrive on this device in a few seconds.');
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    if (!row) return;
    setBusy(true);
    setError(null);
    try {
      await db.updateDocument(DB_ID, 'push_subscriptions', row.$id, { test_requested_at: new Date().toISOString() });
      toast('Test sent. It should arrive in a few seconds.');
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async () => {
    setBusy(true);
    setError(null);
    try {
      const reg = await worker();
      const sub = await reg?.pushManager.getSubscription();
      await sub?.unsubscribe().catch(() => undefined);
      if (row) await db.deleteDocument(DB_ID, 'push_subscriptions', row.$id);
      setRow(null);
      toast('Notifications are off on this device.');
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  const why = support ? supportWords(support) : null;

  return (
    <Card title="Notifications on this device">
      <p className="small dim" style={{ marginTop: 0 }}>
        A notification when a stock count has held a difference for more than a day without anybody agreeing or
        refusing it. The same alert is emailed to every admin with an address on their staff profile.
      </p>

      {!isAdmin ? (
        <Notice tone="info">
          These go to admins only, because agreeing or refusing a count is an admin&rsquo;s decision.
        </Notice>
      ) : (
        <>
          {error && <div style={{ marginBottom: '0.8rem' }}><Notice>{error}</Notice></div>}
          {why && <Notice tone={support === 'blocked' ? 'warn' : 'info'}>{why}</Notice>}

          {support === 'ok' && (row ? (
            <>
              <p className="small" style={{ marginBottom: '0.4rem' }}>
                <strong>On</strong> for {row.device_label || 'this device'}.
                {row.last_sent_at && <span className="dim"> Last delivered {dateTimeWords(row.last_sent_at)}.</span>}
              </p>
              {/* What the push service said last time, in its words. A device
                  that quietly stopped receiving is the failure nobody notices. */}
              {row.last_error && (
                <Notice tone="warn">The last notification to this device did not get through: {row.last_error}</Notice>
              )}
              <div className="row" style={{ gap: '0.5rem', marginTop: '0.6rem' }}>
                <Button size="sm" onClick={() => void sendTest()} loading={busy}>Send a test</Button>
                <Button size="sm" variant="ghost" onClick={() => void turnOff()} disabled={busy}>Turn off</Button>
              </div>
            </>
          ) : (
            <Button variant="primary" onClick={() => void turnOn()} loading={busy}>
              Turn on notifications
            </Button>
          ))}
        </>
      )}
    </Card>
  );
}
