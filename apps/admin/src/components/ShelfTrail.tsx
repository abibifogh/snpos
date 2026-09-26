import { useEffect, useState } from 'react';
import { Button, Modal, Notice, Spinner } from '@snpos/ui';
import { humanError } from '../lib';
import { loadShelfTrail, shelfTrail, trailWarning, dateTimeWords } from '@snpos/core';
import type { TrailRow } from '@snpos/core';

const DAYS = 30;

/**
 * Where a shelf figure came from: every movement of the last month, what the
 * place held after each, and the counts beside them — including the ones
 * still waiting for approval, which move nothing until somebody decides.
 * See shelf-trail.ts.
 */
export function ShelfTrailModal({ ingredient, unit, onClose }: {
  ingredient: { $id: string; name: string };
  unit?: string;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<TrailRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadShelfTrail('main', ingredient.$id, Date.now() - DAYS * 86_400_000)
      .then((got) => setRows(shelfTrail(got)))
      .catch((e) => { setError(humanError(e)); setRows([]); });
  }, [ingredient.$id]);

  const warning = rows ? trailWarning(rows) : null;
  const n = (v: number) => `${v > 0 ? '+' : ''}${v}${unit ? ` ${unit}` : ''}`;

  return (
    <Modal title={`${ingredient.name} · where the figure came from`} onClose={onClose} wide footer={<Button onClick={onClose}>Close</Button>}>
      <p className="small dim" style={{ marginTop: 0 }}>
        Everything that moved it in the last {DAYS} days, newest first, with what each place held straight after.
      </p>
      {error && <Notice>{error}</Notice>}
      {warning && <Notice tone="warn">{warning}</Notice>}
      {!rows ? <Spinner /> : rows.length === 0 ? (
        <p className="dim">Nothing moved it in the last {DAYS} days.</p>
      ) : (
        <div className="table-wrap" style={{ maxHeight: '28rem', overflowY: 'auto' }}>
          <table className="data">
            <thead><tr><th>When</th><th>What</th><th>Where</th><th className="num">Change</th><th className="num">Then held</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} style={r.waiting ? { background: 'var(--warn-soft, #fff7e0)' } : undefined}>
                  <td className="small dim" style={{ whiteSpace: 'nowrap' }}>{dateTimeWords(r.at)}</td>
                  <td>
                    <div style={{ fontWeight: 550 }}>{r.what}</div>
                    {r.note && <div className="small dim">{r.note}</div>}
                  </td>
                  <td className="small">{r.where}</td>
                  <td className="num">{r.change === undefined ? '' : n(r.change)}</td>
                  <td className="num">{r.after === undefined ? '' : r.after}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
