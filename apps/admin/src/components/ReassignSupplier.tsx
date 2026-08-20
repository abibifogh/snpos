import { useEffect, useState } from 'react';
import { Button, Field, Input, Modal, Notice, Spinner } from '@snpos/ui';
import { db, DB_ID, ID, listAll, humanError } from '../lib';
import {
  REASSIGN_MODES, describeReassign, reassignProblem, movesHistory, needsSplit,
  dayStartIso, dayEndIso, Query,
} from '@snpos/core';
import type { ReassignMode, Consignor, MenuItem, Doc } from '@snpos/core';

interface LedgerRow extends Doc { consignor_id?: string; payout_id?: string; entry_at?: string }
interface MoveRow extends Doc { consignor_id?: string }

/**
 * Moving a product to a different supplier.
 *
 * A shop buys the same thing from Ama for a year and then from Kofi. Changing
 * the field alone answers, silently and always the same way, a question with
 * four answers — and the one it picks is rarely the one wanted.
 *
 * So it asks, and it says what each answer will actually do to these two
 * people's statements, with the real counts read from the database. "23
 * records will be updated" tells nobody whether their supplier is about to be
 * paid for a year of somebody else's baskets.
 *
 * The work happens on the server. The consignor ledger has no write permission
 * for anybody at all, deliberately, because it is what a maker is paid from —
 * so this writes a request and waits for it.
 */
export function ReassignSupplier({
  item, fromId, toId, consignors, userId, onClose, onDone,
}: {
  item: MenuItem;
  fromId: string;
  toId: string;
  consignors: Consignor[];
  userId: string;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [mode, setMode] = useState<ReassignMode>('future_and_stock');
  const today = new Date().toLocaleDateString('en-CA');
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [counts, setCounts] = useState<{ entries: number; paidOut: number; moves: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameOf = (id: string) => consignors.find((c) => c.$id === id)?.name ?? 'nobody';
  const names = { from: nameOf(fromId), to: nameOf(toId) };

  /*
    What is actually there, read once.

    Only for this product and only the old supplier's, which is all any of the
    four modes can touch. Without the real numbers the choice is made blind:
    "everything from the beginning" means one thing on a piece sold twice and
    quite another on one sold four hundred times.
  */
  useEffect(() => {
    (async () => {
      const [entries, moves] = await Promise.all([
        listAll<LedgerRow>('consignor_ledger', [Query.equal('menu_item_id', item.$id)]).catch(() => []),
        listAll<MoveRow>('product_moves', [Query.equal('menu_item_id', item.$id)]).catch(() => []),
      ]);
      const theirs = entries.filter((e) => (e.consignor_id ?? '') === fromId);
      setCounts({
        entries: theirs.filter((e) => !(e.payout_id ?? '').trim()).length,
        paidOut: theirs.filter((e) => (e.payout_id ?? '').trim()).length,
        moves: moves.filter((m) => (m.consignor_id ?? '') === fromId).length,
      });
    })();
  }, [item.$id, fromId]);

  const problem = reassignProblem({ fromId, toId, mode, from, to });

  const apply = async () => {
    if (problem) { setError(problem); return; }
    setBusy(true);
    setError(null);
    try {
      const request = await db.createDocument(DB_ID, 'consignor_reassignments', ID.unique(), {
        venue_id: 'main',
        menu_item_id: item.$id,
        from_consignor_id: fromId,
        to_consignor_id: toId,
        mode,
        ...(mode === 'period' ? { from_at: dayStartIso(from), to_at: dayEndIso(to) } : {}),
        requested_at: new Date().toISOString(),
        requested_by: userId,
        status: 'requested',
      });

      /*
        Wait for the server, because nothing on screen is true until it has
        run. Ten seconds, then carry on: an admin should not be trapped on a
        dialog by a slow function, and what happened is written on the request
        either way.
      */
      let note = '';
      for (let i = 0; i < 20; i += 1) {
        await new Promise((r) => { setTimeout(r, 500); });
        const row = await db.getDocument(DB_ID, 'consignor_reassignments', request.$id)
          .catch(() => null) as { status?: string; note?: string } | null;
        if (row?.status === 'done' || row?.status === 'failed') { note = row.note ?? ''; break; }
      }
      onDone(note || `${item.name} moved to ${names.to}.`);
    } catch (e) {
      setError(humanError(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      wide
      title={`Who does "${item.name}" belong to?`}
      onClose={busy ? () => undefined : onClose}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Leave it as it was</Button>
          <Button variant="primary" onClick={() => void apply()} loading={busy} disabled={!!problem}>
            Move it to {names.to}
          </Button>
        </>
      )}
    >
      {error && <div style={{ marginBottom: '1rem' }}><Notice>{error}</Notice></div>}

      <p className="small dim" style={{ marginTop: 0 }}>
        Moving <strong>{item.name}</strong> from <strong>{names.from}</strong> to <strong>{names.to}</strong>.
        {' '}What should happen to what is already recorded?
      </p>

      {counts === null ? <Spinner /> : (
        <div className="stack" style={{ gap: '0.5rem' }}>
          {REASSIGN_MODES.map((m) => (
            /* The whole card is the choice, not a radio somebody has to hit.
               And each one says what it will do to THESE two statements, with
               the real numbers, because the difference between the four is
               entirely in what they leave behind. */
            <label
              key={m.value}
              className={mode === m.value ? 'choice on' : 'choice'}
            >
              <input
                type="radio"
                name="reassign-mode"
                checked={mode === m.value}
                onChange={() => setMode(m.value)}
              />
              <div>
                <div className="choice-title">{m.label}</div>
                <div className="small dim">{m.help}</div>
                {mode === m.value && (
                  <div className="small" style={{ marginTop: '0.4rem', fontWeight: 550 }}>
                    {describeReassign(m.value, names, {
                      entries: counts.entries,
                      paidOut: counts.paidOut,
                      moves: counts.moves,
                      onHand: item.on_hand ?? 0,
                    })}
                  </div>
                )}
              </div>
            </label>
          ))}
        </div>
      )}

      {mode === 'period' && (
        <div className="grid-2" style={{ marginTop: '0.8rem' }}>
          <Field label="From" hint="The whole of this day is included.">
            <Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To" hint="And the whole of this one.">
            <Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
      )}

      {/* Said before it happens, not discovered afterwards on a statement. */}
      {counts !== null && movesHistory(mode) && counts.paidOut > 0 && (
        <div style={{ marginTop: '0.8rem' }}>
          <Notice tone="warn">
            {counts.paidOut} entr{counts.paidOut === 1 ? 'y has' : 'ies have'} already been paid out to{' '}
            {names.from} and cannot move. A payout points at{' '}
            {counts.paidOut === 1 ? 'it' : 'them'}, so moving{' '}
            {counts.paidOut === 1 ? 'it' : 'them'} would leave real money sitting against a sale that is no
            longer on the statement it was paid from.
          </Notice>
        </div>
      )}

      {needsSplit(mode) && (
        <div style={{ marginTop: '0.8rem' }}>
          <Notice>
            This leaves two products called <strong>{item.name}</strong> on the shelf, one for each supplier.
            That is the only way both can be paid correctly for what they actually brought.
          </Notice>
        </div>
      )}
    </Modal>
  );
}
