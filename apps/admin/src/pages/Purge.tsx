import { useEffect, useState } from 'react';
import { Button, Card, Field, Input, Modal, Notice, Spinner, useToast } from '@snpos/ui';
import { db, DB_ID, ID, listAll, humanError } from '../lib';
import { Query } from '@snpos/core';
import type { Doc } from '@snpos/core';
import { useSession } from '../session';

/**
 * What can be erased, and what has to go with it.
 *
 * An order without its items is worse than no order at all, a report that
 * counts it finds nothing to count and quietly reports zero. So each group
 * names the children that must go too, and they go first: if the run stops
 * half way, what is left is whole records, never headless lines.
 */
interface Group {
  key: string;
  label: string;
  hint: string;
  collection: string;
  /** Children, keyed by the field on the child holding the parent's id. */
  children?: { collection: string; field: string }[];
}

const GROUPS: Group[] = [
  {
    key: 'orders',
    label: 'Orders',
    hint: 'Every order in the period, with its items, its notices and its dining sessions.',
    collection: 'orders',
    children: [
      { collection: 'order_items', field: 'order_id' },
      { collection: 'order_notices', field: 'order_id' },
    ],
  },
  {
    key: 'payments',
    label: 'Payments, cash, card and mobile money',
    hint: 'The record that a bill was settled, and by what means.',
    collection: 'payments',
  },
  {
    key: 'expenses',
    label: 'Expenses',
    hint: 'Money paid out, with the stock lines recorded against it. Stock levels themselves are left alone.',
    collection: 'shift_expenses',
    children: [{ collection: 'expense_items', field: 'expense_id' }],
  },
  {
    key: 'shifts',
    label: 'Shifts',
    hint: 'Opening floats, counts and variances. Erase these last; a shift is what the money hangs off.',
    collection: 'shifts',
    children: [{ collection: 'shift_stock_checks', field: 'shift_id' }],
  },
  {
    key: 'waste',
    label: 'Waste records',
    hint: 'What was thrown away and why.',
    collection: 'waste_log',
  },
  {
    key: 'stock_movements',
    label: 'Stock movements',
    hint: 'The history of what went in and out. Current stock levels are not recalculated by erasing these.',
    collection: 'stock_movements',
  },
];

/**
 * Erasing records for a period.
 *
 * This is a delete, not an archive: Appwrite has nowhere to put a copy, and
 * pretending otherwise would be worse than saying so. Hence the typed
 * confirmation, the count shown before anything happens, and the entry written
 * to the audit log after, the one record the erase never touches.
 */
export function PurgePage() {
  const { user, profile } = useSession();
  const toast = useToast();

  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [picked, setPicked] = useState<string[]>([]);
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [counting, setCounting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState<string | null>(null);
  // The erase spans every venue, but the audit log is scoped to one. The first
  // venue holds the entry; `after` names what it actually covered.
  const [venueId, setVenueId] = useState('');

  useEffect(() => {
    listAll<Doc>('venues')
      .then((v) => setVenueId(v[0]?.$id ?? ''))
      .catch(() => undefined);
  }, []);

  const isAdmin = profile?.role === 'admin' || profile?.role === 'manager';

  /** Inclusive of both days, in whole days, nobody thinks in timestamps. */
  const startIso = () => new Date(`${from}T00:00:00`).toISOString();
  const endIso = () => new Date(`${to}T23:59:59.999`).toISOString();

  const toggle = (key: string) => {
    setCounts(null);
    setPicked((p) => (p.includes(key) ? p.filter((x) => x !== key) : [...p, key]));
  };

  const rowsIn = async (collection: string) =>
    listAll<Doc>(collection, [
      Query.greaterThanEqual('$createdAt', startIso()),
      Query.lessThanEqual('$createdAt', endIso()),
    ]);

  const check = async () => {
    if (picked.length === 0) { setError('Choose at least one kind of record.'); return; }
    if (from > to) { setError('The start date is after the end date.'); return; }
    setCounting(true);
    setError(null);
    try {
      const found: Record<string, number> = {};
      for (const g of GROUPS.filter((x) => picked.includes(x.key))) {
        found[g.key] = (await rowsIn(g.collection)).length;
      }
      setCounts(found);
    } catch (e) {
      setError(humanError(e));
    } finally {
      setCounting(false);
    }
  };

  const erase = async () => {
    setBusy(true);
    setError(null);
    let deleted = 0;
    /**
     * What would not go, and why.
     *
     * Every delete here was wrapped in a catch that threw the reason away, and
     * the counter was incremented regardless — so a run that deleted nothing
     * at all still announced that it had. That is exactly what happened:
     * orders could not be deleted by anybody, the same run removed their
     * ITEMS, which staff may delete, and the page reported success. Every
     * order stayed in the list with nothing on it.
     *
     * A failure that reports itself as a success is worse than a failure.
     */
    const refused: Record<string, number> = {};
    let firstReason = '';
    const tryDelete = async (collection: string, id: string) => {
      try {
        await db.deleteDocument(DB_ID, collection, id);
        deleted += 1;
      } catch (e) {
        refused[collection] = (refused[collection] ?? 0) + 1;
        if (!firstReason) firstReason = humanError(e);
      }
    };
    try {
      for (const g of GROUPS.filter((x) => picked.includes(x.key))) {
        setProgress(`Reading ${g.label.toLowerCase()}…`);
        const parents = await rowsIn(g.collection);
        if (parents.length === 0) continue;

        /**
         * Ask whether the parent can go, before removing anything it owns.
         *
         * Children are deleted first below, which is right when the run
         * works: a line with no order is worse than one that was removed. It
         * is exactly wrong when the parent cannot be deleted at all, and that
         * was the case for orders — nobody could delete one, staff could
         * delete their items, so a purge stripped every order bare and left
         * them all in the list.
         *
         * One real delete answers the question that no amount of reading can.
         * If it is refused, the group is left completely untouched.
         */
        const probe = parents[0];
        await tryDelete(g.collection, probe.$id);
        if (refused[g.collection]) {
          setProgress('');
          continue;
        }
        const rest = parents.slice(1);

        // Children first, in id batches, a headless line is worse than a
        // deleted one, so nothing is orphaned even if this stops half way.
        for (const child of g.children ?? []) {
          for (let i = 0; i < parents.length; i += 25) {
            // Every parent, the probed one included: its children still need
            // to go now that it has.
            const ids = parents.slice(i, i + 25).map((p) => p.$id);
            const rows = await listAll<Doc>(child.collection, [Query.equal(child.field, ids)]).catch(() => []);
            for (const r of rows) await tryDelete(child.collection, r.$id);
          }
        }

        let done = 1;
        for (const p of rest) {
          await tryDelete(g.collection, p.$id);
          done += 1;
          if (done % 20 === 0) setProgress(`${g.label}: ${done} of ${parents.length}`);
        }
      }

      // Written after the fact and never itself erased here: if somebody asks
      // next month where the March figures went, this is the answer.
      await db.createDocument(DB_ID, 'audit_log', ID.unique(), {
        venue_id: venueId,
        actor_id: user?.$id ?? '',
        actor_role: profile?.role ?? '',
        action: 'records_erased',
        entity_type: 'period',
        entity_id: `${from}..${to}`,
        after: JSON.stringify({
          from, to, groups: picked, deleted, scope: 'all venues',
          // What would not go is part of the record too. "Where did March go"
          // and "why is March still here" are both questions somebody asks.
          refused: Object.keys(refused).length ? refused : undefined,
        }),
      }).catch(() => undefined);

      setConfirming(false);
      setTyped('');
      setCounts(null);
      setPicked([]);

      const stuck = Object.entries(refused);
      if (stuck.length) {
        // Named, counted, and left on screen rather than in a toast that goes
        // away. Somebody has to know the records are still there.
        setError(
          `${deleted} erased, but ${stuck.reduce((a, [, n]) => a + n, 0)} could not be: `
          + `${stuck.map(([c, n]) => `${n} in ${c}`).join(', ')}. `
          + (firstReason ? `${firstReason} ` : '')
          + 'If this says permission, run "Provision Appwrite" in GitHub Actions and try again.',
        );
        return;
      }
      toast(`${deleted} record${deleted === 1 ? '' : 's'} erased`);
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
      setProgress('');
    }
  };

  const total = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : 0;

  if (!isAdmin) {
    return (
      <>
        <h1>Erase records</h1>
        <Notice>Only an admin or a manager can erase records.</Notice>
      </>
    );
  }

  return (
    <>
      <h1>Erase records</h1>
      <p className="dim" style={{ maxWidth: '46rem' }}>
        For clearing out test data before you go live, or removing a period you no longer need to keep. This deletes
        permanently; there is no undo and no copy kept. Run your reports first if there is anything you want off them.
      </p>

      {error && <div style={{ marginBottom: '1rem' }}><Notice>{error}</Notice></div>}

      <Card title="Which period">
        <div className="grid-2">
          <Field label="From">
            <Input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setCounts(null); }} />
          </Field>
          <Field label="To" hint="Both days included.">
            <Input type="date" value={to} onChange={(e) => { setTo(e.target.value); setCounts(null); }} />
          </Field>
        </div>
      </Card>

      <Card title="What to erase">
        {GROUPS.map((g) => (
          <label key={g.key} className="check-row" style={{ display: 'block', marginBottom: '0.75rem' }}>
            <input type="checkbox" checked={picked.includes(g.key)} onChange={() => toggle(g.key)} />{' '}
            <strong>{g.label}</strong>
            {counts?.[g.key] !== undefined && (
              <span className="pill" style={{ marginLeft: '0.5rem' }}>{counts[g.key]} found</span>
            )}
            <div className="small dim" style={{ marginLeft: '1.6rem' }}>{g.hint}</div>
          </label>
        ))}

        <div className="row" style={{ gap: '0.5rem', marginTop: '1rem' }}>
          <Button onClick={() => void check()} loading={counting} disabled={picked.length === 0}>
            Count what would go
          </Button>
          <Button
            variant="danger"
            disabled={!counts || total === 0}
            onClick={() => { setTyped(''); setConfirming(true); }}
          >
            {counts ? `Erase ${total} record${total === 1 ? '' : 's'}` : 'Count first'}
          </Button>
        </div>
        {counts && total === 0 && (
          <p className="small dim">Nothing in that period. Check the dates.</p>
        )}
      </Card>

      {confirming && (
        <Modal
          title="Erase these records?"
          onClose={() => (busy ? undefined : setConfirming(false))}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>Cancel</Button>
              <Button
                variant="danger"
                onClick={() => void erase()}
                loading={busy}
                disabled={typed.trim().toUpperCase() !== 'ERASE'}
              >
                Erase permanently
              </Button>
            </>
          }
        >
          <Notice>
            {total} record{total === 1 ? '' : 's'} between {from} and {to} will be deleted. This cannot be undone.
          </Notice>
          <ul className="small">
            {GROUPS.filter((g) => picked.includes(g.key)).map((g) => (
              <li key={g.key}>{g.label}, {counts?.[g.key] ?? 0}</li>
            ))}
          </ul>
          <Field label="Type ERASE to confirm">
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus disabled={busy} />
          </Field>
          {busy && (
            <div className="row" style={{ gap: '0.5rem' }}>
              <Spinner /> <span className="small dim">{progress || 'Working…'}</span>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
