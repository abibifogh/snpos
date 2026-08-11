import { useState } from 'react';
import { Button, Card, Field, Input, Notice, Logo } from '@snpos/ui';
import { useSession } from '../session';
import { account, humanError } from '../lib';
import { signOutCompletely } from '@snpos/core';

/**
 * Where the "set a password" email should land people.
 *
 * Built from the app's own base rather than hard-coded, so it is right on
 * github.io (/snpos/admin/), on a domain of its own (/admin/) and on a
 * developer's laptop without anybody remembering to change it.
 */
export const passwordSetupUrl = () =>
  `${window.location.origin}${import.meta.env.BASE_URL}#/set-password`;

/** The userId and secret carried by a link from an email. */
function credentialsFromUrl(): { userId: string; secret: string; kind: 'token' | 'recovery' } | null {
  // Both the hash and the ordinary query string are checked. Appwrite appends
  // its parameters to whatever URL it was given, and which side of the "#"
  // they end up on depends on how the link was built.
  const inHash = window.location.hash.includes('?')
    ? new URLSearchParams(window.location.hash.slice(window.location.hash.indexOf('?') + 1))
    : new URLSearchParams();
  const inQuery = new URLSearchParams(window.location.search);
  const userId = inHash.get('userId') || inQuery.get('userId') || '';
  const secret = inHash.get('secret') || inQuery.get('secret') || '';
  if (!userId || !secret) return null;
  // Two kinds of link arrive with the same two values, and they are redeemed by
  // different calls. The one this system sends signs you in; the one Appwrite
  // sends resets a password.
  return { userId, secret, kind: window.location.hash.startsWith('#/token') ? 'token' : 'recovery' };
}

export function Login() {
  const { signIn, settings } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A link from an email arrives with two values in it, and redeeming them is
  // the only thing this screen should be doing at that moment.
  const [link] = useState(credentialsFromUrl);
  const [mode, setMode] = useState<'signin' | 'forgot'>('signin');

  const name = settings?.restaurant_name ?? 'NiceOps POS';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await signIn(email.trim(), password);
    } catch (err) {
      setError(humanError(err));
    } finally {
      setBusy(false);
    }
  };

  const askForLink = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await account.createRecovery(email.trim(), passwordSetupUrl());
      // Deliberately the same message whether or not that address exists.
      // Anything else turns this box into a way of finding out who works here.
      setDone(
        `If ${email.trim()} belongs to a member of staff here, a link to set a password is on its way. ` +
          'It expires in an hour. Check the spam folder if it has not arrived in a few minutes.',
      );
    } catch (err) {
      setError(humanError(err));
    } finally {
      setBusy(false);
    }
  };

  const choosePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!link) return;
    if (password.length < 8) { setError('Passwords need at least 8 characters.'); return; }
    setError(null);
    setBusy(true);
    try {
      if (link.kind === 'token') {
        // The link signs them in; the password is set from inside that session.
        // Appwrite lets a user with no password set one without being asked for
        // the old one, which is the whole point of arriving this way.
        //
        // Any session already on the device is dropped first. On a shared phone
        // that is very likely a guest session from the customer menu, and
        // adding to it rather than replacing it is how somebody ends up signed
        // in as the wrong person.
        await signOutCompletely();
        await account.createSession(link.userId, link.secret);
        await account.updatePassword(password);
      } else {
        await account.updateRecovery(link.userId, link.secret, password);
        // Straight in, rather than "now go and sign in"; they have just typed
        // the password, and asking for it again is a step that exists only
        // because it was easier to write.
        await signIn(email.trim(), password);
      }
      // The address still carries a one-time secret. Clearing it means a
      // shared screen, a bookmark or a browser history does not carry it
      // around after it has been used.
      window.location.replace(`${window.location.pathname}#/`);
      window.location.reload();
    } catch (err) {
      const msg = humanError(err);
      setError(
        /expired|invalid token|not found|user_invalid_token/i.test(msg)
          ? 'That link has been used already or has expired. Ask an admin to send another one.'
          : msg,
      );
      setBusy(false);
    }
  };

  const shell = (body: React.ReactNode, footer?: React.ReactNode) => (
    <div className="login-wrap">
      <div className="login-card">
        <div style={{ display: 'grid', placeItems: 'center', marginBottom: '1rem' }}>
          <Logo size={52} />
        </div>
        <Card title={name}>{body}</Card>
        {footer}
        {!settings && (
          <p className="small dim" style={{ marginTop: '1rem', textAlign: 'center' }}>
            Could not load settings. If this is a new install, run <code>npm run provision</code> first.
          </p>
        )}
      </div>
    </div>
  );

  // ---------------------------------------------------- setting a password
  if (link) {
    return shell(
      <form onSubmit={choosePassword}>
        <p className="small dim" style={{ marginTop: 0 }}>
          Choose a password. You will use it with your email address to sign in from now on.
        </p>
        {link.kind === 'recovery' && (
          <Field label="Your email">
            <Input
              type="email"
              value={email}
              autoComplete="username"
              autoFocus
              required
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
        )}
        <Field label="Choose a password" hint="At least 8 characters.">
          <Input
            type="password"
            value={password}
            autoComplete="new-password"
            required
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        {error && <div style={{ marginBottom: '1rem' }}><Notice>{error}</Notice></div>}
        <Button type="submit" variant="primary" loading={busy} style={{ width: '100%' }}>
          Set password and sign in
        </Button>
      </form>,
    );
  }

  // ------------------------------------------------------ asking for a link
  if (mode === 'forgot') {
    return shell(
      done ? (
        <>
          <Notice>{done}</Notice>
          <Button style={{ width: '100%' }} onClick={() => { setMode('signin'); setDone(null); }}>
            Back to sign in
          </Button>
        </>
      ) : (
        <form onSubmit={askForLink}>
          <p className="small dim" style={{ marginTop: 0 }}>
            Enter the email address you were invited with. We will send you a link to set a password.
          </p>
          <Field label="Email">
            <Input
              type="email"
              value={email}
              autoComplete="username"
              autoFocus
              required
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          {error && <div style={{ marginBottom: '1rem' }}><Notice>{error}</Notice></div>}
          <Button type="submit" variant="primary" loading={busy} style={{ width: '100%' }}>
            Send the link
          </Button>
          <Button variant="ghost" style={{ width: '100%', marginTop: '0.5rem' }} onClick={() => setMode('signin')}>
            Back
          </Button>
        </form>
      ),
    );
  }

  // -------------------------------------------------------------- signing in
  return shell(
    <form onSubmit={submit}>
      <Field label="Email">
        <Input
          type="email"
          value={email}
          autoComplete="username"
          autoFocus
          required
          onChange={(e) => setEmail(e.target.value)}
        />
      </Field>
      <Field label="Password">
        <Input
          type="password"
          value={password}
          autoComplete="current-password"
          required
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>
      {error && <div style={{ marginBottom: '1rem' }}><Notice>{error}</Notice></div>}
      <Button type="submit" variant="primary" loading={busy} style={{ width: '100%' }}>
        Sign in
      </Button>
    </form>,
    <p className="small dim" style={{ marginTop: '1rem', textAlign: 'center' }}>
      <a
        href="#"
        onClick={(e) => { e.preventDefault(); setError(null); setMode('forgot'); }}
      >
        Never had a password, or forgotten it?
      </a>
    </p>,
  );
}
