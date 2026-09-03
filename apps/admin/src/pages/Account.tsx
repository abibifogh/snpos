import { useState } from 'react';
import { Button, Card, Field, Input, Notice, useToast } from '@snpos/ui';
import { account, humanError } from '../lib';
import { useSession } from '../session';

/** Appwrite's own minimum. Stated up front rather than discovered on submit. */
const MIN_PASSWORD = 8;

export function AccountPage() {
  const { user, profile, refreshUser } = useSession();
  const toast = useToast();

  const [name, setName] = useState(user?.name ?? '');
  const [savingName, setSavingName] = useState(false);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const saveName = async () => {
    setSavingName(true);
    try {
      await account.updateName(name.trim());
      await refreshUser();
      toast('Name updated');
    } catch (e) {
      toast(humanError(e), 'err');
    } finally {
      setSavingName(false);
    }
  };

  const savePassword = async () => {
    setPasswordError(null);

    // Check locally first: a mistyped confirmation should not cost a round trip,
    // and the mismatch message is clearer than anything the server would send.
    if (newPassword.length < MIN_PASSWORD) {
      setPasswordError(`Your new password needs at least ${MIN_PASSWORD} characters.`);
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('The two new passwords do not match.');
      return;
    }
    if (newPassword === currentPassword) {
      setPasswordError('Your new password is the same as your current one.');
      return;
    }

    setSavingPassword(true);
    try {
      await account.updatePassword(newPassword, currentPassword);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      toast('Password changed');
    } catch (e) {
      const msg = humanError(e);
      // Appwrite reports a wrong current password as invalid credentials, which
      // reads as though the whole login failed. Say what actually went wrong.
      setPasswordError(
        /credentials|not recognised/i.test(msg) ? 'Your current password is not correct.' : msg,
      );
    } finally {
      setSavingPassword(false);
    }
  };

  return (
    <>
      <h1>Your account</h1>

      <Card title="Password">
        <p className="small dim" style={{ marginTop: 0 }}>
          If you are still using the temporary password that was printed during setup, change it now. It was shown in a
          terminal window and may still be sitting in your scroll-back.
        </p>
        <Field label="Current password">
          <Input
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
          />
        </Field>
        <div className="grid-2">
          <Field label="New password" hint={`At least ${MIN_PASSWORD} characters.`}>
            <Input
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </Field>
          <Field label="Confirm new password">
            <Input
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
          </Field>
        </div>
        {passwordError && (
          <div style={{ marginBottom: '1rem' }}>
            <Notice>{passwordError}</Notice>
          </div>
        )}
        <Button
          variant="primary"
          onClick={savePassword}
          loading={savingPassword}
          disabled={!currentPassword || !newPassword || !confirmPassword}
        >
          Change password
        </Button>
      </Card>

      <Card title="Your details">
        <Field label="Display name" hint="Shown on orders, discounts and anything else you authorise.">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Email">
          <Input value={user?.email ?? ''} disabled />
          <span className="hint">Changing your email address is done in the Appwrite console.</span>
        </Field>
        <Button onClick={saveName} loading={savingName} disabled={!name.trim() || name === user?.name}>
          Save name
        </Button>
      </Card>

      {profile && (
        <Card title="Your permissions">
          <p className="small dim" style={{ marginTop: 0 }}>
            Set by an administrator; you cannot raise your own limits, which is the point of them.
          </p>
          <div className="table-wrap">
            <table className="data">
              <tbody>
                <tr><td>Role</td><td className="num">{profile.role}</td></tr>
                <tr><td>Open a shift</td><td className="num">{profile.can_open_shift ? 'Yes' : 'No'}</td></tr>
                <tr><td>Close a shift</td><td className="num">{profile.can_close_shift ? 'Yes' : 'No'}</td></tr>
                <tr><td>Void an order</td><td className="num">{profile.can_void ? 'Yes' : 'No'}</td></tr>
                <tr><td>Mark a bill paid</td><td className="num">{profile.can_mark_paid === false ? 'No' : 'Yes'}</td></tr>
                <tr>
                  <td>Discount without a manager</td>
                  <td className="num">up to {(profile.can_discount_up_to_bp / 100).toFixed(0)}%</td>
                </tr>
                <tr>
                  <td>Venues</td>
                  <td className="num">{profile.venue_ids?.length ? profile.venue_ids.join(', ') : 'All venues'}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
