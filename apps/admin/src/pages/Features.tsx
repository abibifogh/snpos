import { useEffect, useState } from 'react';
import { Card, Notice, Spinner, Toggle, Badge, useToast } from '@snpos/ui';
import { db, DB_ID, listAll, humanError } from '../lib';
import { FEATURE_DEPENDENCIES } from '@snpos/core';
import type { FeatureFlag } from '@snpos/core';

/** Plain-language labels. The keys come from scripts/schema.mjs. */
const LABELS: Record<string, { title: string; blurb: string }> = {
  receipts: { title: 'Receipts and kitchen slips', blurb: 'Email receipts to customers. Kitchen slips print separately and can be left off.' },
  preorders: { title: 'Order ahead / order while closed', blurb: 'Customers order outside opening hours for a time when you are open. The kitchen stays silent until it needs cooking.' },
  takeaway: { title: 'Takeaway and delivery', blurb: 'Orders not tied to a table, with as many pickup points per venue as you need.' },
  waste_log: { title: 'Waste log', blurb: 'Staff record spoiled or dropped food as it happens. This is what makes the stock alerts trustworthy.' },
  time_clock: { title: 'Staff clock in / out', blurb: 'Hours worked per person, and staff cost as a share of sales.' },
  customers: { title: 'Customer profiles', blurb: 'Build a customer list from phone numbers or emails given at ordering. Always optional for the guest.' },
  loyalty: { title: 'Loyalty / stamp card', blurb: 'Points, or buy-9-get-1-free, tracked automatically.' },
  feedback: { title: 'Feedback after paying', blurb: 'A one-tap rating linked to the order, the dishes and the server.' },
  multilingual: { title: 'Multi-language menu', blurb: 'Customers pick their language when they scan.' },
  purchase_orders: { title: 'Purchase orders and receiving', blurb: 'Order from suppliers, then tick off what actually arrived. Catches short deliveries and quiet price rises.' },
  shift_summary: { title: 'Summary at shift close', blurb: 'Sent the moment a shift ends, with stock flagged for the first time listed separately from anything low for 3+ shifts.' },
  busy_mode: { title: 'Kitchen busy mode', blurb: 'When too many tickets are waiting, quote longer waits or hold new orders instead of drowning the kitchen.' },
  time_pricing: { title: 'Happy hour / time-based prices', blurb: 'Change the price customers see at certain times of day.' },
  discounts: { title: 'Discounts and discount codes', blurb: 'Guests type a code while ordering; staff apply discounts before the bill is marked paid.' },
};

export function FeaturesPage() {
  const toast = useToast();
  const [rows, setRows] = useState<FeatureFlag[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  const load = () => listAll<FeatureFlag>('feature_flags').then((r) => setRows(r.filter((x) => !x.venue_id)));
  useEffect(() => { load().catch((e) => setError(humanError(e))); }, []);

  const enabled = (key: string) => rows?.find((r) => r.key === key)?.enabled ?? false;

  const toggle = async (flag: FeatureFlag, value: boolean) => {
    setSaving(flag.key);
    // Optimistic: the switch should feel instant, and it reverts if the save fails.
    setRows((r) => r?.map((x) => (x.$id === flag.$id ? { ...x, enabled: value } : x)) ?? null);
    try {
      await db.updateDocument(DB_ID, 'feature_flags', flag.$id, { enabled: value });
      toast(`${LABELS[flag.key]?.title ?? flag.key} ${value ? 'switched on' : 'switched off'}`);
    } catch (e) {
      setRows((r) => r?.map((x) => (x.$id === flag.$id ? { ...x, enabled: !value } : x)) ?? null);
      toast(humanError(e), 'err');
    } finally {
      setSaving(null);
    }
  };

  if (error) return <Notice>{error}</Notice>;

  return (
    <>
      <h1>Features</h1>
      <p className="dim small" style={{ marginTop: 0 }}>
        Switching a feature off hides it — it never deletes what you have already recorded, so you can turn it back on
        later and find everything intact.
      </p>

      <Card pad>
        {!rows ? (
          <Spinner />
        ) : (
          rows.map((f) => {
            const meta = LABELS[f.key] ?? { title: f.key, blurb: '' };
            const unmet = (FEATURE_DEPENDENCIES[f.key] ?? []).filter((d) => !enabled(d));
            return (
              <div className="feature-row" key={f.$id}>
                <div className="meta">
                  <h3>{meta.title}</h3>
                  <div className="small dim">{meta.blurb}</div>
                  {unmet.length > 0 && (
                    <div style={{ marginTop: '0.4rem' }}>
                      <Badge tone="warn">
                        Needs {unmet.map((d) => LABELS[d]?.title ?? d).join(', ')} switched on first
                      </Badge>
                    </div>
                  )}
                </div>
                <Toggle
                  checked={f.enabled}
                  disabled={saving === f.key || unmet.length > 0}
                  onChange={(v) => toggle(f, v)}
                />
              </div>
            );
          })
        )}
      </Card>
    </>
  );
}
