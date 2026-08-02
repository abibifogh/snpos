import { useState } from 'react';
import { Button, Card, Field, Input, Notice, Logo } from '@snpos/ui';
import { useSession } from '../session';
import { humanError } from '../lib';

export function Login() {
  const { signIn, settings } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div style={{ display: 'grid', placeItems: 'center', marginBottom: '1rem' }}>
          <Logo size={52} />
        </div>
        <Card title={settings?.restaurant_name ?? 'SNPOS Admin'}>
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
          </form>
        </Card>
        {!settings && (
          <p className="small dim" style={{ marginTop: '1rem', textAlign: 'center' }}>
            Could not load settings. If this is a new install, run <code>npm run provision</code> first.
          </p>
        )}
      </div>
    </div>
  );
}
