import { useEffect, useState } from 'react';
import { Card, Field, Input, Notice, Spinner, Toggle, Badge, Button, useToast } from '@snpos/ui';
import { db, DB_ID, listAll, humanError } from '../lib';
import { useSession } from '../session';
import { FEATURE_DEPENDENCIES, toInput, parseMoney } from '@snpos/core';
import type { FeatureFlag, Venue } from '@snpos/core';

/** One number out of a feature's config text, or the fallback if it says nothing. */
function configNumber(flag: FeatureFlag, option: string, fallback: number): number {
  try {
    const v = (JSON.parse(flag.config || '{}') as Record<string, unknown>)[option];
    return typeof v === 'number' ? v : fallback;
  } catch {
    return fallback;
  }
}

/** Plain-language labels. The keys come from scripts/schema.mjs. */
const LABELS: Record<string, { title: string; blurb: string }> = {
  // Named for receipts, but it carries every email a customer gets, and it is
  // also what makes the ordering page ask for an address in the first place.
  // Left unsaid, an owner switches this off to stop receipts and quietly stops
  // "we have your order" and "your order is ready" as well, with no sign of it
  // anywhere. It is the one switch here that does more than its name suggests.
  receipts: {
    title: 'Receipts and customer emails',
    blurb:
      'Every email a customer gets: the receipt, "we have your order" when it is accepted, and "your order is ready". '
      + 'It is also what makes the ordering page ask for an email address at all, so switching it off stops all three. '
      + 'Kitchen slips print separately and can be left off.',
  },
  preorders: { title: 'Order ahead / order while closed', blurb: 'Customers order outside opening hours for a time when you are open. The kitchen stays silent until it needs cooking.' },
  takeaway: { title: 'Takeaway and delivery', blurb: 'Orders not tied to a table, with as many pickup points per venue as you need.' },
  waste_log: { title: 'Waste log', blurb: 'Staff record spoiled or dropped food as it happens. This is what makes the stock alerts trustworthy.' },
  customers: { title: 'Customer profiles', blurb: 'Build a customer list from phone numbers or emails given at ordering. Always optional for the guest.' },
  shift_summary: { title: 'Summary at shift close', blurb: 'Sent the moment a shift ends, with stock flagged for the first time listed separately from anything low for 3+ shifts.' },
  busy_mode: {
    title: 'Kitchen busy mode',
    blurb:
      'Past the first number below, every quote gets longer by the extra minutes. Past the second, orders from '
      + 'phones stop and people are asked to order at the counter. Staff at the till are never stopped. The kitchen '
      + 'screen can also set the level by hand, which lapses on its own so nobody leaves ordering switched off.',
  },
  discounts: { title: 'Discounts and discount codes', blurb: 'Guests type a code while ordering; staff apply discounts before the bill is marked paid.' },
  /*
    These five had no entry, so they appeared on this page as their raw key
    with no explanation: a switch called `group_orders` and nothing to say
    what turning it on would do. A setting nobody can identify is a setting
    nobody turns on, which is exactly what happened to group ordering.
  */
  group_orders: {
    title: 'Group orders',
    blurb:
      'A separate, private link for parties and hotel bookings, set up under Tables. It shows only the categories '
      + 'you have marked group-only, and lets a group staying several nights book a meal at a time, each one eaten '
      + 'here or packed to take away. With this off, that link opens the ordinary menu.',
  },
  item_availability: {
    title: 'Mark a dish as run out',
    blurb: 'The 86 button on the kitchen screen. Takes a dish off the menu for the rest of service without editing it.',
  },
  combined_mode: {
    title: 'One screen for kitchen and till',
    blurb: 'For a counter where the same person cooks and takes the money, so the kitchen screen can settle a bill too.',
  },
  overdue_alerts: {
    title: 'Alerts for late tickets',
    blurb: 'The kitchen screen escalates a ticket that has waited too long, so a forgotten order announces itself.',
  },
  help: {
    title: 'In-app help',
    blurb: 'The question mark on each screen, showing the manual written for whoever is signed in.',
  },
};

/**
 * The numbers behind a switch, where leaving them unreachable would make the
 * switch a lie.
 *
 * A cap on a time slot that can only be set by editing the database is a cap
 * nobody has. Only the settings an owner would actually reach for are here;
 * the rest of each feature's config stays where it is.
 */
const NUMBERS: Record<string, {
  option: string; label: string; hint: string; fallback: number; min?: number;
  /** Shown and typed in cedis, stored in pesewas, so nobody types 200 meaning two. */
  money?: boolean;
}[]> = {
  group_orders: [
    {
      option: 'pack_fee',
      label: 'Packing charge for each meal taken away',
      hint: 'Added once per portion on a day the group chooses to take the food away. Nothing on a day they eat here. Leave at 0 to charge nothing.',
      fallback: 0,
      money: true,
    },
    {
      option: 'min_group_size',
      label: 'Smallest group that may book',
      hint: 'A booking for fewer people than this is turned away with a note saying so.',
      fallback: 6,
    },
  ],
  preorders: [
    {
      option: 'slot_capacity',
      label: 'Most orders per time slot',
      hint: 'Nought means no limit. With a limit set, a time that is full stops being offered, and two people cannot both take the last place.',
      fallback: 0,
    },
  ],
  busy_mode: [
    {
      option: 'busy_pending_threshold',
      label: 'Tickets waiting before quotes get longer',
      hint: 'Counted per side of the business, so drinks waiting at the bar do not make the kitchen look busy.',
      fallback: 12,
    },
    {
      option: 'busy_extra_minutes',
      label: 'Extra minutes to quote when busy',
      hint: 'Added to what a customer is told, so the promise is one the pass can keep.',
      fallback: 15,
    },
    {
      option: 'pause_pending_threshold',
      label: 'Tickets waiting before orders from phones stop',
      hint: 'People are asked to order at the counter instead. Staff taking orders at the till are never stopped.',
      fallback: 20,
    },
    {
      option: 'override_minutes',
      label: 'How long a level set by hand lasts (minutes)',
      hint: 'Then the ticket count takes over again. Nought means it never lapses, which risks ordering being left switched off overnight.',
      fallback: 60,
    },
  ],
};

export function FeaturesPage() {
  const toast = useToast();
  const { settings } = useSession();
  const decimals = settings?.currency_decimals ?? 2;
  const [rows, setRows] = useState<FeatureFlag[] | null>(null);
  /*
    Settings that belong to one venue rather than to the whole business.

    These used to be filtered out and never shown. A switch on this page could
    therefore read "on" while a venue quietly overruled it, and the screens
    would behave as though it were off with nothing anywhere to explain why —
    and no way to undo it from here, because the row you needed was hidden.
    Shown beneath the switch it contradicts, with a way to drop it.
  */
  const [overrides, setOverrides] = useState<FeatureFlag[]>([]);
  const [venues, setVenues] = useState<Venue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  const load = () => listAll<FeatureFlag>('feature_flags').then((r) => {
    setRows(r.filter((x) => !x.venue_id));
    setOverrides(r.filter((x) => !!x.venue_id));
  });
  useEffect(() => {
    load().catch((e) => setError(humanError(e)));
    // Only to put a name to an override. A venue list that will not load must
    // not take this page down; the id is still enough to say one exists.
    listAll<Venue>('venues').then(setVenues).catch(() => undefined);
  }, []);

  const venueName = (id: string) => venues.find((v) => v.$id === id)?.name ?? id;

  /** Drop a venue's override so the switch above governs everywhere again. */
  const dropOverride = async (row: FeatureFlag) => {
    if (!confirm(
      `Use the setting above at ${venueName(row.venue_id ?? '')} as well?`
      + ' This venue is currently set on its own.',
    )) return;
    try {
      await db.deleteDocument(DB_ID, 'feature_flags', row.$id);
      await load();
      toast('That venue now follows the setting above');
    } catch (e) {
      toast(humanError(e), 'err');
    }
  };

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

  /** One number inside a feature's config, saved on its own. */
  const setNumber = async (flag: FeatureFlag, option: string, value: number) => {
    let config: Record<string, unknown> = {};
    try {
      config = flag.config ? (JSON.parse(flag.config) as Record<string, unknown>) : {};
    } catch {
      // A config nobody can read is replaced rather than refused: the
      // alternative is a number that cannot be set and no way to say why.
      config = {};
    }
    const next = JSON.stringify({ ...config, [option]: value });
    setRows((r) => r?.map((x) => (x.$id === flag.$id ? { ...x, config: next } : x)) ?? null);
    try {
      await db.updateDocument(DB_ID, 'feature_flags', flag.$id, { config: next });
    } catch (e) {
      toast(humanError(e), 'err');
      await load().catch(() => undefined);
    }
  };

  if (error) return <Notice>{error}</Notice>;

  return (
    <>
      <h1>Features</h1>
      <p className="dim small" style={{ marginTop: 0 }}>
        Switching a feature off hides it; it never deletes what you have already recorded, so you can turn it back on
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
                  {/* A venue that has been set on its own. Named here because
                      this is the switch it disagrees with, and because a
                      feature that reads "on" while a venue has it off is the
                      hardest kind of fault to find: everything looks right. */}
                  {overrides.filter((o) => o.key === f.key).map((o) => (
                    <div key={o.$id} style={{ marginTop: '0.5rem' }}>
                      <Notice tone="warn">
                        <strong>{venueName(o.venue_id ?? '')} is set on its own</strong> and has this{' '}
                        {o.enabled ? 'switched on' : 'switched off'}
                        {o.enabled === f.enabled ? '' : ', which is the opposite of the switch here'}. The switch
                        here does not reach that venue.{' '}
                        <Button size="sm" variant="ghost" onClick={() => dropOverride(o)}>
                          Use the setting here instead
                        </Button>
                      </Notice>
                    </div>
                  ))}
                  {/* Only while the feature is on: a number that governs
                      something switched off is a question with no answer. */}
                  {f.enabled && (NUMBERS[f.key] ?? []).map((n) => (
                    <div key={n.option} style={{ marginTop: '0.6rem', maxWidth: '22rem' }}>
                      <Field label={n.label} hint={n.hint}>
                        <Input
                          type="number"
                          min={n.min ?? 0}
                          step={n.money ? '0.01' : '1'}
                          /* Money is typed the way it is spoken. Stored in
                             pesewas, so a box that took 200 for two cedis
                             would be a hundredfold mistake nobody notices
                             until a bill goes out. */
                          defaultValue={n.money
                            ? toInput(configNumber(f, n.option, n.fallback), decimals)
                            : String(configNumber(f, n.option, n.fallback))}
                          onBlur={(e) => {
                            const raw = n.money
                              ? parseMoney(e.target.value, decimals)
                              : Math.round(Number(e.target.value) || 0);
                            if (raw === null) return;
                            const v = Math.max(n.min ?? 0, raw);
                            if (v !== configNumber(f, n.option, n.fallback)) void setNumber(f, n.option, v);
                          }}
                        />
                      </Field>
                    </div>
                  ))}
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

      {/*
        An override whose switch is not on this page at all.

        Setting up only creates the group-wide row when no row with that key
        exists anywhere, so a venue-only row leaves the feature with no switch
        to appear under. Without this it would govern the screens from
        somewhere nobody can see.
      */}
      {rows && overrides.filter((o) => !rows.some((r) => r.key === o.key)).map((o) => (
        <Notice tone="warn" key={o.$id}>
          <strong>{LABELS[o.key]?.title ?? o.key}</strong> is set only at {venueName(o.venue_id ?? '')}, where it is{' '}
          {o.enabled ? 'on' : 'off'}. There is no business-wide setting for it, so it has no switch above.{' '}
          <Button size="sm" variant="ghost" onClick={() => dropOverride(o)}>Remove this setting</Button>
        </Notice>
      ))}
    </>
  );
}
