import { useEffect, useMemo, useState } from 'react';
import {
  loadRoutine, filedToday, fileClean, listFor, byArea, cleanProgress, deepToday, readTemp, tempOut,
  uploadFile, cleanDay, DAY_NAMES, isoDay,
} from '@snpos/core';
import type { CleanAnswer, CleanItem, CleanKind, CleanRoutine, CleanSide, Settings } from '@snpos/core';
import { Button, FormError, Textarea } from './components';

/**
 * The cleaning list on the kitchen screen and the bar till.
 *
 * Opening: it stands in front of the screen until the required checks are
 * done, when the admin chose to hold service for it; a cook who must start
 * anyway gives a reason, and the reason goes to Approvals. Closing: it comes
 * before the shift is closed. Every tick says who and when, and is kept.
 *
 * Ticks are kept on the device while the list is open, so a screen that
 * reloads halfway through does not send anybody back to the start.
 */
type Who = { id?: string; name?: string };

const draftKey = (side: CleanSide, kind: CleanKind, d: Date) => `snpos-clean:${side}:${kind}:${cleanDay(d)}`;
type Draft = Record<string, { done: boolean; at?: string; text?: string; photoId?: string }>;

function readDraft(key: string): Draft {
  try { return JSON.parse(window.localStorage.getItem(key) || '{}') as Draft; } catch { return {}; }
}
function writeDraft(key: string, d: Draft) {
  try { window.localStorage.setItem(key, JSON.stringify(d)); } catch { /* a private window forgets; fine */ }
}
function clearDraft(key: string) {
  try { window.localStorage.removeItem(key); } catch { /* nothing kept */ }
}

const REASONS = ['Short-staffed today', 'Delivery came early', 'Done, but not ticked', 'Something else'];

export function CleanChecklist({
  routine, kind, venueId, shiftId, who, settings, onFiled, onBack,
}: {
  routine: CleanRoutine;
  kind: CleanKind;
  venueId: string;
  shiftId?: string;
  who: Who;
  settings: Settings | null;
  /** Filed: carry on. `skipped` says it went with a reason. */
  onFiled: (r: { review: boolean; skipped: boolean }) => void;
  /** Closing only: go back without filing anything. */
  onBack?: () => void;
}) {
  const now = useMemo(() => new Date(), []);
  const key = draftKey(routine.side, kind, now);
  const items = useMemo(() => listFor(routine, kind, now), [routine, kind, now]);
  const deep = deepToday(routine, kind, now);
  const [draft, setDraft] = useState<Draft>(() => readDraft(key));
  const [skipping, setSkipping] = useState(false);
  const [reason, setReason] = useState('');
  const [other, setOther] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const put = (id: string, v: Draft[string] | null) => setDraft((d) => {
    const next = { ...d };
    if (v) next[id] = v; else delete next[id];
    writeDraft(key, next);
    return next;
  });
  const stamp = () => new Date().toISOString();

  const answers: CleanAnswer[] = items.map((i) => {
    const d = draft[i.id];
    const value = i.kind === 'temp' && d?.text !== undefined ? readTemp(d.text) : null;
    return {
      id: i.id, text: i.text, area: i.area, required: i.required, kind: i.kind,
      done: i.kind === 'temp' ? value !== null : i.kind === 'photo' ? !!d?.photoId : !!d?.done,
      ...(d?.at ? { at: d.at } : {}),
      ...(value !== null ? { value, out: tempOut(i, value) } : {}),
      ...(d?.photoId ? { photoId: d.photoId } : {}),
      ...((i as { deep?: boolean }).deep ? { deep: true } : {}),
    };
  });
  const p = cleanProgress(answers);
  const held = routine.hold === 'hold';
  const ready = !held || p.requiredLeft === 0;

  const file = async (skipReason?: string) => {
    setBusy('file');
    setError(null);
    try {
      const r = await fileClean({
        venueId, side: routine.side, kind, answers, deep, shiftId, byId: who.id, byName: who.name, skipReason, now: new Date(),
      });
      clearDraft(key);
      onFiled({ review: r.review, skipped: !!skipReason });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The list could not be saved. Try again.');
    } finally {
      setBusy(null);
    }
  };

  const addPhoto = async (item: CleanItem, f: File | undefined) => {
    if (!f) return;
    setBusy(item.id);
    setError(null);
    try {
      const { fileId } = await uploadFile(f, 'receipt', settings);
      put(item.id, { done: true, at: stamp(), photoId: fileId });
    } catch {
      setError('The photo could not be uploaded. Check the connection and try again.');
    } finally {
      setBusy(null);
    }
  };

  const r = 52;
  const c = 2 * Math.PI * r;
  const title = kind === 'open' ? 'Before service' : 'Closing clean';
  const sideWord = routine.side === 'bar' ? 'Bar' : 'Kitchen';
  const reasonText = reason === 'Something else' ? other.trim() : reason;

  return (
    <div className="clean" role="dialog" aria-modal="true" aria-label={`${sideWord} ${title.toLowerCase()}`}>
      <div className="clean-top">
        <h1>{title}</h1>
        <span className={`badge ${deep ? 'badge-brand' : ''}`}>
          {sideWord} · {DAY_NAMES[isoDay(now)]}{deep ? ' · deep clean' : ''}
        </span>
      </div>
      <div className="clean-body">
        <aside className="clean-side">
          <div className="clean-ring-card">
            <svg className={`clean-ring${p.done === p.of ? ' all' : ''}`} viewBox="0 0 132 132" role="img" aria-label={`${p.done} of ${p.of} done`}>
              <circle className="bg" cx="66" cy="66" r={r} />
              <circle className="fg" cx="66" cy="66" r={r} strokeDasharray={c} strokeDashoffset={c * (1 - p.done / Math.max(1, p.of))} transform="rotate(-90 66 66)" />
              <text x="66" y="70" textAnchor="middle">{p.done}/{p.of}</text>
              <text className="sub" x="66" y="90" textAnchor="middle">DONE</text>
            </svg>
            <strong>
              {p.requiredLeft === 0 ? 'Every required check done' : `${p.requiredLeft} required check${p.requiredLeft === 1 ? '' : 's'} left`}
            </strong>
            {p.outOfRange > 0 && (
              <span className="badge badge-late">
                {p.outOfRange} reading{p.outOfRange === 1 ? '' : 's'} outside the safe range
              </span>
            )}
          </div>
          {who.name && (
            <div className="clean-who">
              <span className="clean-av" aria-hidden="true">{who.name.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase()}</span>
              <span><strong>{who.name}</strong><span className="small dim" style={{ display: 'block' }}>Each tick is recorded against you</span></span>
            </div>
          )}
          <FormError message={error} />
          <Button variant="primary" className="clean-go" disabled={!ready} loading={busy === 'file' && !skipping} onClick={() => void file()}>
            {kind === 'open' ? 'Start service →' : 'Done, close up →'}
          </Button>
          {held && p.requiredLeft > 0 && (
            <>
              <Button variant="ghost" onClick={() => { setSkipping(true); setReason(''); }}>
                {kind === 'open' ? 'Start without finishing…' : 'Close without finishing…'}
              </Button>
              <p className="small dim" style={{ textAlign: 'center', margin: 0 }}>This asks for a reason, and a manager sees it on Approvals.</p>
            </>
          )}
          {!held && p.requiredLeft > 0 && (
            <p className="small dim" style={{ textAlign: 'center', margin: 0 }}>Checks left undone go to Approvals for a manager to see.</p>
          )}
          {onBack && <Button variant="ghost" onClick={onBack}>Back</Button>}
        </aside>

        <div className="clean-groups">
          {byArea(items).map(([area, list], gi) => {
            const n = list.filter((i) => answers.find((a) => a.id === i.id)?.done).length;
            const isDeep = list.every((i) => (i as { deep?: boolean }).deep);
            return (
              <section key={area} className={`clean-group${isDeep ? ' deep' : ''}`} style={{ animationDelay: `${gi * 40}ms` }}>
                <header>
                  <h2>{area}</h2>
                  {isDeep && <span className="badge badge-brand">Once a week</span>}
                  <span className="clean-count">{n}/{list.length}</span>
                </header>
                {list.map((i) => {
                  const a = answers.find((x) => x.id === i.id)!;
                  const d = draft[i.id];
                  const tick = () => put(i.id, d?.done ? null : { done: true, at: stamp() });
                  return (
                    <div
                      key={i.id}
                      className={`clean-item${a.done ? ' on' : ''}`}
                      role={i.kind === 'tick' ? 'checkbox' : undefined}
                      aria-checked={i.kind === 'tick' ? a.done : undefined}
                      tabIndex={i.kind === 'tick' ? 0 : undefined}
                      onClick={i.kind === 'tick' ? tick : undefined}
                      onKeyDown={i.kind === 'tick' ? (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); tick(); } } : undefined}
                    >
                      <span className="clean-tick" aria-hidden="true">
                        <svg viewBox="0 0 24 24"><path d="m5 12.5 4.2 4.2L19 7" /></svg>
                      </span>
                      <span className="clean-what">
                        <span className="t">{i.text}</span>
                        {(i.hint || a.out) && (
                          <span className="d">
                            {i.hint}
                            {a.out && <strong className="clean-out"> · outside the safe range</strong>}
                          </span>
                        )}
                      </span>
                      {i.kind === 'temp' ? (
                        <label className="clean-temp">
                          <input
                            className={`input${a.out ? ' out' : ''}`}
                            inputMode="decimal"
                            placeholder="0"
                            aria-label={`${i.text}, °C`}
                            value={d?.text ?? ''}
                            onChange={(e) => put(i.id, e.target.value === '' ? null : { done: true, at: stamp(), text: e.target.value })}
                          />
                          <span className="small dim">°C</span>
                        </label>
                      ) : i.kind === 'photo' ? (
                        <label className={`clean-photo${a.done ? ' got' : ''}`}>
                          {busy === i.id ? 'Uploading…' : a.done ? '✓ Photo added' : '+ Photo'}
                          <input type="file" accept="image/*" capture="environment" hidden onChange={(e) => void addPhoto(i, e.target.files?.[0])} />
                        </label>
                      ) : a.done && d?.at ? (
                        <span className="clean-stamp">
                          {new Date(d.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      ) : i.required ? <span className="clean-req">Required</span> : <span />}
                    </div>
                  );
                })}
              </section>
            );
          })}
        </div>
      </div>

      {skipping && (
        <div className="modal-backdrop" onClick={() => setSkipping(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Carry on without finishing">
            <div className="card-head"><h2>{kind === 'open' ? 'Start without finishing?' : 'Close without finishing?'}</h2></div>
            <div className="modal-body" style={{ paddingBottom: '1.25rem' }}>
              <p className="small dim" style={{ marginTop: 0 }}>
                {p.requiredLeft} required check{p.requiredLeft === 1 ? ' is' : 's are'} not done. Say why. A manager sees it on Approvals.
              </p>
              <div className="chips">
                {REASONS.map((w) => (
                  <button key={w} type="button" className={`chip${reason === w ? ' on' : ''}`} onClick={() => setReason(w)}>{w}</button>
                ))}
              </div>
              {reason === 'Something else' && (
                <Textarea style={{ marginTop: '0.7rem' }} value={other} onChange={(e) => setOther(e.target.value)} placeholder="What happened" maxLength={280} />
              )}
            </div>
            <div className="modal-foot">
              <Button variant="ghost" onClick={() => setSkipping(false)}>Go back</Button>
              <Button variant="primary" disabled={!reasonText} loading={busy === 'file'} onClick={() => void file(reasonText)}>
                {kind === 'open' ? 'Start service' : 'Close up'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * A side's routine, and whether a list is still owed today.
 *
 * Nothing at all while the routine is switched off. A read that fails counts
 * as filed: a cleaning list must never be what stops a till working offline.
 */
export function useCleanRoutine(side: CleanSide, venueId: string | undefined, kind: CleanKind, enabled = true) {
  const [routine, setRoutine] = useState<CleanRoutine | null>(null);
  const [owed, setOwed] = useState(false);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!enabled || !venueId) { setOwed(false); return undefined; }
    let live = true;
    void (async () => {
      const r = await loadRoutine(side).catch(() => null);
      if (!live) return;
      setRoutine(r);
      if (!r?.active) { setOwed(false); return; }
      const filed = await filedToday(venueId, side, kind);
      if (live) setOwed(!filed);
    })();
    return () => { live = false; };
  }, [side, venueId, kind, enabled, n]);
  return { routine: routine?.active ? routine : null, owed, recheck: () => setN((x) => x + 1), done: () => setOwed(false) };
}
