import { useMemo, useState } from 'react';
import { Badge, Button, Field, Input, Modal, Notice, Textarea } from './components';

/**
 * The "we've run out" screen.
 *
 * Shared by the till and the kitchen display because the person who notices is
 * whoever is nearest the fridge, and the answer to "where do I do that?" should
 * be "wherever you are standing".
 *
 * Deliberately a search box and a list rather than a menu to navigate: this is
 * used mid-service by someone holding an empty container, and every tap between
 * them and the dish is a tap during which orders keep coming in.
 */

export interface EightySixItem {
  $id: string;
  name: string;
  off: boolean;
  offSince?: string;
  reason?: string;
}

export function EightySixModal({
  items,
  requireReason,
  onMarkOff,
  onRestore,
  onClose,
  busyId,
}: {
  items: EightySixItem[];
  requireReason: boolean;
  onMarkOff: (item: EightySixItem, reason: string) => void;
  onRestore: (item: EightySixItem) => void;
  onClose: () => void;
  busyId?: string | null;
}) {
  const [filter, setFilter] = useState('');
  const [confirming, setConfirming] = useState<EightySixItem | null>(null);
  const [reason, setReason] = useState('');

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const matched = q ? items.filter((i) => i.name.toLowerCase().includes(q)) : items;
    // Anything already off floats to the top: the most common second visit to
    // this screen is to put something back.
    return [...matched].sort((a, b) => Number(b.off) - Number(a.off) || a.name.localeCompare(b.name));
  }, [items, filter]);

  const offCount = items.filter((i) => i.off).length;

  const hoursSince = (iso?: string) => {
    if (!iso) return null;
    return Math.floor((Date.now() - new Date(iso).getTime()) / 3600_000);
  };

  return (
    <Modal
      title="What have we run out of?"
      onClose={onClose}
      footer={<Button onClick={onClose}>Done</Button>}
    >
      {offCount > 0 && (
        <div style={{ marginBottom: '0.8rem' }}>
          <Notice tone="warn">
            {offCount} {offCount === 1 ? 'dish is' : 'dishes are'} off the menu. Customers cannot order them and the
            kitchen screen will not show them.
          </Notice>
        </div>
      )}

      <Field>
        <Input
          value={filter}
          autoFocus
          placeholder="Search the menu…"
          onChange={(e) => setFilter(e.target.value)}
        />
      </Field>

      <div style={{ maxHeight: '48vh', overflowY: 'auto' }}>
        {shown.length === 0 && <p className="dim small">Nothing matches that.</p>}
        {shown.map((i) => {
          const hrs = hoursSince(i.offSince);
          return (
            <div
              key={i.$id}
              className="row"
              style={{
                justifyContent: 'space-between',
                padding: '0.5rem 0',
                borderBottom: '1px solid var(--border)',
                gap: '0.6rem',
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 550 }}>{i.name}</div>
                {i.off && (
                  <div className="small dim">
                    Off {hrs !== null && hrs >= 1 ? `for ${hrs}h` : 'just now'}
                    {i.reason ? ` · ${i.reason}` : ''}
                    {hrs !== null && hrs >= 24 && <> · <Badge tone="danger">over a day</Badge></>}
                  </div>
                )}
              </div>
              {i.off ? (
                <Button size="sm" loading={busyId === i.$id} onClick={() => onRestore(i)}>
                  Back on
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="danger"
                  loading={busyId === i.$id}
                  onClick={() => {
                    if (requireReason) {
                      setConfirming(i);
                      setReason('');
                    } else {
                      onMarkOff(i, '');
                    }
                  }}
                >
                  Run out
                </Button>
              )}
            </div>
          );
        })}
      </div>

      {confirming && (
        <Modal
          title={`${confirming.name} — what happened?`}
          onClose={() => setConfirming(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirming(null)}>Cancel</Button>
              <Button
                variant="danger"
                onClick={() => {
                  onMarkOff(confirming, reason.trim());
                  setConfirming(null);
                }}
              >
                Take it off
              </Button>
            </>
          }
        >
          <Field label="Reason" hint="A few words. It goes into tonight's summary.">
            <Textarea
              value={reason}
              autoFocus
              placeholder="Chicken finished, delivery did not arrive"
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
        </Modal>
      )}
    </Modal>
  );
}
