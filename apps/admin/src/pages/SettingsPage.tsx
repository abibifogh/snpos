import { useEffect, useState } from 'react';
import { Button, Card, Field, Input, Select, Notice, Textarea, Toggle, useToast } from '@snpos/ui';
import { contrastRatio } from '@snpos/ui';
import { db, DB_ID, ID, listAll, humanError } from '../lib';
import {
  bpToPercent, percentToBp, toInput, parseMoney,
  ADMIN_SECTIONS, GRANTABLE_ROLES, parseAccess,
} from '@snpos/core';
import type { Settings, Doc } from '@snpos/core';

import { useSession } from '../session';

/**
 * Save the settings, and say exactly what did not save.
 *
 * Appwrite refuses a whole document update if one field on it does not exist
 * yet, so a single setting added since the last time provisioning was run took
 * every other setting down with it — you switched tips off, the save failed as
 * a whole, and the only clue was one line of error text that read like a
 * general problem rather than "that switch did nothing".
 *
 * So unknown fields are dropped one at a time and everything else is saved.
 * What was dropped is returned, by name, to be reported plainly.
 */
async function saveSettings(patch: Record<string, unknown>): Promise<string[]> {
  const payload = { ...patch };
  const dropped: string[] = [];

  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await db.updateDocument(DB_ID, 'settings', 'main', payload);
      return dropped;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const unknown = /unknown attribute:?\s*"?([A-Za-z0-9_]+)"?/i.exec(message);
      if (!unknown || !(unknown[1] in payload)) throw e;
      dropped.push(unknown[1]);
      delete payload[unknown[1]];
    }
  }
  throw new Error('Too many settings could not be saved. Run Provision Appwrite, then try again.');
}

/** Field names as somebody would recognise them on this page. */
const FIELD_LABELS: Record<string, string> = {
  tips_enabled: 'Tips',
  role_access: 'Who can see what',
  daily_report_hour: 'When the daily reports go out',
  shift_float_policy: 'What a shift starts with',
  shift_float_default: 'The fixed float',
  allow_negative_cash: 'Allow a drawer to close below nothing',
  stock_check_mode: 'How the stock check asks',
  stock_count_decimals: 'Part amounts in the stock count',
  order_number_prefix: 'Order number prefix',
  order_number_mode: 'Order numbering',
  order_number_padding: 'Order number length',
  order_number_next: 'Next order number',
  order_number_reset_on: 'Order numbering reset',
  email_from_name: 'Email from name',
  email_from_address: 'Email from address',
};

interface ReportSub extends Doc {
  channel: string;
  destination: string;
  events?: string[];
  active?: boolean;
}

export function SettingsPage() {
  const { settings, refreshSettings } = useSession();
  const toast = useToast();
  const [form, setForm] = useState<Settings | null>(settings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Report recipients live in their own collection rather than in settings, so
  // they are edited and saved separately from everything else on this page.
  const [reportEmails, setReportEmails] = useState('');
  const [reportKinds, setReportKinds] = useState<string[]>(['shift_close']);
  const [subs, setSubs] = useState<ReportSub[]>([]);
  const [savingSubs, setSavingSubs] = useState(false);
  const [subsError, setSubsError] = useState<string | null>(null);

  useEffect(() => setForm(settings), [settings]);

  useEffect(() => {
    listAll<ReportSub>('report_subscriptions')
      .then((rows) => {
        const mine = rows.filter((r) => r.channel === 'email');
        setSubs(mine);
        const live = mine.filter((r) => r.active !== false);
        setReportEmails(live.map((r) => r.destination).join('\n'));
        const kinds = [...new Set(live.flatMap((r) => r.events ?? []))];
        if (kinds.length) setReportKinds(kinds);
      })
      .catch(() => undefined);
  }, []);

  const saveRecipients = async () => {
    setSavingSubs(true);
    setSubsError(null);
    try {
      const wanted = reportEmails
        .split(/[\n,;]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const bad = wanted.find((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
      if (bad) throw new Error(`"${bad}" does not look like an email address.`);

      // Rows that are gone from the box are switched off rather than deleted,
      // so a report that already went to somebody still names a real record.
      for (const row of subs) {
        if (!wanted.includes(row.destination) && row.active !== false) {
          await db.updateDocument(DB_ID, 'report_subscriptions', row.$id, { active: false });
        }
      }
      for (const email of wanted) {
        const existing = subs.find((r) => r.destination === email);
        if (existing) {
          await db.updateDocument(DB_ID, 'report_subscriptions', existing.$id, {
            active: true,
            events: reportKinds,
          });
        } else {
          await db.createDocument(DB_ID, 'report_subscriptions', ID.unique(), {
            channel: 'email',
            destination: email,
            events: reportKinds,
            active: true,
          });
        }
      }

      const rows = await listAll<ReportSub>('report_subscriptions');
      setSubs(rows.filter((r) => r.channel === 'email'));
      toast(wanted.length ? `${wanted.length} recipient${wanted.length === 1 ? '' : 's'} saved` : 'Recipients cleared');
    } catch (e) {
      setSubsError(humanError(e));
    } finally {
      setSavingSubs(false);
    }
  };

  if (!form) return <Notice>Settings could not be loaded.</Notice>;

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setForm({ ...form, [key]: value });

  const access = parseAccess(form);
  const toggleAccess = (role: string, section: string) => {
    const current = access[role] ?? [];
    const next = current.includes(section) ? current.filter((s) => s !== section) : [...current, section];
    set('role_access', JSON.stringify({ ...access, [role]: next }));
  };

  // A pale brand colour with white text is unreadable at a glance on a busy
  // terminal, so warn rather than let it ship silently.
  const brandContrast = contrastRatio(form.primary_color || '#0f766e', '#ffffff');

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const dropped = await saveSettings({
        restaurant_name: form.restaurant_name,
        timezone: form.timezone,
        currency_code: form.currency_code,
        currency_symbol: form.currency_symbol,
        currency_decimals: Number(form.currency_decimals),
        symbol_position: form.symbol_position,
        primary_color: form.primary_color,
        secondary_color: form.secondary_color,
        tax_rate_bp: Number(form.tax_rate_bp),
        tax_inclusive: form.tax_inclusive,
        service_charge_bp: Number(form.service_charge_bp),
        kitchen_ack_sla_seconds: Number(form.kitchen_ack_sla_seconds),
        require_reject_reason: form.require_reject_reason,
        qr_orders_need_approval: form.qr_orders_need_approval,
        tips_enabled: form.tips_enabled ?? true,
        order_number_prefix: form.order_number_prefix ?? '',
        order_number_mode: form.order_number_mode ?? 'continuous',
        order_number_padding: Number(form.order_number_padding ?? 4),
        order_number_next: Number(form.order_number_next ?? 1),
        order_number_reset_on: form.order_number_reset_on || undefined,
        email_from_name: form.email_from_name ?? '',
        email_from_address: form.email_from_address ?? '',
        role_access: JSON.stringify(access),
        daily_report_hour: Number(form.daily_report_hour ?? 23),
        shift_float_policy: form.shift_float_policy ?? 'zero',
        shift_float_default: Number(form.shift_float_default ?? 0),
        allow_negative_cash: !!form.allow_negative_cash,
        stock_check_mode: form.stock_check_mode ?? 'levels',
        stock_count_decimals: form.stock_count_decimals !== false,
      });
      await refreshSettings();

      if (dropped.length > 0) {
        const names = dropped.map((d) => FIELD_LABELS[d] ?? d);
        setError(
          `Everything else was saved, but ${names.join(', ')} could not be — ` +
          `${dropped.length === 1 ? 'that setting does' : 'those settings do'} not exist in the database yet. ` +
          'Run "Provision Appwrite" from the Actions tab on GitHub, then save again.',
        );
        toast(`${names.length} setting${names.length === 1 ? '' : 's'} could not be saved`, 'err');
      } else {
        toast('Settings saved');
      }
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="spread">
        <h1>Settings</h1>
        <Button variant="primary" onClick={save} loading={busy}>Save changes</Button>
      </div>

      {error && <Notice>{error}</Notice>}

      <Card title="Restaurant">
        <div className="grid-2">
          <Field label="Name">
            <Input value={form.restaurant_name} onChange={(e) => set('restaurant_name', e.target.value)} />
          </Field>
          <Field label="Timezone" hint="Used for opening hours, shifts and reports.">
            <Input value={form.timezone} onChange={(e) => set('timezone', e.target.value)} />
          </Field>
        </div>
      </Card>

      <Card title="Currency">
        <div className="grid-2">
          <Field label="Code" hint="Three letters, e.g. GHS.">
            <Input value={form.currency_code} maxLength={3} onChange={(e) => set('currency_code', e.target.value.toUpperCase())} />
          </Field>
          <Field label="Symbol">
            <Input value={form.currency_symbol} onChange={(e) => set('currency_symbol', e.target.value)} />
          </Field>
          <Field label="Decimal places">
            <Select value={form.currency_decimals} onChange={(e) => set('currency_decimals', Number(e.target.value))}>
              <option value={0}>0 — whole units</option>
              <option value={2}>2 — standard</option>
              <option value={3}>3</option>
            </Select>
          </Field>
          <Field label="Symbol position">
            <Select value={form.symbol_position} onChange={(e) => set('symbol_position', e.target.value as 'before' | 'after')}>
              <option value="before">Before — {form.currency_symbol}10.00</option>
              <option value="after">After — 10.00{form.currency_symbol}</option>
            </Select>
          </Field>
        </div>
      </Card>

      <Card title="Tax and service">
        <div className="grid-2">
          <Field label="Tax rate (%)" hint="0 if you do not charge tax.">
            <Input
              type="number"
              step="0.01"
              min="0"
              value={bpToPercent(form.tax_rate_bp)}
              onChange={(e) => set('tax_rate_bp', percentToBp(e.target.value))}
            />
          </Field>
          <Field label="Service charge (%)">
            <Input
              type="number"
              step="0.01"
              min="0"
              value={bpToPercent(form.service_charge_bp)}
              onChange={(e) => set('service_charge_bp', percentToBp(e.target.value))}
            />
          </Field>
        </div>
        <Field hint="Tax-inclusive means the price on the menu is what the customer pays; tax is worked out from it rather than added on top.">
          <Toggle checked={form.tax_inclusive} onChange={(v) => set('tax_inclusive', v)} label="Menu prices include tax" />
        </Field>
      </Card>

      <Card title="Colours">
        <div className="grid-2">
          <Field label="Primary">
            <div className="color-row">
              <input type="color" value={form.primary_color} onChange={(e) => set('primary_color', e.target.value)} />
              <Input value={form.primary_color} onChange={(e) => set('primary_color', e.target.value)} />
            </div>
          </Field>
          <Field label="Secondary">
            <div className="color-row">
              <input type="color" value={form.secondary_color} onChange={(e) => set('secondary_color', e.target.value)} />
              <Input value={form.secondary_color} onChange={(e) => set('secondary_color', e.target.value)} />
            </div>
          </Field>
        </div>
        {brandContrast < 3 && (
          <Notice tone="warn">
            White text on this primary colour has a contrast ratio of {brandContrast.toFixed(1)}:1. Buttons will be hard
            to read — the app will use dark text instead, but a deeper colour would look better.
          </Notice>
        )}
      </Card>

      <Card title="Tips">
        <Toggle
          checked={form.tips_enabled ?? true}
          onChange={(v) => set('tips_enabled', v)}
          label="Ask for a tip when taking payment"
        />
        <p className="small dim" style={{ marginBottom: 0 }}>
          Off removes the box entirely rather than defaulting it to zero — a field staff have to look at and skip
          past on every bill is worse than no field.
        </p>
        {/* What the database currently holds, not what this form is showing.
            The two disagreeing is the whole reason this switch appeared not to
            work, and the difference was invisible. */}
        <p className="small" style={{ marginBottom: 0 }}>
          Right now the till and the kitchen are{' '}
          <strong>{settings?.tips_enabled === false ? 'not asking for a tip' : 'asking for a tip'}</strong>.
          {settings?.tips_enabled !== form.tips_enabled && ' Unsaved change — press Save changes.'}
        </p>
      </Card>

      <Card title="Order numbers">
        <p className="small dim" style={{ marginTop: 0 }}>
          These get shouted across a pass, so they are yours to shape. The number shown is{' '}
          <strong>
            {(form.order_number_prefix ?? '') +
              String(form.order_number_next ?? 1).padStart(Math.max(1, Number(form.order_number_padding ?? 4)), '0')}
          </strong>
          .
        </p>
        <div className="grid-2">
          <Field label="Prefix" hint="Letters before the number. Leave blank for none.">
            <Input
              value={form.order_number_prefix ?? ''}
              maxLength={8}
              onChange={(e) => set('order_number_prefix', e.target.value.toUpperCase())}
            />
          </Field>
          <Field label="Digits" hint="4 gives ORD0001. 3 gives ORD001.">
            <Input
              type="number"
              min="1"
              max="8"
              value={form.order_number_padding ?? 4}
              onChange={(e) => set('order_number_padding', Number(e.target.value))}
            />
          </Field>
        </div>
        <Field label="Counting">
          <Select
            value={form.order_number_mode ?? 'continuous'}
            onChange={(e) => set('order_number_mode', e.target.value as 'continuous' | 'daily')}
          >
            <option value="continuous">Keep counting — numbers never repeat</option>
            <option value="daily">Start again each morning — lower numbers, repeated daily</option>
          </Select>
        </Field>

        <Field
          label="Start counting again from"
          hint="Changing this does not touch any order already placed; it only decides what the next one is called."
        >
          <div className="row">
            <Input
              type="number"
              min="1"
              style={{ maxWidth: '9rem' }}
              value={form.order_number_next ?? 1}
              onChange={(e) => set('order_number_next', Number(e.target.value))}
            />
            <Button
              size="sm"
              onClick={() => {
                if (!confirm('Restart the numbering from here? Existing orders keep the numbers they already have.')) return;
                // The reset moment is what makes the restart stick: numbering
                // counts from the last order placed AFTER this, so yesterday's
                // ORD0450 does not drag the next one back up to 451.
                set('order_number_reset_on', new Date().toISOString());
              }}
            >
              Restart from here
            </Button>
          </div>
        </Field>
        {form.order_number_reset_on && (
          <p className="small dim" style={{ marginTop: 0 }}>
            Numbering was last restarted on {new Date(form.order_number_reset_on).toLocaleString()}.
            {' '}Remember to press Save.
          </p>
        )}
      </Card>

      <Card title="Kitchen">
        <div className="grid-2">
          <Field label="Alarm escalates after (seconds)" hint="How long an order may sit unacknowledged before the alarm gets louder.">
            <Input
              type="number"
              min="10"
              value={form.kitchen_ack_sla_seconds}
              onChange={(e) => set('kitchen_ack_sla_seconds', Number(e.target.value))}
            />
          </Field>
        </div>
        <Field>
          <Toggle
            checked={form.require_reject_reason}
            onChange={(v) => set('require_reject_reason', v)}
            label="Require a reason when the kitchen rejects an order"
          />
        </Field>
        <Field hint="Leave off for the usual flow, where a customer's order goes straight to the kitchen.">
          <Toggle
            checked={form.qr_orders_need_approval}
            onChange={(v) => set('qr_orders_need_approval', v)}
            label="Staff must approve QR orders before the kitchen sees them"
          />
        </Field>
      </Card>

      <Card title="Email">
        <div className="grid-2">
          <Field label="From name" hint="Shown as the sender on emailed receipts.">
            <Input value={form.email_from_name ?? ''} onChange={(e) => set('email_from_name', e.target.value)} />
          </Field>
          <Field
            label="From address"
            hint="Must be an address your email provider has verified as a sender."
          >
            <Input type="email" value={form.email_from_address ?? ''} onChange={(e) => set('email_from_address', e.target.value)} />
          </Field>
        </div>
        <Notice tone="warn">
          <strong>This address has to be verified with your email provider.</strong> Brevo and the others accept the
          message, report success, and then quietly drop it if the from-address is not one of their verified senders —
          so receipts show as <em>sent</em> here and never arrive. If that is happening, this is almost always why.
          Check Brevo → Senders, Domains &amp; Dedicated IPs → Senders, and put exactly that address here.
        </Notice>
      </Card>

      <Card title="Cash and shifts">
        <Field
          label="What a shift starts with in the drawer"
          hint="Starting at nothing every time only makes sense if somebody physically empties the till at the end of each shift."
        >
          <Select
            value={form.shift_float_policy ?? 'zero'}
            onChange={(e) => set('shift_float_policy', e.target.value as Settings['shift_float_policy'])}
          >
            <option value="zero">Nothing — count in whatever is there</option>
            <option value="carry_over">Carry over what the last shift counted</option>
            <option value="fixed">A fixed float, the same every time</option>
            <option value="prompt">Ask, with nothing filled in</option>
          </Select>
        </Field>

        {form.shift_float_policy === 'fixed' && (
          <Field label={`The fixed float (${form.currency_symbol})`}>
            <Input
              inputMode="decimal"
              value={toInput(form.shift_float_default ?? 0, form.currency_decimals ?? 2)}
              onChange={(e) =>
                set('shift_float_default', parseMoney(e.target.value, form.currency_decimals ?? 2) ?? 0)
              }
            />
          </Field>
        )}

        <Toggle
          checked={!!form.allow_negative_cash}
          onChange={(v) => set('allow_negative_cash', v)}
          label="Allow a drawer to close below nothing"
        />
        <p className="small dim" style={{ marginBottom: 0 }}>
          Off is the safer setting and the default. A drawer cannot physically hold less than no money, so a negative
          count nearly always means cash was paid out and never recorded — blocking it makes somebody enter the missing
          expense instead of closing over it.
        </p>
      </Card>

      <Card title="The stock check at the end of a shift">
        <Field
          label="What staff are asked"
          hint="Both end up in the same place — an OK, Low or Out against every ingredient. The difference is who decides which."
        >
          <Select
            value={form.stock_check_mode ?? 'levels'}
            onChange={(e) => set('stock_check_mode', e.target.value as Settings['stock_check_mode'])}
          >
            <option value="levels">Tap OK, Low or Out</option>
            <option value="counts">Type how much is left, and let the system decide</option>
          </Select>
        </Field>

        <p className="small dim">
          {form.stock_check_mode === 'counts' ? (
            <>
              Staff type what is actually on the shelf and the system reads it against each ingredient's low level. It
              takes longer, and it buys two things a tapped level cannot: the same shelf gets filed the same way
              whoever is closing, and what was counted can be set against what the recipes say should have gone —
              which is the only way over-portioning, waste and theft ever show up. Set the low level for each
              ingredient under <strong>Stock</strong>, or nothing above zero can be called low.
            </>
          ) : (
            <>
              Quick, and honest about being a glance at a shelf rather than a measurement. Fine for a small kitchen
              where the same person closes most nights. Write a guide under each ingredient in <strong>Stock</strong>
              {' '}so “low” means the same thing to everybody.
            </>
          )}
        </p>

        {form.stock_check_mode === 'counts' && (
          <>
            <Toggle
              checked={form.stock_count_decimals !== false}
              onChange={(v) => set('stock_count_decimals', v)}
              label="Allow part amounts — 0.5, 0.25"
            />
            <p className="small dim" style={{ marginBottom: 0 }}>
              On for anything measured: half a bucket of rice, a quarter bottle of oil. Off for anything counted in
              pieces — nobody has 2.5 eggs, and a till with a numeric keypad will produce one by accident if the
              decimal point is there to be pressed.
            </p>
          </>
        )}
      </Card>

      <Card title="Reports and backups by email">
        <p className="small dim" style={{ marginTop: 0 }}>
          One address per line. Everyone listed gets whichever reports are ticked below.
        </p>

        {[
          {
            key: 'shift_close',
            label: 'End-of-shift report',
            hint: 'The moment a shift closes: takings, anything short, what ran out, who did what.',
          },
          {
            key: 'daily_digest',
            label: 'Daily summary',
            hint: 'Once a day after close. A day with two shifts produces two shift reports and no figure for the day — this is that figure.',
          },
          {
            key: 'backup',
            label: 'Nightly backup',
            hint: 'Every record as spreadsheets, attached. This hosting plan keeps no backups of its own, so this is your only copy — keep one somewhere other than your inbox.',
          },
        ].map((k) => (
          <label key={k.key} className="check-row" style={{ display: 'block', marginBottom: '0.6rem' }}>
            <input
              type="checkbox"
              checked={reportKinds.includes(k.key)}
              onChange={() =>
                setReportKinds((r) => (r.includes(k.key) ? r.filter((x) => x !== k.key) : [...r, k.key]))
              }
            />{' '}
            <strong>{k.label}</strong>
            <div className="small dim" style={{ marginLeft: '1.6rem' }}>{k.hint}</div>
          </label>
        ))}

        <Field
          label="When the daily ones go out"
          hint="In your own timezone, after service. Midnight would catch a kitchen still serving."
        >
          <Select
            value={form.daily_report_hour ?? 23}
            onChange={(e) => set('daily_report_hour', Number(e.target.value))}
          >
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
            ))}
          </Select>
        </Field>

        <Field
          label="Email addresses"
          hint="With none of these set, reports are still worked out and saved, but nobody is sent them. That is the usual reason for a report that never arrives."
        >
          <Textarea
            rows={4}
            value={reportEmails}
            placeholder={'owner@restaurant.com\nmanager@restaurant.com'}
            onChange={(e) => setReportEmails(e.target.value)}
          />
        </Field>
        {subsError && <Notice>{subsError}</Notice>}
        <Button onClick={() => void saveRecipients()} loading={savingSubs}>
          Save recipients
        </Button>
      </Card>

      <Card title="Who can see what">
        <p className="small dim" style={{ marginTop: 0 }}>
          Which parts of this admin app each role can open. Admins always see everything — there is no switch for that
          on purpose, because a checkbox that can lock the owner out of their own settings eventually will.
        </p>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th style={{ minWidth: '11rem' }}>Page</th>
                {GRANTABLE_ROLES.map((r) => (
                  <th key={r} style={{ textAlign: 'center', textTransform: 'capitalize' }}>{r}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ADMIN_SECTIONS.map((section) => (
                <tr key={section.key}>
                  <td>
                    {section.label}
                    <div className="small dim">{section.group}</div>
                  </td>
                  {GRANTABLE_ROLES.map((role) => (
                    <td key={role} style={{ textAlign: 'center' }}>
                      {section.ownerOnly ? (
                        <span className="small dim" title="Admins only">—</span>
                      ) : (
                        <input
                          type="checkbox"
                          checked={(access[role] ?? []).includes(section.key)}
                          onChange={() => toggleAccess(role, section.key)}
                          aria-label={`${role} can open ${section.label}`}
                        />
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small dim">
          Changes take effect the next time that person loads the app.
        </p>
      </Card>
    </>
  );
}
