import { useEffect, useState } from 'react';
import { Button, Card, Field, Input, Select, Notice, Toggle, useToast } from '@snpos/ui';
import { contrastRatio } from '@snpos/ui';
import { db, DB_ID, humanError } from '../lib';
import { bpToPercent, percentToBp } from '@snpos/core';
import type { Settings } from '@snpos/core';
import { useSession } from '../session';

export function SettingsPage() {
  const { settings, refreshSettings } = useSession();
  const toast = useToast();
  const [form, setForm] = useState<Settings | null>(settings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setForm(settings), [settings]);
  if (!form) return <Notice>Settings could not be loaded.</Notice>;

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setForm({ ...form, [key]: value });

  // A pale brand colour with white text is unreadable at a glance on a busy
  // terminal, so warn rather than let it ship silently.
  const brandContrast = contrastRatio(form.primary_color || '#0f766e', '#ffffff');

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await db.updateDocument(DB_ID, 'settings', 'main', {
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
      });
      await refreshSettings();
      toast('Settings saved');
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
    </>
  );
}
