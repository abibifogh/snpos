import { useEffect, useMemo, useState } from 'react';
import {
  Button, Card, Empty, Input, InfoTip, Notice, Segmented, Select, Spinner, Toggle, ViewTabs, useToast,
} from '@snpos/ui';
import {
  loadRoutines, saveRoutine, cleanLogsSince, cleanDay, DEFAULT_ROUTINES, DAY_NAMES, rangeWords, humanError,
  buildReportHtml, openPrintable, brandColour, modulesOf,
} from '@snpos/core';
import type { CleanItem, CleanItemKind, CleanLog, CleanRoutine, CleanSide } from '@snpos/core';
import { useSession } from '../session';

type View = 'routine' | 'log';
type ListKey = 'open' | 'close' | 'deep';

const LIST_WORDS: Record<ListKey, { title: string; help: string }> = {
  open: { title: 'Before service', help: 'Checked when the screen opens for the day, before the first ticket.' },
  close: { title: 'At closing', help: 'Checked before the shift is closed.' },
  deep: { title: 'Deep clean', help: 'Added to one of the two lists above on the deep-clean day. Photo checks ask for a picture.' },
};
const KIND_WORDS: Record<CleanItemKind, string> = { tick: 'Tick', temp: 'Temperature', photo: 'Photo' };
const SIDE_WORDS: Record<CleanSide, { name: string; where: string }> = {
  kitchen: { name: 'Kitchen', where: 'on the kitchen screen' },
  bar: { name: 'Bar', where: 'on the bar till' },
};

/**
 * Cleaning: the kitchen's and the bar's routines, and the log they leave.
 *
 * Every routine starts switched off with a suggested list, so nothing changes
 * on any screen until an admin has read the list, made it their own and
 * switched it on. See cleaning.ts.
 */
export function CleaningPage() {
  const { settings, user } = useSession();
  const toast = useToast();
  const mods = modulesOf(settings);
  const sides = (['kitchen', 'bar'] as CleanSide[]).filter((s) => mods[s]);
  const [side, setSide] = useState<CleanSide>(sides[0] ?? 'kitchen');
  const [view, setView] = useState<View>('routine');
  const [routines, setRoutines] = useState<Record<CleanSide, CleanRoutine> | null>(null);
  const [saved, setSaved] = useState<Record<CleanSide, string>>({ kitchen: '', bar: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadRoutines()
      .then((r) => { setRoutines(r); setSaved({ kitchen: JSON.stringify(r.kitchen), bar: JSON.stringify(r.bar) }); })
      .catch((e) => setError(humanError(e)));
  }, []);

  if (error && !routines) return <><h1>Cleaning</h1><Notice>{error}</Notice></>;
  if (!routines) return <><h1>Cleaning</h1><Spinner /></>;

  const r = routines[side];
  const dirty = JSON.stringify(r) !== saved[side];
  const set = (patch: Partial<CleanRoutine>) => setRoutines({ ...routines, [side]: { ...r, ...patch } });
  const setList = (k: ListKey, items: CleanItem[]) => set({ [k]: items } as Partial<CleanRoutine>);

  const save = async (next = r) => {
    setBusy(true);
    setError(null);
    try {
      await saveRoutine(next, user?.$id ?? '');
      setRoutines({ ...routines, [side]: next });
      setSaved({ ...saved, [side]: JSON.stringify(next) });
      toast(next.active === JSON.parse(saved[side] || '{}').active
        ? 'Saved'
        : next.active ? `Switched on. It shows ${SIDE_WORDS[side].where} from the next opening.` : 'Switched off.');
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="spread">
        <h1>
          Cleaning
          <InfoTip>
            What the kitchen and the bar check before they open and after they close, and a longer deep clean
            one day a week. Each tick is recorded with who and when. A list started without its required checks,
            or with a fridge outside its safe range, goes to Approvals.
          </InfoTip>
        </h1>
        {view === 'routine' && (
          <Button variant="primary" onClick={() => void save()} loading={busy} disabled={!dirty}>Save changes</Button>
        )}
      </div>

      {sides.length > 1 && (
        <Segmented<CleanSide>
          value={side}
          onChange={setSide}
          ariaLabel="Which side"
          options={sides.map((s) => ({ value: s, label: SIDE_WORDS[s].name }))}
        />
      )}
      {sides.length === 0 && (
        <Notice>Neither the kitchen nor the bar is switched on under Features, so there is nothing to clean here yet.</Notice>
      )}

      <ViewTabs<View>
        value={view}
        onChange={setView}
        options={[{ value: 'routine', label: 'Routine' }, { value: 'log', label: 'Cleaning log' }]}
      />

      {error && <Notice>{error}</Notice>}

      {view === 'log' ? <CleanLogView side={side} /> : (
        <>
          <Card
            title={r.active ? 'Switched on' : 'Switched off'}
            help={<>Off until you switch it on. Read the lists below first and make them your own; they are suggestions.</>}
          >
            <Toggle
              checked={r.active}
              onChange={(v) => void save({ ...r, active: v })}
              disabled={busy}
              label={r.active
                ? `${SIDE_WORDS[side].name} staff are asked to clean before service and at closing.`
                : `Switch on to ask ${SIDE_WORDS[side].name.toLowerCase()} staff to clean before service and at closing.`}
            />
          </Card>

          <div className="grid-2" style={{ gap: '1rem' }}>
            <Card title="If the list isn&rsquo;t finished">
              <div className="stack" style={{ gap: '0.5rem' }}>
                {([
                  ['hold', 'Hold service until it is', 'Staff can still carry on, but they give a reason, and it goes to Approvals.'],
                  ['show', 'Show it, but don’t hold anything', 'Checks left undone go to Approvals for a manager to see.'],
                ] as ['hold' | 'show', string, string][]).map(([k, t, d]) => (
                  <button key={k} type="button" className={`choice${r.hold === k ? ' on' : ''}`} onClick={() => set({ hold: k })}>
                    <span style={{ textAlign: 'left' }}>
                      <span className="choice-title" style={{ display: 'block' }}>{t}</span>
                      <span className="small dim">{d}</span>
                    </span>
                  </button>
                ))}
              </div>
            </Card>
            <Card title="Deep-clean day">
              <div className="chips">
                {[1, 2, 3, 4, 5, 6, 7, 0].map((d) => (
                  <button key={d} type="button" className={`chip${r.deepDay === d ? ' on' : ''}`} onClick={() => set({ deepDay: d })}>
                    {d === 0 ? 'None' : DAY_NAMES[d].slice(0, 3)}
                  </button>
                ))}
              </div>
              {r.deepDay > 0 && (
                <div style={{ marginTop: '0.8rem' }}>
                  <Segmented<'before' | 'after'>
                    value={r.deepWhen}
                    onChange={(v) => set({ deepWhen: v })}
                    ariaLabel="When the deep clean is done"
                    options={[{ value: 'before', label: 'Before opening' }, { value: 'after', label: 'After closing the night before' }]}
                  />
                  <p className="small dim" style={{ marginBottom: 0 }}>
                    {r.deepWhen === 'before'
                      ? `Added to the opening list every ${DAY_NAMES[r.deepDay]}.`
                      : `Added to the closing list every ${DAY_NAMES[r.deepDay === 1 ? 7 : r.deepDay - 1]} night, ready for ${DAY_NAMES[r.deepDay]}.`}
                  </p>
                </div>
              )}
            </Card>
          </div>

          {(['open', 'close', 'deep'] as ListKey[]).map((k) => (
            <ListEditor
              key={`${side}-${k}`}
              title={LIST_WORDS[k].title}
              help={LIST_WORDS[k].help}
              items={r[k]}
              onChange={(items) => setList(k, items)}
              onReset={() => setList(k, DEFAULT_ROUTINES[side][k])}
              prefix={`${side[0]}${k[0]}`}
            />
          ))}
        </>
      )}
    </>
  );
}

/** One list of checks, edited in place. */
function ListEditor({ title, help, items, onChange, onReset, prefix }: {
  title: string; help: string; items: CleanItem[]; onChange: (items: CleanItem[]) => void; onReset: () => void; prefix: string;
}) {
  const areas = useMemo(() => [...new Set(items.map((i) => i.area))], [items]);
  const patch = (n: number, p: Partial<CleanItem>) => onChange(items.map((i, x) => (x === n ? { ...i, ...p } : i)));
  const move = (n: number, by: number) => {
    const to = n + by;
    if (to < 0 || to >= items.length) return;
    const next = [...items];
    [next[n], next[to]] = [next[to], next[n]];
    onChange(next);
  };
  const add = () => onChange([...items, {
    id: `${prefix}-${Date.now().toString(36)}`, area: areas[areas.length - 1] ?? 'Other', text: '', required: true, kind: 'tick',
  }]);
  const num = (v: string) => (v.trim() === '' || !Number.isFinite(Number(v)) ? undefined : Number(v));

  return (
    <Card
      title={`${title} · ${items.length} check${items.length === 1 ? '' : 's'}`}
      help={help}
      actions={<Button size="sm" variant="ghost" onClick={onReset}>Use the suggested list</Button>}
      pad={false}
    >
      <datalist id={`areas-${prefix}`}>{areas.map((a) => <option key={a} value={a} />)}</datalist>
      <div className="clean-edit">
        {items.length === 0 && <Empty title="No checks">Add the first one below.</Empty>}
        {items.map((i, n) => (
          <div className="clean-edit-row" key={i.id}>
            <div className="clean-edit-main">
              <Input value={i.text} placeholder="What to do" aria-label="What to do" onChange={(e) => patch(n, { text: e.target.value })} />
              <div className="clean-edit-sub">
                <Input
                  value={i.area}
                  list={`areas-${prefix}`}
                  aria-label="Heading"
                  placeholder="Heading"
                  onChange={(e) => patch(n, { area: e.target.value })}
                />
                <Select
                  value={i.kind}
                  aria-label="Kind of check"
                  onChange={(e) => {
                    const kind = e.target.value as CleanItemKind;
                    patch(n, kind === 'temp'
                      ? { kind, min: i.min ?? 0, max: i.max ?? 5, hint: rangeWords(i.min ?? 0, i.max ?? 5) }
                      : { kind, min: undefined, max: undefined, hint: kind === 'photo' ? 'Take a photo when done' : i.kind === 'tick' ? i.hint : undefined });
                  }}
                >
                  {(Object.keys(KIND_WORDS) as CleanItemKind[]).map((k) => <option key={k} value={k}>{KIND_WORDS[k]}</option>)}
                </Select>
                {i.kind === 'temp' && (
                  <span className="clean-edit-range">
                    <Input inputMode="decimal" aria-label="Lowest safe °C" value={i.min ?? ''} onChange={(e) => { const min = num(e.target.value); patch(n, { min, hint: rangeWords(min, i.max) }); }} />
                    <span className="small dim">to</span>
                    <Input inputMode="decimal" aria-label="Highest safe °C" value={i.max ?? ''} onChange={(e) => { const max = num(e.target.value); patch(n, { max, hint: rangeWords(i.min, max) }); }} />
                    <span className="small dim">°C</span>
                  </span>
                )}
              </div>
              {i.kind === 'tick' && (
                <Input value={i.hint ?? ''} placeholder="How, in a line (optional)" aria-label="How" onChange={(e) => patch(n, { hint: e.target.value || undefined })} />
              )}
            </div>
            <div className="clean-edit-side">
              <Toggle checked={i.required} onChange={(v) => patch(n, { required: v })} label="Required" />
              <span className="row" style={{ gap: '0.2rem' }}>
                <Button size="sm" variant="ghost" aria-label="Move up" disabled={n === 0} onClick={() => move(n, -1)}>↑</Button>
                <Button size="sm" variant="ghost" aria-label="Move down" disabled={n === items.length - 1} onClick={() => move(n, 1)}>↓</Button>
                <Button size="sm" variant="ghost" aria-label="Remove" onClick={() => onChange(items.filter((_, x) => x !== n))}>✕</Button>
              </span>
            </div>
          </div>
        ))}
        <div style={{ padding: '0.8rem 1.3rem 1.1rem' }}>
          <Button size="sm" onClick={add}>+ Add a check</Button>
        </div>
      </div>
    </Card>
  );
}

/** What was filed, day by day, for a side. */
function CleanLogView({ side }: { side: CleanSide }) {
  const { settings } = useSession();
  const [logs, setLogs] = useState<CleanLog[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const from = useMemo(() => { const d = new Date(); d.setDate(d.getDate() - 30); return cleanDay(d); }, []);

  useEffect(() => {
    setLogs(null);
    cleanLogsSince('main', from).then(setLogs).catch((e) => setError(humanError(e)));
  }, [from]);

  if (error) return <Notice>{error}</Notice>;
  if (!logs) return <Spinner />;
  const mine = logs.filter((l) => l.side === side);
  const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const readings = (l: CleanLog) => l.answers.filter((a) => a.kind === 'temp' && a.value !== undefined)
    .map((a) => `${a.text} ${a.value} °C${a.out ? ' (out)' : ''}`).join(' · ');
  const note = (l: CleanLog) => [
    l.required_left > 0 ? `${l.required_left} required not done` : '',
    l.skip_reason ? `Reason: ${l.skip_reason}` : '',
    l.review === 'seen' ? 'Seen by a manager' : l.review === 'pending' ? 'On Approvals' : '',
  ].filter(Boolean).join(' · ');
  const allDone = mine.filter((l) => l.required_left === 0 && l.out_of_range === 0).length;

  const download = () => openPrintable(buildReportHtml({
    title: `${SIDE_WORDS[side].name} cleaning log`,
    restaurantName: settings?.restaurant_name ?? '',
    period: `${from} to ${cleanDay(new Date())}`,
    stats: [
      { label: 'Lists filed', value: String(mine.length) },
      { label: 'Every check done', value: String(allDone) },
      { label: 'Readings out of range', value: String(mine.reduce((n, l) => n + l.out_of_range, 0)) },
      { label: 'Deep cleans', value: String(mine.filter((l) => l.deep).length) },
    ],
    tables: [{
      title: 'Every list',
      headers: ['Day', 'List', 'Done at', 'Who', 'Checks', 'Readings', 'Notes'],
      rows: mine.map((l) => [l.day, `${l.kind === 'open' ? 'Opening' : 'Closing'}${l.deep ? ' + deep clean' : ''}`, time(l.finished_at), l.by_name ?? '', `${l.done}/${l.of}`, readings(l), note(l)]),
    }],
    brandColor: brandColour(settings?.primary_color),
  }), `${SIDE_WORDS[side].name} cleaning log ${cleanDay(new Date())}`);

  return (
    <>
      <div className="stat-row">
        <div className="stat"><div className="label">Lists filed</div><div className="value">{mine.length}</div><div className="note">last 30 days</div></div>
        <div className="stat"><div className="label">Every check done</div><div className="value">{allDone}</div><div className="note">nothing missed, nothing out of range</div></div>
        <div className="stat"><div className="label">Readings out of range</div><div className="value">{mine.reduce((n, l) => n + l.out_of_range, 0)}</div><div className="note">fridges and freezers</div></div>
        <div className="stat"><div className="label">Deep cleans</div><div className="value">{mine.filter((l) => l.deep).length}</div><div className="note">with their photos</div></div>
      </div>
      <Card title="Every list, newest first" actions={<Button size="sm" onClick={download} disabled={mine.length === 0}>Download PDF</Button>} pad={false}>
        {mine.length === 0 ? (
          <Empty title="Nothing filed yet">Lists appear here once the routine is switched on and somebody completes one.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Day</th><th>List</th><th>Done at</th><th>Who</th><th>Checks</th><th>Readings</th><th>Notes</th></tr></thead>
              <tbody>
                {mine.map((l) => (
                  <tr key={l.$id}>
                    <td style={{ fontWeight: 650, whiteSpace: 'nowrap' }}>{l.day}</td>
                    <td>{l.kind === 'open' ? 'Opening' : 'Closing'}{l.deep && <> <span className="badge badge-brand">Deep clean</span></>}</td>
                    <td className="num">{time(l.finished_at)}</td>
                    <td>{l.by_name || '—'}</td>
                    <td>
                      <span className={`badge ${l.required_left === 0 && l.out_of_range === 0 ? 'badge-ok' : 'badge-late'}`}>{l.done}/{l.of}</span>
                    </td>
                    <td className="small">{readings(l) || '—'}</td>
                    <td className="small dim">{note(l) || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
