/**
 * Whether this device can be told things, and what to say when it cannot.
 *
 * Turning notifications on is one button with five different ways of not
 * working, and each one needs a different sentence. "Not supported" said to
 * somebody on an iPhone is the worst of them: it is true of the browser tab
 * they are looking at and false of the phone in their hand, which will take
 * notifications perfectly well once the app is on the Home Screen — Apple
 * allows web push nowhere else. A button that just stays grey teaches them
 * the feature does not exist.
 *
 * Pure. The page gathers the facts; this decides what they mean.
 */

export type PushSupport =
  /** Ready to turn on, or already on. */
  | 'ok'
  /** Provisioning has not made this server's key yet. Nothing a person here can do but run it. */
  | 'no-key'
  /** An iPhone or iPad in a browser tab. Works once added to the Home Screen. */
  | 'needs-install'
  /** Asked before and refused. Only the browser's own settings can undo that. */
  | 'blocked'
  /** A browser with no web push at all. */
  | 'unsupported';

/** The facts about this browser, gathered by the page. */
export interface PushEnv {
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  permission: 'default' | 'granted' | 'denied' | 'unknown';
  /** Opened from the Home Screen rather than in a browser tab. */
  standalone: boolean;
  userAgent: string;
  /** An iPad says it is a Mac; touch points are how it gives itself away. */
  maxTouchPoints?: number;
  publicKey?: string;
}

/** An iPhone, iPod or iPad — including an iPad describing itself as a Mac. */
export const isAppleMobile = (userAgent: string, maxTouchPoints = 0): boolean =>
  /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);

export function pushSupport(env: PushEnv): PushSupport {
  if (!env.publicKey) return 'no-key';
  /*
    Before "unsupported", on purpose. Safari in an iPhone tab has no push
    manager at all, so the check below would call it unsupported — which is
    true of the tab and false of the phone.
  */
  if (isAppleMobile(env.userAgent, env.maxTouchPoints) && !env.standalone) return 'needs-install';
  if (!env.hasServiceWorker || !env.hasPushManager || !env.hasNotification) return 'unsupported';
  if (env.permission === 'denied') return 'blocked';
  return 'ok';
}

/** What to say, for everything except 'ok', where the button says it. */
export function supportWords(state: PushSupport): string | null {
  switch (state) {
    case 'no-key':
      return 'This system has not been given its notification key yet. It is made when Provision Appwrite '
        + 'runs, so this will work after the next deploy.';
    case 'needs-install':
      return 'On an iPhone or iPad, Apple only allows notifications from apps on the Home Screen. Tap Share, '
        + 'then Add to Home Screen, open Admin from that icon, and turn notifications on there.';
    case 'blocked':
      return 'Notifications were refused for this site on this device, and a page is not allowed to ask '
        + 'again. Allow them in the browser\'s site settings (the icon beside the address), then come back.';
    case 'unsupported':
      return 'This browser cannot receive notifications. Chrome, Edge, Firefox or Safari will.';
    default:
      return null;
  }
}

/**
 * "Chrome on Mac", so a list of devices can be told apart.
 *
 * Edge before Chrome and Chrome before Safari, because each one's name is
 * inside the next one's: Edge says it is Chrome, and Chrome says it is Safari.
 */
export function deviceLabel(userAgent: string, maxTouchPoints = 0): string {
  const ua = userAgent || '';
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /Firefox\/|FxiOS/.test(ua) ? 'Firefox'
      : /Chrome\/|CriOS/.test(ua) ? 'Chrome'
        : /Safari\//.test(ua) ? 'Safari'
          : 'A browser';
  const os = /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1) ? 'iPad'
      : /Android/.test(ua) ? 'Android'
        : /Windows/.test(ua) ? 'Windows'
          : /Macintosh/.test(ua) ? 'Mac'
            : /Linux/.test(ua) ? 'Linux'
              : '';
  return os ? `${browser} on ${os}` : browser;
}

/**
 * The server's public key as the bytes PushManager.subscribe wants.
 *
 * Handed over as base64url, which `atob` will not read as it stands — the
 * alphabet and the missing padding both have to be put back first.
 */
export function keyBytes(base64url: string): Uint8Array {
  const b64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Whether a subscription already on this device was made for this server key.
 *
 * One made for a different key cannot be reused and blocks a new one, so it
 * has to be dropped first. Absent counts as different: dropping a
 * subscription that was fine costs one prompt-free resubscribe, while keeping
 * one that is not fine means notifications that never arrive.
 */
export function sameKey(existing: ArrayBuffer | ArrayBufferView | null | undefined, wanted: Uint8Array): boolean {
  if (!existing) return false;
  const a = existing instanceof ArrayBuffer
    ? new Uint8Array(existing)
    : new Uint8Array(existing.buffer, existing.byteOffset, existing.byteLength);
  if (a.length !== wanted.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== wanted[i]) return false;
  return true;
}
