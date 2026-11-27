import { useEffect, useMemo, useState } from 'react';
import { Button, Field, Input, Modal, Notice, Select, Spinner } from '@snpos/ui';
import {
  deductionRows, deductionTotals, deductionPeople, deductionPeriod, deductionsHtml, deductionsCsv,
  loadWaitingCounts, openPrintable, downloadCsv, dateTimeWords,
} from '@snpos/core';
import type { StaffCharge, StaffSettlement, WaitingCount } from '@snpos/core';

type Quick = 'week' | 'lastweek' | 'month' | 'lastmonth' | 'custom';
const QUICK: { key: Exclude<Quick, 'custom'>; label: string }[] = [
  { key: 'week', label: 'This week' },
  { key: 'lastweek', label: 'Last week' },
  { key: 'month', label: 'This month' },
  { key: 'lastmonth', label: 'Last month' },
];

const dayInput = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dayWords = (s: string): string =>
  new Date(`${s}T12:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });

/**
 * The staff deductions report, for admins and managers.
 *
 * What each person has been charged for shortages over the days chosen, with
 * what is not final yet and bar counts nobody has approved kept apart from
 * what is deducted. Everyone, a page each, or one person. As a PDF to hand
 * over, or a spreadsheet with the same rows. Downloading changes nothing.
 * The rules are in deductions-report.ts.
 */
export function DeductionsReportModal({ charges, settlements, personId, business, madeBy, money, decimals, onClose }: {
  charges: StaffCharge[];
  settlements: StaffSettlement[];
  /** '' for everyone. */
  personId: string;
  business: string;
  madeBy?: string;
  money: (n: number) => string;
  decimals: number;
  onClose: () => void;
}) {
  const [waiting, setWaiting] = useState<WaitingCount[] | null>(null);
  const [who, setWho] = useState(personId);
  const [quick, setQuick] = useState<Quick>('month');
  const [from, setFrom] = useState(() => dayInput(deductionPeriod('month').from));
  const [to, setTo] = useState(() => dayInput(deductionPeriod('month').to));
  const [notFinal, setNotFinal] = useState(true);
  const [approval, setApproval] = useState(true);
  const [off, setOff] = useState(false);

  useEffect(() => {
    // Counts nobody has approved. Without them the report still works.
    loadWaitingCounts().then(setWaiting).catch(() => setWaiting([]));
  }, []);

  const pick = (q: Exclude<Quick, 'custom'>) => {
    const p = deductionPeriod(q);
    setQuick(q);
    setFrom(dayInput(p.from));
    setTo(dayInput(p.to));
  };

  const people = useMemo(() => {
    const all = new Map<string, string>();
    for (const c of charges) if (c.direction !== 'credit') all.set(c.person_id, c.person_name);
    for (const w of waiting ?? []) if (w.personId) all.set(w.personId, w.name);
    return [...all.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [charges, waiting]);

  const problem = !from || !to ? 'Choose both days.' : from > to ? 'The first day is after the last.' : null;
  const rows = useMemo(() => (problem ? [] : deductionRows(
    charges, settlements, waiting ?? [],
    {
      from: new Date(`${from}T00:00:00`).toISOString(),
      to: new Date(`${to}T23:59:59.999`).toISOString(),
      personId: who || undefined,
      notFinal, approval, off,
    },
    money,
    (iso) => dateTimeWords(iso),
  )), [charges, settlements, waiting, from, to, who, notFinal, approval, off, problem, money]);
  const totals = deductionTotals(rows);
  const count = deductionPeople(rows).length;
  const name = who ? people.find(([id]) => id === who)?.[1] ?? 'Staff' : 'Everyone';
  const file = `Deductions ${name} ${from} to ${to}`.replace(/[\\/:*?"<>|]/g, '-');
  const day = (iso: string) => new Date(iso).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });

  const pdf = () => {
    if (problem) return;
    openPrintable(deductionsHtml({
      business,
      periodWords: `${dayWords(from)} to ${dayWords(to)}${who ? ` · ${name}` : ''}`,
      rows,
      include: { notFinal, approval, off },
      money,
      day,
      madeAt: new Date().toISOString(),
      madeBy,
    }), file);
  };
  const csv = () => {
    if (problem) return;
    downloadCsv(file, deductionsCsv(rows, decimals, (iso) => dayInput(new Date(iso))));
  };

  return (
    <Modal
      title="Deductions report"
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>Close</Button>
          <Button disabled={!!problem || waiting === null} onClick={csv}>Spreadsheet</Button>
          <Button variant="primary" disabled={!!problem || waiting === null} onClick={pdf}>Download PDF</Button>
        </>
      )}
    >
      <div style={{ display: 'grid', gap: '0.8rem' }}>
        <Field label="Timeframe">
          <div className="row row-wrap" style={{ gap: '0.4rem' }} role="group" aria-label="Timeframe">
            {QUICK.map((q) => (
              <Button key={q.key} size="sm" variant={quick === q.key ? 'primary' : 'default'} aria-pressed={quick === q.key} onClick={() => pick(q.key)}>
                {q.label}
              </Button>
            ))}
          </div>
        </Field>
        <div className="grid-2">
          <Field label="From"><Input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setQuick('custom'); }} /></Field>
          <Field label="To"><Input type="date" value={to} onChange={(e) => { setTo(e.target.value); setQuick('custom'); }} /></Field>
        </div>
        <Field label="Who">
          <Select value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="">Everyone, a page each</option>
            {people.map(([id, n]) => <option key={id} value={id}>{n}</option>)}
          </Select>
        </Field>
        <Field label="Include">
          <div style={{ display: 'grid', gap: '0.45rem' }}>
            <label className="row" style={{ gap: '0.5rem', alignItems: 'flex-start' }}>
              <input type="checkbox" checked={notFinal} onChange={(e) => setNotFinal(e.target.checked)} />
              <span>Not final yet <span className="small dim">· waiting for their answer or a manager</span></span>
            </label>
            <label className="row" style={{ gap: '0.5rem', alignItems: 'flex-start' }}>
              <input type="checkbox" checked={approval} onChange={(e) => setApproval(e.target.checked)} />
              <span>Waiting on approval <span className="small dim">· bar counts nobody has approved, against whoever ran that shift</span></span>
            </label>
            <label className="row" style={{ gap: '0.5rem', alignItems: 'flex-start' }}>
              <input type="checkbox" checked={off} onChange={(e) => setOff(e.target.checked)} />
              <span>Waived and put back <span className="small dim">· not taken from pay, kept for the record</span></span>
            </label>
          </div>
        </Field>
        {waiting === null ? <Spinner /> : problem ? <Notice>{problem}</Notice> : (
          <Notice tone="info">
            {rows.length === 0
              ? 'No shortages in these days for the people and kinds chosen.'
              : <>
                {rows.length} {rows.length === 1 ? 'shortage' : 'shortages'}{count > 1 ? `, ${count} people, a page each` : ''}.
                {' '}Deducted {money(totals.deducted)}
                {notFinal ? ` · not final ${money(totals.notFinal)}` : ''}
                {approval ? ` · waiting on approval ${money(totals.approval)}` : ''}
                {off ? ` · waived or put back ${money(totals.off)}` : ''}.
              </>}
          </Notice>
        )}
        <p className="small dim" style={{ margin: 0 }}>A shortage falls in the period by the date of the count that found it. Downloading changes nothing.</p>
      </div>
    </Modal>
  );
}
