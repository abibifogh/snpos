import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Button, Card, Notice, Spinner } from '@snpos/ui';
import { humanError } from '../lib';
import { healthFacts, healthFindings, healthSummary, lastHealthReport, dateTimeWords } from '@snpos/core';
import type { HealthFinding } from '@snpos/core';
import { useMoney } from '../session';

/** The three cards, by which findings belong on them. */
const RECORDS = ['shifts_unposted', 'entries_broken', 'spends_unposted', 'spends_no_lines', 'counts_half', 'orders_no_payment', 'orders_no_lines', 'payouts', 'waste', 'trial'];
const WAITING = ['spends_stale', 'counts_stale', 'shifts_open', 'clearing'];
const JOBS = ['job_health', 'job_backup', 'mail'];

const tone = (level: HealthFinding['level']): 'ok' | 'warn' | 'danger' | 'default' =>
  level === 'block' ? 'danger' : level === 'warn' ? 'warn' : level === 'ok' ? 'ok' : 'default';

/**
 * Records that do not add up, and jobs that have gone quiet.
 *
 * A half-written record — a shift closed but never posted, a payout that
 * never reached the maker's ledger, an order marked paid with no payment —
 * does not announce itself. It is found weeks later as a figure nobody can
 * explain. So the server asks these questions every night and writes the
 * answers down, and this page asks them again the moment it opens, so what
 * the owner reads in the morning email and what they see here agree.
 *
 * Every question is listed, answered "None" when it found nothing, because
 * a page that shows only trouble cannot say what it checked. The questions
 * themselves are in core, see health-rules.ts.
 */
export function HealthPage() {
  const navigate = useNavigate();
  const money = useMoney();

  const [findings, setFindings] = useState<HealthFinding[] | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [night, setNight] = useState<{ at: string; words: string } | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [howTo, setHowTo] = useState<'provision' | 'functions' | null>(null);

  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      const facts = await healthFacts('main');
      setFindings(healthFindings(facts, { money }));
      setCheckedAt(facts.now);
    } catch (e) {
      setError(humanError(e));
      setFindings([]);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void check();
    lastHealthReport('main').then((r) => setNight(r ? { at: r.at, words: r.words } : null)).catch(() => setNight(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const summary = findings ? healthSummary(findings) : null;

  const go = (f: HealthFinding) => {
    if (!f.goto) return;
    if (f.goto === 'provision' || f.goto === 'functions') { setHowTo(f.goto); return; }
    navigate(f.goto);
  };

  const rows = (keys: string[]) => (findings ?? []).filter((f) => keys.includes(f.key));

  const table = (keys: string[]) => (
    <div className="table-wrap">
      <table className="data">
        <tbody>
          {rows(keys).map((f) => (
            <tr key={f.key} style={f.level === 'ok' ? { opacity: 0.75 } : undefined}>
              <td style={{ width: '1%', whiteSpace: 'nowrap' }}>
                <Badge tone={tone(f.level)}>{f.level === 'ok' ? 'Fine' : f.level === 'block' ? 'Fix' : f.level === 'warn' ? 'Waiting' : 'Note'}</Badge>
              </td>
              <td>
                <div style={{ fontWeight: 550 }}>{f.title}{f.count > 1 && <span className="dim"> · {f.count}</span>}</div>
                <div className="small dim">{f.detail}</div>
              </td>
              <td className="num" style={{ whiteSpace: 'nowrap' }}>
                {f.goto && f.level !== 'ok' && (
                  <Button size="sm" variant={f.level === 'block' ? 'primary' : 'ghost'} onClick={() => go(f)}>{f.action ?? 'Open'}</Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <>
      <div className="spread">
        <div>
          <h1>Health</h1>
          <p className="dim small" style={{ margin: '0.2rem 0 0' }}>
            Checked every night at two, and whenever you open this page.
            {night === undefined ? '' : night
              ? ` Last night's check, ${dateTimeWords(night.at)}: ${night.words}`
              : ' The nightly check has not written anything down yet.'}
          </p>
        </div>
        <Button variant="primary" loading={busy} onClick={() => void check()}>Check again now</Button>
      </div>

      {error && <Notice>{error}</Notice>}

      {summary && (
        <Notice tone={summary.blocks > 0 ? 'err' : summary.warns > 0 ? 'warn' : 'ok'}>
          <strong>{summary.words}</strong>
          {checkedAt && <span className="dim"> Checked {new Date(checkedAt).toLocaleTimeString()}.</span>}
        </Notice>
      )}

      {howTo && (
        <Notice tone="info">
          {howTo === 'provision'
            ? 'Merging anything to main runs Provision on its own. To run it now: GitHub, Actions, Provision Appwrite, Run workflow, type "provision". It adds what is missing and changes nothing else.'
            : 'Merging anything to main deploys the background jobs on its own. To deploy them now: GitHub, Actions, Deploy functions, Run workflow, type "deploy". Then check the Executions tab of the notify function in the Appwrite console.'}
          {' '}<Button size="sm" variant="ghost" onClick={() => setHowTo(null)}>Close</Button>
        </Notice>
      )}

      {!findings ? (
        <Card><Spinner /></Card>
      ) : (
        <>
          <Card title={`Records that do not add up${rows(RECORDS).some((f) => f.level !== 'ok') ? '' : ' · none'}`} pad={false}>
            {table(RECORDS)}
          </Card>
          <div style={{ height: '1rem' }} />
          <Card title="Waiting on somebody" pad={false}>
            {table(WAITING)}
          </Card>
          <div style={{ height: '1rem' }} />
          <Card title="Background jobs" pad={false}>
            {table(JOBS)}
            <p className="small dim card-pad" style={{ margin: 0 }}>
              The order guard, the pre-order timer and the kitchen escalation leave no trace to check here; the
              Appwrite console, Functions, Executions, shows each one running every minute.
            </p>
          </Card>
        </>
      )}
    </>
  );
}
