import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, Notice, Select, useToast } from '@snpos/ui';
import {
  listAll, loadCountCharges, hiveRows, hiveCsv, downloadCsv, markSentToHive,
} from '@snpos/core';
import type { CountCharge, StaffProfile } from '@snpos/core';
import { useSession, useMoney } from '../session';
import { humanError } from '../lib';

const monthKey = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const monthWords = (key: string): string => {
  const [y, m] = key.split('-').map(Number);
  return new Date(y!, (m ?? 1) - 1, 1).toLocaleDateString([], { month: 'long', year: 'numeric' });
};

/**
 * The month's final count-difference deductions, for HIVE.
 *
 * Only what is final: deducted, by a manager or by the clock. Waiting, waived
 * and put-back amounts never go. Each row carries its own reference, so HIVE
 * never takes one twice. A person not matched to HIVE on the Staff page is
 * left out and named here, never guessed at.
 *
 * Until HIVE reads them itself from its signed link, the spreadsheet is
 * imported there by hand, and "Mark as sent" records that it was: from then
 * on nobody can take those decisions back.
 */
export function HiveExport({ onChanged }: { onChanged?: () => void }) {
  const { profile, settings } = useSession();
  const money = useMoney();
  const toast = useToast();
  const isAdmin = profile?.role === 'admin';
  const [charges, setCharges] = useState<CountCharge[] | null>(null);
  const [profiles, setProfiles] = useState<StaffProfile[]>([]);
  const [month, setMonth] = useState(() => monthKey(new Date()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const [c, p] = await Promise.all([loadCountCharges('main'), listAll<StaffProfile>('staff_profiles')]);
      setCharges(c);
      setProfiles(p);
    } catch {
      setCharges([]);
    }
  };
  useEffect(() => { void load(); }, []);

  const months = useMemo(() => {
    const now = new Date();
    return [0, 1, 2].map((back) => monthKey(new Date(now.getFullYear(), now.getMonth() - back, 1)));
  }, []);
  const { rows, unmatched } = useMemo(() => hiveRows(charges ?? [], profiles, month), [charges, profiles, month]);
  if (!charges || charges.length === 0) return null;

  const unsent = rows.filter((r) => !r.sentAt);
  const total = rows.reduce((s, r) => s + r.amount, 0);
  const decimals = settings?.currency_decimals ?? 2;

  const download = () => {
    downloadCsv(`hive-deductions-${month}`, hiveCsv(rows, decimals));
  };

  const markSent = async () => {
    if (!confirm(`Mark ${unsent.length} deduction${unsent.length === 1 ? '' : 's'} as taken by HIVE? They are final from then on: nobody can take them back.`)) return;
    setBusy(true);
    setError(null);
    try {
      const n = await markSentToHive(unsent.map((r) => ({ chargeId: r.chargeId, hiveStaffId: r.hiveStaffId })));
      toast(`${n} marked as sent to HIVE.`);
      await load();
      onChanged?.();
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Deductions for HIVE"
      actions={(
        <div className="row row-wrap" style={{ gap: '0.5rem', justifyContent: 'flex-end' }}>
          <Select aria-label="Month" value={month} style={{ width: 'auto' }} onChange={(e) => setMonth(e.target.value)}>
            {months.map((m) => <option key={m} value={m}>{monthWords(m)}</option>)}
          </Select>
          <Button onClick={download} disabled={rows.length === 0}>Download for HIVE</Button>
          {isAdmin && unsent.length > 0 && <Button loading={busy} onClick={() => void markSent()}>Mark as sent</Button>}
        </div>
      )}
      help={(
        <>
          Final count-difference deductions only: what a manager deducted, or what was deducted when nobody answered
          in time. Waiting, waived and put-back amounts never go to HIVE. HIVE can read these itself from its signed
          link once it is connected; until then, import the spreadsheet in HIVE and mark them as sent here.
        </>
      )}
    >
      {error && <Notice>{error}</Notice>}
      <p style={{ margin: 0 }}>
        {rows.length === 0
          ? `No final deductions in ${monthWords(month)}.`
          : `${rows.length} deduction${rows.length === 1 ? '' : 's'} in ${monthWords(month)}, ${money(total)}. `
            + (unsent.length ? `${unsent.length} not sent to HIVE yet.` : 'All sent to HIVE.')}
      </p>
      {unmatched.length > 0 && (
        <Notice tone="warn">
          Held, because {unmatched.length === 1 ? 'this person is' : 'these people are'} not matched to HIVE:{' '}
          {unmatched.map((u) => `${u.name} (${money(u.amount)})`).join(', ')}. Match them on{' '}
          <Link to="/staff">Staff</Link> and their deductions go with the next download.
        </Notice>
      )}
    </Card>
  );
}
