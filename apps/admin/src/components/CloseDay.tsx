import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Card, InfoTip, Segmented, Spinner } from '@snpos/ui';
import { closeDayFacts, closeDayChecklist, closeDayProgress, dateWords } from '@snpos/core';
import type { CloseDayRow } from '@snpos/core';

type Which = 'today' | 'yesterday';

const TICK: Record<CloseDayRow['state'], { mark: string; tone: 'ok' | 'warn' | 'default' }> = {
  done: { mark: '✓', tone: 'ok' },
  todo: { mark: '!', tone: 'warn' },
  none: { mark: '–', tone: 'default' },
};

/**
 * Close the day: whether a day's money and stock are put away, in one list.
 * On Today and on its own page. See close-day.ts.
 */
export function CloseDayCard({ money, compact = false }: { money: (n: number) => string; compact?: boolean }) {
  const [which, setWhich] = useState<Which>(() => (new Date().getHours() < 12 ? 'yesterday' : 'today'));
  const [rows, setRows] = useState<CloseDayRow[] | null>(null);
  const [error, setError] = useState(false);

  const day = new Date();
  if (which === 'yesterday') day.setDate(day.getDate() - 1);
  const key = day.toDateString();

  useEffect(() => {
    setRows(null);
    setError(false);
    void closeDayFacts('main', day)
      .then((f) => setRows(closeDayChecklist(f, money)))
      .catch(() => setError(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const progress = rows ? closeDayProgress(rows) : null;
  return (
    <Card
      title={`Close the day · ${dateWords(day.toISOString())}${progress && progress.of ? ` · ${progress.done} of ${progress.of} done` : ''}`}
      pad={false}
      help={compact ? undefined : (
        <>
          Each line is a job that already has a page; this says whether it is done for the day, and takes you there.
        </>
      )}
    >
      <div className="card-pad" style={{ paddingBottom: 0 }}>
        <Segmented<Which>
          value={which}
          onChange={setWhich}
          ariaLabel="Which day"
          options={[{ value: 'yesterday', label: 'Yesterday' }, { value: 'today', label: 'Today' }]}
        />
        {progress && progress.of > 0 && (
          <div className="meter" style={{ marginTop: '0.8rem' }} aria-hidden="true">
            <span className={progress.done === progress.of ? 'ok' : ''} style={{ width: `${(progress.done / progress.of) * 100}%` }} />
          </div>
        )}
      </div>
      {error ? (
        <p className="card-pad small" style={{ margin: 0 }}>The day's shifts could not be read, so it cannot say whether the day is finished.</p>
      ) : rows === null ? (
        <div className="card-pad"><Spinner /></div>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td style={{ width: '2rem' }}><Badge tone={TICK[r.state].tone}>{TICK[r.state].mark}</Badge></td>
                  <td>
                    <div style={{ fontWeight: 550 }}>{r.label}</div>
                    <div className="small dim">{r.detail}</div>
                  </td>
                  <td className="num">
                    {r.state === 'todo'
                      ? <Link className="btn btn-sm btn-primary" to={r.to}>{r.action ?? 'Open'}</Link>
                      : <Link className="small" to={r.to}>Open</Link>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function CloseDayPage({ money }: { money: (n: number) => string }) {
  return (
    <>
      <h1>
        Close the day
        <InfoTip>
          Whether a day is finished: shifts closed, counts and spends agreed, cash put away and banked, card and mobile
          money matched to the bank, petty cash counted.
        </InfoTip>
      </h1>
      <CloseDayCard money={money} />
    </>
  );
}
