import { useEffect, useState } from 'react';
import { Button, Card, Empty, Field, Input, Modal, Notice, Select, Spinner, Toggle, Badge, useToast } from '@snpos/ui';
import { db, DB_ID, ID, listAll, humanError } from '../lib';
import {
  encodePin, pinProblem, modulesOf, sidesOf, legacySide, MODULE_LABELS,
  inviteState, inviteWords, stuckInvites, meanwhile, INVITE_CHECKS,
} from '@snpos/core';
import type { StaffProfile, Module } from '@snpos/core';
import type { Doc } from '@snpos/core';
import { useSession } from '../session';

interface VenueRow extends Doc { name: string }

const ROLES: StaffProfile['role'][] = ['cook', 'waiter', 'cashier', 'manager', 'admin'];

/**
 * Starting permissions per role. Every one is adjustable per person afterwards
 *, these are a sensible default, not a rule. A cook can be given the till.
 */
const DEFAULTS: Record<StaffProfile['role'], Partial<StaffProfile>> = {
  cook: { can_open_shift: false, can_close_shift: false, can_void: false, can_discount_up_to_bp: 0, can_mark_paid: false, can_record_waste: true },
  waiter: { can_open_shift: false, can_close_shift: false, can_void: false, can_discount_up_to_bp: 0, can_mark_paid: true, can_record_waste: true },
  cashier: { can_open_shift: true, can_close_shift: true, can_void: false, can_discount_up_to_bp: 500, can_mark_paid: true, can_record_waste: true },
  manager: { can_open_shift: true, can_close_shift: true, can_void: true, can_discount_up_to_bp: 2000, can_mark_paid: true, can_record_waste: true },
  admin: { can_open_shift: true, can_close_shift: true, can_void: true, can_discount_up_to_bp: 10000, can_mark_paid: true, can_record_waste: true },
};

/**
 * Whether a profile is joined to a real account yet.
 *
 * Not simply "has a user_id": on a database that still insists on one, a
 * profile with no account points at itself, so the field is set but nothing is
 * behind it. Someone invited yesterday should read as Invited until they have
 * actually signed in.
 */
const linked = (p: Pick<StaffProfile, '$id' | 'user_id'>) => !!p.user_id && p.user_id !== p.$id;

/**
 * Save a profile against whatever shape the database actually has.
 *
 * Two kinds of drift are survived here rather than turned into a dead end.
 *
 * A field the database has never heard of is dropped and the save retried:
 * asking for a sign-in link is a field, and a database provisioned before that
 * field existed would otherwise refuse the whole document, so adding staff
 * would break again for anybody who had not re-run provisioning.
 *
 * A user_id the database still insists on is filled with the profile's own id.
 * It cannot be blank, because the field is unique and the second person without
 * a login would collide with the first.
 *
 * Both stop mattering once Provision Appwrite has run. Neither is worth telling
 * an admin about while they are trying to add a cook.
 */
async function writeProfile(editing: boolean, id: string, payload: Record<string, unknown>): Promise<string[]> {
  const body = { ...payload };
  const dropped: string[] = [];

  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      if (editing) await db.updateDocument(DB_ID, 'staff_profiles', id, body);
      else await db.createDocument(DB_ID, 'staff_profiles', id, body);
      return dropped;
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);

      const unknown = /unknown attribute:?\s*"?([A-Za-z0-9_]+)"?/i.exec(raw);
      if (unknown && unknown[1] in body) {
        dropped.push(unknown[1]);
        delete body[unknown[1]];
        continue;
      }
      if (/missing required attribute.*user_id/i.test(raw) && !body.user_id) {
        body.user_id = id;
        continue;
      }
      throw e;
    }
  }
  throw new Error('Could not save this profile.');
}

export function StaffPage() {
  const toast = useToast();
  const [rows, setRows] = useState<StaffProfile[] | null>(null);
  const [venues, setVenues] = useState<VenueRow[]>([]);
  const [editing, setEditing] = useState<Partial<StaffProfile> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pin, setPin] = useState('');
  // Kitchen staff usually have no email at all. A profile with a PIN and no
  // login is a complete, working staff record, not a half-finished one.
  const [wantsLogin, setWantsLogin] = useState(false);
  const { settings } = useSession();
  const mods = modulesOf(settings);
  /**
   * The trades this business actually runs, in a fixed order.
   *
   * Declared here rather than rebuilt at each use so the save and the form
   * cannot disagree about what "every side" means — which is the difference
   * between storing an empty list and storing three entries that go stale the
   * moment a fourth trade is switched on.
   */
  const runningSides = (['kitchen', 'craft', 'bar'] as Module[]).filter((m) => mods[m]);
  /**
   * Anybody whose link was asked for and never went.
   *
   * Worked out from the two stamps the server already keeps, so this needs no
   * new field and reports on invitations sent long before the page could say
   * anything about them.
   */
  const stuck = stuckInvites(rows ?? []);

  const load = async () => {
    const [s, v] = await Promise.all([listAll<StaffProfile>('staff_profiles'), listAll<VenueRow>('venues')]);
    setRows(s.sort((a, b) => a.display_name.localeCompare(b.display_name)));
    setVenues(v);
  };
  useEffect(() => { load().catch((e) => setError(humanError(e))); }, []);

  const open = (p?: StaffProfile, asInvite = false) => {
    /*
      The old single answer is read into the new list on the way in.

      A profile saved as "craft only" before the list existed has no
      works_in_modules at all, and the toggles would show every side ticked —
      which reads as "this person works everywhere", the opposite of what is
      stored. sidesOf answers from whichever field the row actually has, and
      an empty result genuinely does mean every side.
    */
    setEditing(
      p
        ? { ...p, works_in_modules: sidesOf(p).length ? sidesOf(p) : runningSides }
        : { display_name: '', email: '', role: 'waiter', active: true, ...DEFAULTS.waiter, venue_ids: [] },
    );
    setWantsLogin(asInvite ? false : !!p?.email);
    setPin('');
    setError(null);
  };

  const save = async () => {
    if (!editing?.display_name?.trim()) { setError('Enter their name.'); return; }
    if (wantsLogin && !editing.email?.trim()) { setError('Enter their email address, the invitation goes there.'); return; }
    if (pin) {
      const problem = pinProblem(pin);
      if (problem) { setError(problem); return; }
    }
    if (!editing.$id && !wantsLogin && !pin) {
      setError('Set a PIN, or tick "give them a login" and enter an email. Otherwise they cannot identify themselves.');
      return;
    }

    // The one case where "edit their existing profile instead" is both true and
    // useful: somebody on this list already has that address. Caught here,
    // before anything is written, so the message names the person to go and
    // edit rather than leaving the admin to hunt for them.
    const typed = (editing.email ?? '').trim().toLowerCase();
    if (!editing.$id && typed) {
      const clash = (rows ?? []).find((r) => (r.email ?? '').trim().toLowerCase() === typed);
      if (clash) {
        setError(`${clash.display_name} already has a profile with that email address. Edit theirs rather than adding a second one.`);
        return;
      }
    }

    /*
      The sides they work on, narrowed to what the business runs.

      Every side ticked is stored as an empty list, not as three entries. Empty
      means "wherever the business trades" and keeps meaning that if a fourth
      trade is switched on next year; a frozen list of today's three would
      quietly exclude somebody from it.
    */
    const picked = (editing.works_in_modules ?? runningSides).filter((m) => runningSides.includes(m));
    const sides: Module[] = picked.length === runningSides.length ? [] : picked;

    if (runningSides.length > 1 && picked.length === 0) {
      setError('Choose at least one side of the business for them to work on.');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const role = editing.role ?? 'waiter';
      const payload = {
        // Left out entirely until there is a real one, never written as "".
        //
        // user_id carries a unique index; one profile per login, which is the
        // point of it. An empty string is a value like any other, so the first
        // person without a login took "" and the next one collided with them:
        // "Something with that name or code already exists" on the second cook
        // you ever added. Absent means null, and a unique index lets nulls
        // repeat.
        ...(editing.user_id ? { user_id: editing.user_id } : {}),
        email: (editing.email ?? '').trim().toLowerCase(),
        display_name: editing.display_name.trim(),
        role,
        active: editing.active ?? true,
        phone: editing.phone ?? '',
        /*
          Both fields, and the list is the one that counts.

          `works_in` cannot say "the bar and the bistro but not the shop", so
          it is written as the nearest true single value — see legacySide —
          purely so a database that has not been provisioned yet still records
          something rather than nothing. The moment the column exists, the
          list is what modulesForStaff reads.
        */
        works_in: legacySide(sides),
        works_in_modules: sides,
        can_open_shift: editing.can_open_shift ?? false,
        can_close_shift: editing.can_close_shift ?? false,
        can_void: editing.can_void ?? false,
        can_discount_up_to_bp: Number(editing.can_discount_up_to_bp ?? 0),
        can_mark_paid: editing.can_mark_paid ?? true,
        can_change_line_price: editing.can_change_line_price ?? false,
        can_delete_items: editing.can_delete_items ?? false,
        can_see_private_expenses: editing.can_see_private_expenses ?? false,
        can_fund_petty_cash: editing.can_fund_petty_cash ?? false,
        can_record_waste: editing.can_record_waste ?? true,
        venue_ids: editing.venue_ids ?? [],
        ...(pin ? { pin_hash: await encodePin(pin), pin_set_at: new Date().toISOString() } : {}),
        // Asking for the sign-in link is a field on the profile, not a call
        // from here. Creating an account and adding somebody to a team needs a
        // server key; a browser is not allowed to, which is exactly why the
        // old version saved the profile and then quietly failed to invite
        // anybody.
        ...(wantsLogin && editing.email?.trim() ? { login_link_requested_at: new Date().toISOString() } : {}),
      };

      const id = editing.$id ?? ID.unique();
      // On an edit the link is cleared outright, so a profile saved by an
      // older version, which wrote "", is tidied rather than left holding the
      // one empty slot the unique index allows.
      const dropped = await writeProfile(
        !!editing.$id,
        id,
        editing.$id ? { ...payload, user_id: editing.user_id || null } : payload,
      );

      /*
        Said out loud when the side list could not be stored.

        Without the column the only thing that saved is `works_in`, which
        cannot hold a combination — so somebody set to the bar and the bistro
        would quietly come back as working everywhere, including the shop.
        That is the opposite of what was just asked for, and a save that
        silently does the opposite must not report success.
      */
      if (dropped.includes('works_in_modules') && sides.length !== 1) {
        toast(
          'Saved, but which sides they work on could not be. This project\'s database has not been updated '
          + 'yet — run "Provision Appwrite" in GitHub Actions, then save this person again.',
          'err',
        );
      }

      /*
        What was asked for, not what was achieved.

        This used to say "a sign-in link is on its way", which the browser has
        no way of knowing: it writes a field, and a background job sends the
        mail. Where that job was not deployed, or the mail settings were never
        filled in, nothing happened at all and this line said it had — which is
        why an invitation that never arrived looked like a mail problem rather
        than a setup one. The row now shows whether it actually went.
      */
      const outcome = !(wantsLogin && payload.email)
        ? pin ? 'Saved, PIN set' : 'Saved'
        : dropped.includes('login_link_requested_at')
          ? 'Saved, but no sign-in link can be asked for yet. Run "Provision Appwrite" in GitHub Actions, then use "Send sign-in link" on their row.'
          : `Saved. A sign-in link has been asked for; their row will say "Link sent" once it has gone.`;

      setEditing(null);
      setPin('');
      await load();
      toast(outcome);
    } catch (e) {
      const msg = humanError(e);
      // A clash here is no longer expected, profiles without a login are
      // written with that field left empty rather than blank, which the
      // database allows any number of. If one turns up anyway, say so plainly
      // instead of leaving "something already exists" to be guessed at.
      setError(
        /already exists/i.test(msg)
          ? 'The database refused to save this person, and nothing was saved. Nothing you typed is wrong, an old record is holding a slot this one needs. Send this to whoever set the system up: staff_profiles / user_unique.'
          : msg,
      );
    } finally {
      setBusy(false);
    }
  };

  /**
   * Send somebody their way in, again.
   *
   * Asking is a field on their profile; the sending is done by the server, over
   * the restaurant's own mail provider, the one already delivering receipts.
   * Nothing here talks to Appwrite's invitation mail, which is throttled, lands
   * in spam, and cannot be resent at all.
   */
  const sendLink = async (p: StaffProfile) => {
    if (!p.email) return;
    try {
      await db.updateDocument(DB_ID, 'staff_profiles', p.$id, {
        login_link_requested_at: new Date().toISOString(),
      });
      toast(`Asked for a sign-in link for ${p.email}. Their row will say "Link sent" once it has gone.`);
      /*
        Look again shortly, so the badge settles itself.

        The job answers in seconds, and without this the row sits on "Sending…"
        until somebody reloads — which reads exactly like the silent failure
        this whole change is about. One look, not a poll: if it has not landed
        by then the row says so, which is the honest outcome.
      */
      await load().catch(() => undefined);
      window.setTimeout(() => { void load().catch(() => undefined); }, 8_000);
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      toast(
        /unknown attribute/i.test(raw)
          ? 'Sign-in links need one more field in the database. Run "Provision Appwrite" in GitHub Actions, then try again.'
          : humanError(e),
        'err',
      );
    }
  };

  const remove = async (p: StaffProfile) => {
    const warnLogin = p.email
      ? `\n\nTheir login (${p.email}) is cancelled with them; they will not be able to sign in to anything. To stop somebody working without going that far, untick "active" instead.`
      : '';
    if (!confirm(`Remove ${p.display_name}? Their past orders, discounts and shifts stay on record; that history is what makes the audit trail worth having.${warnLogin}`)) return;
    try {
      await db.deleteDocument(DB_ID, 'staff_profiles', p.$id);
      await load();
      // The login is cancelled by the server a moment later, off the back of
      // this deletion; a browser is not allowed to delete somebody else's
      // account, and should not be.
      toast(p.email ? 'Removed, their login is being cancelled' : 'Removed');
    } catch (e) {
      toast(humanError(e), 'err');
    }
  };

  return (
    <>
      <div className="spread">
        <h1>Staff</h1>
        <Button variant="primary" onClick={() => open(undefined, false)}>Add someone</Button>
      </div>

      <p className="dim small" style={{ marginTop: 0 }}>
        Kitchen and floor staff sign in with a <strong>PIN</strong> on the shared device, no email, no password.
        Only people who need the admin dashboard on their own device get a login. Either way each person is
        identified individually, which is what makes “who authorised this discount” answerable at all.
      </p>

      {error && !editing && <Notice>{error}</Notice>}

      {/*
        Only when something is genuinely wrong.

        A standing note about mail settings on a page that works is one people
        learn to scroll past, and it would be there on the day it finally
        mattered. This appears when a link was asked for and never went.
      */}
      {stuck.length > 0 && (
        <Notice tone="warn">
          <strong>
            {stuck.length === 1
              ? `${stuck[0].display_name}'s sign-in link was never sent.`
              : `${stuck.length} sign-in links were asked for and never sent.`}
          </strong>
          <div className="small" style={{ marginTop: '0.4rem' }}>
            Nothing has reached them. The sending is done by the server, not by this screen, so there are two
            things to check — in this order:
          </div>
          <ol className="small" style={{ margin: '0.5rem 0 0', paddingLeft: '1.1rem' }}>
            {INVITE_CHECKS.map((c) => (
              <li key={c.what} style={{ marginBottom: '0.35rem' }}>
                <strong>{c.what}.</strong> {c.how}
              </li>
            ))}
          </ol>
          <div className="small" style={{ marginTop: '0.5rem' }}>
            {meanwhile(stuck[0])}
          </div>
        </Notice>
      )}

      <Card pad={false}>
        {!rows ? (
          <div className="card-pad"><Spinner /></div>
        ) : rows.length === 0 ? (
          <Empty title="No staff yet">
            Add your team. Cooks and waiters just need a name and a PIN.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Name</th><th>Role</th><th>Works on</th><th>Discount limit</th><th>Status</th><th /></tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.$id}>
                    <td>
                      <div style={{ fontWeight: 550 }}>{p.display_name}</div>
                      <div className="small dim">{p.email || (p.pin_hash ? 'PIN only, no login' : 'no PIN set')}</div>
                    </td>
                    {/*
                      WHICH SIDES THIS PERSON WORKS, on the list.

                      It was only visible by opening each person one at a time,
                      and the default is generous: a record that has never had
                      its sides set works EVERYWHERE the business trades. So
                      somebody described as "a cashier with access to the bar"
                      could be on the craft till all morning with nothing on any
                      screen to say why, and the owner had no way to spot it
                      short of opening thirty records.

                      The unset case is called out rather than printed as three
                      ticks, because "everywhere, because nobody said" and
                      "everywhere, on purpose" are different answers and only
                      one of them wants looking at.
                    */}
                    <td className="dim">{p.role}</td>
                    <td className="small">
                      {(() => {
                        const sides = sidesOf(p).filter((m) => runningSides.includes(m));
                        if (sides.length === 0 || sides.length === runningSides.length) {
                          return runningSides.length > 1
                            ? <Badge tone="warn">Everywhere · not set</Badge>
                            : <span className="dim">{MODULE_LABELS[runningSides[0] ?? 'kitchen']}</span>;
                        }
                        return (
                          <span className="dim">{sides.map((m) => MODULE_LABELS[m]).join(', ')}</span>
                        );
                      })()}
                    </td>
                    <td className="dim small">
                      {p.can_discount_up_to_bp ? `up to ${(p.can_discount_up_to_bp / 100).toFixed(0)}%` : 'none'}
                    </td>
                    <td>
                      {/*
                        Two different facts, and they were being shown as one.

                        "Invited" meant only "has an email and has not signed in
                        yet" — it said nothing about whether an email was ever
                        sent, which is the question somebody actually has when
                        one does not arrive. The sign-in state and the account
                        state are now separate lines.
                      */}
                      {linked(p) ? (
                        p.active ? <Badge tone="ok">Active</Badge> : <Badge>Disabled</Badge>
                      ) : (
                        (() => {
                          const words = inviteWords(inviteState(p));
                          return (
                            <>
                              <Badge tone={words.tone}>{words.label}</Badge>
                              {words.detail && (
                                <div className="small dim" style={{ marginTop: '0.25rem' }}>{words.detail}</div>
                              )}
                            </>
                          );
                        })()
                      )}
                    </td>
                    <td className="num">
                      {p.email && (
                        <Button size="sm" variant="ghost" onClick={() => sendLink(p)}>
                          {linked(p) ? 'Send reset link' : 'Send sign-in link'}
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => open(p)}>Edit</Button>
                      <Button size="sm" variant="ghost" onClick={() => remove(p)}>Remove</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editing && (
        <Modal
          title={editing.$id ? `Edit ${editing.display_name}` : 'Add someone'}
          onClose={() => setEditing(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
              <Button variant="primary" onClick={save} loading={busy}>
                {!editing.$id && wantsLogin ? 'Add and send invitation' : 'Save'}
              </Button>
            </>
          }
        >
          {error && <div style={{ marginBottom: '1rem' }}><Notice>{error}</Notice></div>}

          <div className="grid-2">
            <Field label="Name">
              <Input value={editing.display_name ?? ''} autoFocus onChange={(e) => setEditing({ ...editing, display_name: e.target.value })} />
            </Field>
            <Field label="Phone" hint="Optional.">
              <Input value={editing.phone ?? ''} onChange={(e) => setEditing({ ...editing, phone: e.target.value })} />
            </Field>
            <Field label="Role" hint="Changing this resets the permissions below to that role's defaults.">
              <Select
                value={editing.role ?? 'waiter'}
                onChange={(e) => {
                  const role = e.target.value as StaffProfile['role'];
                  setEditing({ ...editing, role, ...DEFAULTS[role] });
                }}
              >
                {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
              </Select>
            </Field>
          </div>

          {/*
            Which sides, as a list rather than one choice.

            It used to be a dropdown offering kitchen, craft, or "both", and it
            was shown only where a business ran BOTH of those two — so a place
            with a kitchen and a bar never saw the question at all, and every
            bartender could open the bistro. "Both" is also a two-trade word:
            somebody covering the bar and the kitchen had no way to say so
            without being handed the craft shop as well.

            Still only asked where there is something to choose between. A
            business running one trade has one answer.
          */}
          {runningSides.length > 1 && (
            <Field
              label="Which sides do they work on?"
              hint="Keeps their till and their admin screens to the work they actually do. Somebody on the bar will not see the bistro, or the other way round."
            >
              <div className="row row-wrap" style={{ gap: '1rem' }}>
                {runningSides.map((m) => {
                  const on = (editing.works_in_modules ?? runningSides).includes(m);
                  return (
                    <Toggle
                      key={m}
                      checked={on}
                      label={MODULE_LABELS[m]}
                      onChange={(v) => {
                        const now = new Set(editing.works_in_modules ?? runningSides);
                        if (v) now.add(m); else now.delete(m);
                        setEditing({
                          ...editing,
                          works_in_modules: runningSides.filter((x) => now.has(x)),
                        });
                      }}
                    />
                  );
                })}
              </div>
            </Field>
          )}
          {runningSides.length > 1 && (editing.works_in_modules ?? runningSides).length === 0 && (
            <Notice tone="warn">
              Pick at least one. Somebody who works nowhere has no till to open and no screens to see.
            </Notice>
          )}

          <h3 style={{ margin: '1.1rem 0 0.5rem' }}>How they sign in</h3>
          <Field
            label={editing.$id && editing.pin_hash ? 'Change PIN' : 'PIN'}
            hint="4 to 6 digits. They tap this on the shared terminal or kitchen screen, no email, no password. Leave blank when editing to keep the current one."
          >
            <Input
              value={pin}
              inputMode="numeric"
              maxLength={6}
              placeholder={editing.pin_hash ? '••••' : '4–6 digits'}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
            />
          </Field>
          <Field hint="Only needed for people who use the admin dashboard on their own device. Cooks and waiters do not need one.">
            <Toggle
              checked={wantsLogin}
              disabled={!!editing.$id}
              onChange={setWantsLogin}
              label="Also give them an email login"
            />
          </Field>
          {wantsLogin && (
            <Field
              label="Email"
              hint="A sign-in link goes here and they choose their own password. If it does not arrive, use “Send sign-in link” on their row to send another."
            >
              <Input
                type="email"
                value={editing.email ?? ''}
                disabled={!!editing.$id}
                onChange={(e) => setEditing({ ...editing, email: e.target.value })}
              />
            </Field>
          )}

          <h3 style={{ margin: '1.1rem 0 0.5rem' }}>What they can do</h3>
          <p className="small dim" style={{ marginTop: 0 }}>
            These are per person, not per job title. On a quiet shift the cook is the cashier, so give a cook the till
            permissions if that is how your restaurant runs, the role above only sets the starting point.
          </p>
          <Field hint="Counting the opening float and starting the till.">
            <Toggle
              checked={editing.can_open_shift ?? false}
              onChange={(v) => setEditing({ ...editing, can_open_shift: v })}
              label="Open a shift and the cash drawer"
            />
          </Field>
          <Field hint="Counting the drawer at the end, which is when the day's figures are settled.">
            <Toggle
              checked={editing.can_close_shift ?? false}
              onChange={(v) => setEditing({ ...editing, can_close_shift: v })}
              label="Close a shift and count the drawer"
            />
          </Field>
          <Field hint="Recording that a bill was settled, cash, card or mobile money.">
            <Toggle
              checked={editing.can_mark_paid ?? true}
              onChange={(v) => setEditing({ ...editing, can_mark_paid: v })}
              label="Take payment and mark a bill as paid"
            />
          </Field>
          <Field><Toggle checked={editing.can_void ?? false} onChange={(v) => setEditing({ ...editing, can_void: v })} label="Void an order" /></Field>
          <Field hint="For the shop counter: a chipped piece, a display item, a maker's price for a friend. It changes that sale only, never the price on the item, and every changed line records what it should have cost and who changed it.">
            <Toggle
              checked={editing.can_change_line_price ?? false}
              onChange={(v) => setEditing({ ...editing, can_change_line_price: v })}
              label="Change a price on the till"
            />
          </Field>
          <Field><Toggle checked={editing.can_record_waste ?? true} onChange={(v) => setEditing({ ...editing, can_record_waste: v })} label="Record waste" /></Field>
          <Field hint="Off for everybody but an admin. Archiving already takes something off the board and keeps its recipe, its price and its history; deleting takes all three with it, and nothing afterwards says what used to be there.">
            <Toggle
              checked={editing.can_delete_items ?? false}
              onChange={(v) => setEditing({ ...editing, can_delete_items: v })}
              label="Permanently delete items, drinks and categories"
            />
          </Field>
          <Field hint="Rent, the owner's drawings, legal fees — the categories marked Admin only under Expenses. Admins see them always. Turn this on for somebody who does the books without being an admin; leave it off and those categories never appear on their screen.">
            <Toggle
              checked={editing.role === 'admin' || (editing.can_see_private_expenses ?? false)}
              disabled={editing.role === 'admin'}
              onChange={(v) => setEditing({ ...editing, can_see_private_expenses: v })}
              label="See the admin-only spending categories"
            />
          </Field>
          <Field hint="Holding a box and deciding how much is in it are separate jobs, and keeping them apart is the only real control petty cash has: somebody who could record their own top-ups could cover a shortage on paper and no count would ever find it. Leave this off for the person who holds the tin. Turn it on for whoever actually hands the money over.">
            <Toggle
              checked={editing.role === 'admin' || (editing.can_fund_petty_cash ?? false)}
              disabled={editing.role === 'admin'}
              onChange={(v) => setEditing({ ...editing, can_fund_petty_cash: v })}
              label="Put money into petty cash boxes, and set them up"
            />
          </Field>

          <Field label="Discount they can give without a manager (%)" hint="0 means every discount needs approval.">
            <Input
              type="number"
              min={0}
              max={100}
              value={(editing.can_discount_up_to_bp ?? 0) / 100}
              onChange={(e) => setEditing({ ...editing, can_discount_up_to_bp: Math.round(Number(e.target.value) * 100) })}
            />
          </Field>

          {venues.length > 1 && (
            <Field label="Venues" hint="Leave all unticked for access to every venue.">
              <div className="stack" style={{ gap: '0.35rem' }}>
                {venues.map((v) => (
                  <Toggle
                    key={v.$id}
                    checked={(editing.venue_ids ?? []).includes(v.$id)}
                    onChange={(on) =>
                      setEditing({
                        ...editing,
                        venue_ids: on
                          ? [...(editing.venue_ids ?? []), v.$id]
                          : (editing.venue_ids ?? []).filter((x) => x !== v.$id),
                      })
                    }
                    label={v.name}
                  />
                ))}
              </div>
            </Field>
          )}

          {editing.$id && (
            <Field>
              <Toggle checked={editing.active ?? true} onChange={(v) => setEditing({ ...editing, active: v })} label="Active" />
              <span className="hint">
                Turn this off when someone leaves. Better than deleting them, their history stays attributable.
              </span>
            </Field>
          )}
        </Modal>
      )}
    </>
  );
}
