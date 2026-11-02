import { useEffect, useMemo, useState } from 'react';
import {
  loadAskList, fileStockRequest, recentRequests, askProblem, qtyWords, leftWords, buyWord,
  requestStage, STAGE_WORDS, dateTimeWords,
} from '@snpos/core';
import type { AskLine, AskList, AskSide, RequestStage, StockRequest } from '@snpos/core';
import { Button, FormError, Input, Spinner, Textarea } from './components';

/**
 * "Need stock", on the kitchen screen and the bar's till.
 *
 * Opens on what this side is running low on, each already set to bring it
 * back to its full level in the packs it comes in, so the cook only changes
 * what is wrong. What is already ordered or asked for is shown and cannot be
 * asked for twice. Anything else on the side's list can be searched and
 * added, and a note covers what is not on it. No prices, ever: this is
 * asking, and whoever orders stock decides on Approvals. See stock-requests.ts.
 */
type Who = { id?: string; name?: string };

type Line = AskLine & { on: boolean; added?: boolean };

export function NeedStock({ side, venueId, who, lowBp, onClose, onSent }: {
  side: AskSide;
  venueId: string;
  who: Who;
  /** The business's default low line, settings.low_stock_default_bp. */
  lowBp?: number;
  onClose: () => void;
  onSent: (words: string) => void;
}) {
  const [tab, setTab] = useState<'ask' | 'past'>('ask');
  const [list, setList] = useState<AskList | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [note, setNote] = useState('');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    loadAskList(venueId, side, lowBp)
      .then((l) => {
        if (!live) return;
        setList(l);
        setLines(l.low.map((x) => ({ ...x, on: true })));
      })
      .catch(() => { if (live) setError('The stock list could not be read. Check the connection and open this again.'); });
    return () => { live = false; };
  }, [venueId, side, lowBp]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const picked = lines.filter((l) => l.on && l.qty > 0);
  const q = query.trim().toLowerCase();
  const more = useMemo(
    () => (list?.others ?? [])
      .filter((o) => !lines.some((l) => l.ingredient_id === o.ingredient_id))
      .filter((o) => !q || o.name.toLowerCase().includes(q))
      .slice(0, q ? 24 : 12),
    [list, lines, q],
  );

  const change = (id: string, f: (l: Line) => Line) => setLines((ls) => ls.map((l) => (l.ingredient_id === id ? f(l) : l)));
  const add = (o: AskLine) => { setLines((ls) => [...ls, { ...o, on: true, added: true }]); setQuery(''); };

  const send = async () => {
    const problem = askProblem(picked, note);
    if (problem) { setError(problem); return; }
    setBusy(true);
    setError(null);
    try {
      await fileStockRequest({
        venueId, side, note, byId: who.id, byName: who.name,
        lines: picked.map(({ on: _on, added: _added, ...l }) => l),
      });
      onSent(`Sent to the managers: ${picked.length} item${picked.length === 1 ? '' : 's'}${note.trim() ? ' and your note' : ''}. It is on Approvals now.`);
    } catch {
      setError('It could not be sent. Check the connection and try again; nothing has been lost.');
      setBusy(false);
    }
  };

  const row = (l: Line) => {
    const pct = l.full > 0 ? Math.max(0, Math.min(100, (l.left / l.full) * 100)) : 0;
    return (
      <div key={l.ingredient_id} className={`ask-line${l.on ? '' : ' off'}`}>
        <button
          type="button"
          className="ask-tick"
          role="checkbox"
          aria-checked={l.on}
          aria-label={`Ask for ${l.name}`}
          onClick={() => change(l.ingredient_id, (x) => ({ ...x, on: !x.on }))}
        >
          {l.on && <Check />}
        </button>
        <div className="ask-what">
          <b>{l.name}</b>
          <small>{leftWords(l)}{l.added ? ' · added by you' : ''}</small>
          {l.full > 0 && <span className="ask-meter" aria-hidden="true"><i style={{ width: `${pct}%` }} /></span>}
        </div>
        <div className="ask-step" aria-label={`How many ${l.buy_label}`}>
          <button type="button" aria-label="One fewer" onClick={() => change(l.ingredient_id, (x) => ({ ...x, qty: Math.max(1, x.qty - 1) }))}>−</button>
          <output>{l.qty} {buyWord(l, l.qty)}</output>
          <button type="button" aria-label="One more" onClick={() => change(l.ingredient_id, (x) => ({ ...x, qty: x.qty + 1, on: true }))}>+</button>
        </div>
      </div>
    );
  };

  return (
    <div className="ask-scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ask-sheet" role="dialog" aria-modal="true" aria-label="Need stock">
        <div className="ask-top">
          <h1>Need stock</h1>
          <button type="button" className="ask-x" aria-label="Close" onClick={onClose}>×</button>
        </div>
        <div className="view-tabs ask-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'ask'} className={tab === 'ask' ? 'on' : ''} onClick={() => setTab('ask')}>Ask</button>
          <button type="button" role="tab" aria-selected={tab === 'past'} className={tab === 'past' ? 'on' : ''} onClick={() => setTab('past')}>Asked before</button>
        </div>
        <div className="ask-body">
          {tab === 'past' ? <AskedBefore side={side} venueId={venueId} /> : !list ? (error ? <FormError message={error} /> : <Spinner />) : (
            <>
              {/* Nothing marked yet: a manager chooses what this side may ask for, on Stock. */}
              {list.marked === 0 && (
                <p className="ask-empty">
                  Nothing has been put on the {side}&apos;s Need stock list yet. A manager chooses what can be asked for,
                  on the Stock page in the admin. Until then, write what you need in the note below.
                </p>
              )}
              {list.marked > 0 && (<>
              <section className="ask-group">
                <div className="ask-h"><h2>Running low</h2><span>of {list.marked} on the {side}&apos;s list</span></div>
                {lines.filter((l) => !l.added).map(row)}
                {list.held.map((h) => (
                  <div key={h.ingredient_id} className="ask-line held">
                    <span className="ask-tick" aria-hidden="true" style={{ visibility: 'hidden' }} />
                    <div className="ask-what"><b>{h.name}</b><small>{leftWords(h)}</small></div>
                    <span className="ask-pill">{h.why}</span>
                  </div>
                ))}
                {list.low.length + list.held.length === 0 && (
                  <p className="ask-empty">Nothing on the {side}&apos;s list is running low. Add anything you need below.</p>
                )}
              </section>
              {lines.some((l) => l.added) && (
                <section className="ask-group">
                  <div className="ask-h"><h2>Also asking for</h2></div>
                  {lines.filter((l) => l.added).map(row)}
                </section>
              )}
              <section className="ask-group">
                <div className="ask-h"><h2>Something else</h2><span>from the {side}&apos;s list</span></div>
                <Input type="search" value={query} placeholder="Search the stock list" aria-label="Search the stock list" onChange={(e) => setQuery(e.target.value)} />
                <div className="ask-chips">
                  {more.map((o) => <button key={o.ingredient_id} type="button" className="chip" onClick={() => add(o)}>+ {o.name}</button>)}
                  {more.length === 0 && <span className="ask-empty">{q ? 'Nothing else matches.' : 'Everything on the list is above.'}</span>}
                </div>
              </section>
              </>)}
              <section className="ask-group">
                <div className="ask-h"><h2>Not on the list?</h2><span>a note for the manager</span></div>
                <Textarea rows={2} value={note} aria-label="Note for the manager" placeholder="For example: the pepper sauce bottles are nearly gone." onChange={(e) => setNote(e.target.value)} />
              </section>
            </>
          )}
        </div>
        {tab === 'ask' && list && (
          <div className="ask-foot">
            <span className="ask-who">Asking as <b>{who.name || 'this screen'}</b></span>
            {error && <FormError message={error} />}
            <Button variant="primary" className="ask-go" loading={busy} disabled={picked.length === 0 && !note.trim()} onClick={() => void send()}>
              {picked.length > 0 ? `Send ${picked.length} to the managers` : 'Send the note to the managers'}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/** This side's recent requests, and where each has got to. */
function AskedBefore({ side, venueId }: { side: AskSide; venueId: string }) {
  const [got, setGot] = useState<{ requests: StockRequest[]; orders: { $id: string; status?: string }[] } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    recentRequests(venueId, side).then(setGot).catch(() => setFailed(true));
  }, [venueId, side]);
  if (failed) return <p className="ask-empty">The list could not be read. Check the connection.</p>;
  if (!got) return <Spinner />;
  if (got.requests.length === 0) return <p className="ask-empty">Nothing asked for yet from the {side}.</p>;
  const steps: RequestStage[] = ['asked', 'ordered', 'arrived'];
  return (
    <div className="ask-group">
      {got.requests.map((r) => {
        const stage = requestStage(r, got.orders);
        const at = steps.indexOf(stage);
        return (
          <div key={r.$id} className="ask-req">
            <div className="ask-req-top"><b>{r.by_name || 'Somebody'}</b><span>{r.$createdAt ? dateTimeWords(r.$createdAt) : ''}</span></div>
            <p>{r.lines.map((l) => `${l.name}, ${qtyWords(l)}`).join(' · ') || '(a note only)'}</p>
            {(r.note ?? '').trim() && <p className="ask-note">“{r.note}”</p>}
            <div className="ask-trail">
              {stage === 'declined' ? (
                <><span className="past">Asked</span><span className="no">{STAGE_WORDS.declined}</span></>
              ) : steps.map((s, i) => (
                <span key={s} className={i < at ? 'past' : i === at ? 'on' : ''}>{STAGE_WORDS[s]}</span>
              ))}
            </div>
            {r.status === 'declined' && r.decided_note && (
              <p><b>{r.decided_by_name || 'Manager'}:</b> {r.decided_note}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

const Check = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 8.5l3.2 3L13 4.5" />
  </svg>
);

/**
 * How many things this side is running low on and could still ask for, for
 * the button's badge. Read when the screen opens and every ten minutes; a
 * failed read shows no number rather than a wrong one.
 */
export function useLowCount(side: AskSide, venueId: string | undefined, enabled: boolean, lowBp?: number) {
  const [n, setN] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled || !venueId) { setN(null); return undefined; }
    let live = true;
    loadAskList(venueId, side, lowBp).then((l) => { if (live) setN(l.low.length); }).catch(() => { if (live) setN(null); });
    const t = window.setInterval(() => setTick((x) => x + 1), 600_000);
    return () => { live = false; window.clearInterval(t); };
  }, [side, venueId, enabled, lowBp, tick]);
  return { low: n, recheck: () => setTick((x) => x + 1) };
}
