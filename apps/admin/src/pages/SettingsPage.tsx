import { useEffect, useState } from 'react';
import { Badge, Button, FoldCard, Field, Input, Select, Notice, Textarea, Toggle, useToast } from '@snpos/ui';
import { contrastRatio } from '@snpos/ui';
import { db, DB_ID, ID, listAll, humanError } from '../lib';
import {
  bpToPercent, percentToBp, toInput, parseMoney,
  ADMIN_SECTIONS, GRANTABLE_ROLES, DEFAULT_ACCESS, parseAccess, asksForTip, modulesOf, saveDropping,
} from '@snpos/core';
import type { Settings, Doc } from '@snpos/core';

import { useSession } from '../session';

/**
 * Save the settings, and say exactly what did not save.
 *
 * Appwrite refuses a whole document update if one field on it does not exist
 * yet, so a single setting added since the last time provisioning was run took
 * every other setting down with it, you switched tips off, the save failed as
 * a whole, and the only clue was one line of error text that read like a
 * general problem rather than "that switch did nothing".
 *
 * So unknown fields are dropped one at a time and everything else is saved.
 * What was dropped is returned, by name, to be reported plainly.
 */
async function saveSettings(patch: Record<string, unknown>): Promise<string[]> {
  // One implementation, in core, shared with everything else that writes to a
  // database a release ahead of its provisioning. This page carried a second
  // copy of the same loop, which is one more place for the two to disagree
  // about what counts as an unknown field.
  const { dropped } = await saveDropping('settings', 'main', patch);
  return dropped;
}

/** Field names as somebody would recognise them on this page. */
const FIELD_LABELS: Record<string, string> = {
  tips_enabled: 'Tips',
  tips_ask_on: 'Where to ask for a tip',
  role_access: 'Who can see what',
  daily_report_hour: 'When the daily reports go out',
  shift_float_policy: 'What a shift starts with',
  shift_float_default: 'The fixed float',
  allow_negative_cash: 'Allow a drawer to close below nothing',
  stock_check_mode: 'How the stock check asks',
  stock_count_decimals: 'Part amounts in the stock count',
  bar_count_skippable: 'Letting staff skip the bar count',
  imprest_custodian_counts: 'Letting a petty cash holder count their own box',
  expense_paid_from: 'What money spent during a shift can come out of',
  kitchen_enabled: 'The kitchen side',
  craft_enabled: 'The craft shop side',
  bar_enabled: 'The bar side',
  self_order_enabled: 'Customers ordering for themselves',
  default_commission_bp: 'Default commission',
  craft_order_prefix: 'Craft sale number prefix',
  order_number_prefix: 'Order number prefix',
  order_number_mode: 'Order numbering',
  order_number_padding: 'Order number length',
  idle_minutes: 'Idle clock',
  margin_warn_bp: 'Thin-margin line',
  order_number_next: 'Next order number',
  order_number_reset_on: 'Order numbering reset',
  email_from_name: 'Email from name',
  email_from_address: 'Email from address',
};

/** The float policy, in the four words a heading has room for. */
const FLOAT_WORDS: Record<string, string> = {
  zero: 'Starts empty',
  carry_over: 'Carries over',
  fixed: 'Fixed float',
  prompt: 'Asked each time',
};

const REPORT_NAMES: Record<string, string> = {
  shift_close: 'End-of-shift report',
  daily_digest: 'Daily summary',
  backup: 'Nightly backup',
};

interface Delivery extends Doc {
  kind: 'shift_close' | 'daily_digest' | 'backup';
  delivery_status: 'queued' | 'sent' | 'partial' | 'failed';
  last_error?: string;
  delivered_to?: string;
  /** The mail server's own reference for the message, and its reply. */
  provider_ref?: string;
  provider_reply?: string;
}

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
  // What the server actually did with the last few reports. The failures this
  // system can have are invisible ones, "sent to nobody" looks identical to
  // "sent" from every screen, so the record is put where somebody wondering
  // why nothing arrives will look.
  const [deliveries, setDeliveries] = useState<Delivery[] | null>(null);
  const [savingSubs, setSavingSubs] = useState(false);
  const [subsError, setSubsError] = useState<string | null>(null);

  useEffect(() => setForm(settings), [settings]);

  useEffect(() => {
    listAll<Delivery>('summary_reports')
      .then((rows) =>
        setDeliveries(rows.sort((a, b) => b.$createdAt.localeCompare(a.$createdAt)).slice(0, 8)),
      )
      .catch(() => setDeliveries([]));
  }, []);

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

  // Read through modulesOf rather than off the form, so an older setup that
  // only ever said "craft_shop" shows its switches in the right position.
  const mods = modulesOf(form);

  // The tip question, read the same way the till and the kitchen read it, so
  // this page cannot claim one thing while the screens do another.
  const savedAskOn = settings?.tips_enabled === false ? 'none' : settings?.tips_ask_on ?? 'both';
  const askOn = form.tips_enabled === false ? 'none' : form.tips_ask_on ?? 'both';
  const savedAsks = (where: 'till' | 'kitchen') => asksForTip(settings ?? {}, where);

  const access = parseAccess(form);
  const toggleAccess = (role: string, section: string) => {
    const current = access[role] ?? [];
    const next = current.includes(section) ? current.filter((s) => s !== section) : [...current, section];
    /**
     * Every section on the screen is written down as decided.
     *
     * Without this, a section nobody has ticked reads as one nobody has been
     * asked about, and a role's default for it comes straight back — so
     * unticking the last box for a page did nothing at all, with nothing on
     * screen to explain why. The list is what tells the difference between "no
     * for this role" and "this page did not exist when the choices were made".
     */
    /**
     * Only the sections that have a default worth restoring.
     *
     * A section nobody starts with is never added back by anything, so listing
     * it here says nothing and costs room — and this whole thing is one string
     * with a length limit on it. Four roles' lists plus every section name in
     * the app can run past that limit, and a save that is too long to store is
     * a save that silently does not happen, which is the exact symptom this
     * was meant to cure.
     */
    set('role_access', JSON.stringify({
      ...access,
      [role]: next,
      _known: [...new Set(Object.values(DEFAULT_ACCESS).flat())],
    }));
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
        tips_ask_on: askOn,
        order_number_prefix: form.order_number_prefix ?? '',
        order_number_mode: form.order_number_mode ?? 'continuous',
        order_number_padding: Number(form.order_number_padding ?? 4),
        idle_minutes: Math.max(0, Math.floor(Number(form.idle_minutes ?? 0))),
        margin_warn_bp: Math.max(0, Math.min(10000, Math.round(Number(form.margin_warn_bp ?? 3000)))),
        order_number_next: Number(form.order_number_next ?? 1),
        order_number_reset_on: form.order_number_reset_on || undefined,
        email_from_name: form.email_from_name ?? '',
        email_from_address: form.email_from_address ?? '',
        /**
         * The form's own string, not the parsed view of it.
         *
         * This wrote `JSON.stringify(access)`, and `access` is the MERGED
         * reading — role to sections, with the marker saying which sections
         * had been decided stripped out of it. So every save threw that
         * marker away, and on the next read a section nobody had ticked
         * looked undecided again and the role's default came straight back.
         *
         * That is the whole of why unticking a box did not stick: not the
         * checkbox, not the parse, but the save quietly writing back a
         * different shape from the one it was given.
         */
        role_access: form.role_access
          ?? JSON.stringify({ ...access, _known: [...new Set(Object.values(DEFAULT_ACCESS).flat())] }),
        daily_report_hour: Number(form.daily_report_hour ?? 23),
        shift_float_policy: form.shift_float_policy ?? 'zero',
        shift_float_default: Number(form.shift_float_default ?? 0),
        allow_negative_cash: !!form.allow_negative_cash,
        stock_check_mode: form.stock_check_mode ?? 'levels',
        stock_count_decimals: form.stock_count_decimals !== false,
        bar_count_skippable: form.bar_count_skippable === true,
        imprest_custodian_counts: form.imprest_custodian_counts === true,
        expense_paid_from: form.expense_paid_from ?? 'cash_only',
        kitchen_enabled: mods.kitchen,
        craft_enabled: mods.craft,
        bar_enabled: mods.bar,
        self_order_enabled: form.self_order_enabled !== false,
        default_commission_bp: Number(form.default_commission_bp ?? 3000),
        craft_order_prefix: form.craft_order_prefix ?? 'S',
      });
      await refreshSettings();

      if (dropped.length > 0) {
        const names = dropped.map((d) => FIELD_LABELS[d] ?? d);
        setError(
          `Everything else was saved, but ${names.join(', ')} could not be, ` +
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

      {/* Nine folds instead of thirteen cards, and only the first open.
          A settings page is read twice: once on the day it is set up, and
          afterwards only to change one thing. Thirteen open sections serve
          neither, the first reading has no shape and the second is a scroll
          past twelve things to reach one. Each heading carries what is
          currently set, so most questions are answered without opening it. */}
      <FoldCard
        title="The basics"
        open
        summary={`${form.restaurant_name || 'Unnamed'} · ${[mods.kitchen && 'kitchen', mods.craft && 'craft shop'].filter(Boolean).join(' + ')}`}
      >
        <div className="grid-2">
          <Field label="Name">
            <Input value={form.restaurant_name} onChange={(e) => set('restaurant_name', e.target.value)} />
          </Field>
          <Field label="Timezone" hint="Used for opening hours, shifts and reports.">
            <Input value={form.timezone} onChange={(e) => set('timezone', e.target.value)} />
          </Field>
        </div>

        <h3 style={{ marginTop: '1.6rem' }}>What this business runs</h3>
        <p className="small dim" style={{ marginTop: 0 }}>
          Switch on whichever sides you actually run. They can run together under one set of staff and one set
          of books — a kitchen with a bar and a craft corner is one business, not three systems. Each keeps its
          own shift and its own drawer, so a short till always has exactly one person to ask.
        </p>

        <Toggle
          checked={mods.kitchen}
          onChange={(v) => set('kitchen_enabled', v || (!mods.craft && !mods.bar))}
          label="Kitchen, food and drink"
        />
        <Toggle
          checked={mods.craft}
          onChange={(v) => set('craft_enabled', v || (!mods.kitchen && !mods.bar))}
          label="Craft shop, goods sold on consignment"
        />
        {/* Its own side rather than a category of drinks on the kitchen's
            menu. A bar counts bottles at both ends of a shift, pours cocktails
            whose ingredients leave the shelf as they are poured, and answers
            for its own drawer — folded into the kitchen, a short till has two
            possible owners and therefore none. */}
        <Toggle
          checked={mods.bar}
          onChange={(v) => set('bar_enabled', v || (!mods.kitchen && !mods.craft))}
          label="Bar, bottles and cocktails counted in and out"
        />
        {/* Refusing to turn the last one off rather than letting somebody
            discover an admin app with nothing in it. The toggle simply does
            not move, and this says why before they try. */}
        <p className="small dim">
          One of these has to stay on. Turning a side off only hides its sections, the products, sales and
          statements behind them stay exactly where they are.
        </p>

        {mods.craft && (
          <>
            <Field
              label="Craft sale number prefix"
              hint="Shop sales count on their own, so a shop receipt and a restaurant receipt can never wear the same number. Blank uses the same prefix as the kitchen."
            >
              <Input
                value={form.craft_order_prefix ?? 'S'}
                onChange={(e) => set('craft_order_prefix', e.target.value)}
              />
            </Field>
            <Field
              label="Commission you keep by default (%)"
              hint="Used for a new consignor until you set theirs. Each person can have their own rate, and each piece can override that again."
            >
              <Input
                inputMode="decimal"
                value={String((form.default_commission_bp ?? 3000) / 100)}
                onChange={(e) => {
                  const pct = Number(e.target.value);
                  if (Number.isFinite(pct)) set('default_commission_bp', Math.round(pct * 100));
                }}
              />
            </Field>
            <p className="small dim">
              Changing this never rewrites anything. The rate is written onto each sale as it happens, so what
              somebody has already earned stays what they earned.
            </p>
          </>
        )}

        <Toggle
          checked={form.self_order_enabled !== false}
          onChange={(v) => set('self_order_enabled', v)}
          label="Customers can scan a code and order for themselves"
        />
        <p className="small dim" style={{ marginBottom: 0 }}>
          {mods.kitchen
            ? 'This is what the table QR codes are for. Off means orders can only be taken by staff.'
            : 'Off suits a shop where the normal way to buy is to hand something to whoever is on the till. Worth turning on for a market stall or a busy weekend, where a queue is the problem.'}
        </p>
      </FoldCard>

      <FoldCard
        title="Money"
        summary={`${form.currency_code} · tax ${bpToPercent(form.tax_rate_bp)}% · service ${bpToPercent(form.service_charge_bp)}%`}
      >
        <div className="grid-2">
          <Field label="Code" hint="Three letters, e.g. GHS.">
            <Input value={form.currency_code} maxLength={3} onChange={(e) => set('currency_code', e.target.value.toUpperCase())} />
          </Field>
          <Field label="Symbol">
            <Input value={form.currency_symbol} onChange={(e) => set('currency_symbol', e.target.value)} />
          </Field>
          <Field label="Decimal places">
            <Select value={form.currency_decimals} onChange={(e) => set('currency_decimals', Number(e.target.value))}>
              <option value={0}>0, whole units</option>
              <option value={2}>2, standard</option>
              <option value={3}>3</option>
            </Select>
          </Field>
          <Field label="Symbol position">
            <Select value={form.symbol_position} onChange={(e) => set('symbol_position', e.target.value as 'before' | 'after')}>
              <option value="before">Before, {form.currency_symbol}10.00</option>
              <option value="after">After, 10.00{form.currency_symbol}</option>
            </Select>
          </Field>
        </div>

        <h3 style={{ marginTop: '1.6rem' }}>When a till is left alone</h3>
        <div className="grid-2">
          <Field
            label="Show the clock after (minutes)"
            hint="0 turns it off. A till left this long puts up a clock; a touch, or an order arriving, brings it back."
          >
            <Input
              type="number"
              step="1"
              min="0"
              value={form.idle_minutes ?? 0}
              onChange={(e) => set('idle_minutes', Math.max(0, Math.floor(Number(e.target.value) || 0)))}
            />
          </Field>
        </div>

        <h3 style={{ marginTop: '1.6rem' }}>Margins</h3>
        <div className="grid-2">
          <Field
            label="Flag a margin below (%)"
            hint="Shown on the drinks and dishes lists, to admins only. An item with no recipe is never flagged — that is an unanswered question, not a thin margin."
          >
            <Input
              type="number"
              step="1"
              min="0"
              max="100"
              value={((form.margin_warn_bp ?? 3000) / 100).toFixed(0)}
              onChange={(e) => set('margin_warn_bp', Math.max(0, Math.min(10000, Math.round(Number(e.target.value) * 100) || 0)))}
            />
          </Field>
        </div>

        <h3 style={{ marginTop: '1.6rem' }}>Tax and service</h3>
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
      </FoldCard>

      <FoldCard title="Tips" summary={askOn === 'none' ? 'Never asked' : `Asked on the ${askOn === 'both' ? 'till and in the kitchen' : askOn}`}>
        <Field
          label="Where to ask for a tip"
          hint="A waiter closing a table and a cook handing a bag over a counter are different moments. You can have the box on one and not the other."
        >
          <Select
            value={askOn}
            onChange={(e) => {
              const v = e.target.value as NonNullable<Settings['tips_ask_on']>;
              // Both are written. The older switch is what an app reads if it
              // has not been updated, or if this database predates the newer
              // one, leaving them to disagree is how a setting appears to do
              // nothing on one screen.
              setForm({ ...form, tips_ask_on: v, tips_enabled: v !== 'none' });
            }}
          >
            <option value="both">On the till and in the kitchen</option>
            <option value="till">Only on the till</option>
            <option value="kitchen">Only in the kitchen</option>
            <option value="none">Nowhere, never ask</option>
          </Select>
        </Field>
        <p className="small dim">
          Off removes the box entirely rather than defaulting it to zero, a field staff have to look at and skip
          past on every bill is worse than no field.
        </p>
        {/* What the database currently holds, not what this form is showing.
            The two disagreeing is the whole reason this switch appeared not to
            work, and the difference was invisible. */}
        <p className="small" style={{ marginBottom: 0 }}>
          Saved right now: the till is <strong>{savedAsks('till') ? 'asking' : 'not asking'}</strong>, the kitchen is{' '}
          <strong>{savedAsks('kitchen') ? 'asking' : 'not asking'}</strong>.
          {askOn !== savedAskOn && ' Unsaved change, press Save changes.'}
        </p>
      </FoldCard>

      <FoldCard title="Cash and shifts" summary={`${FLOAT_WORDS[form.shift_float_policy ?? 'zero']} · ${form.expense_paid_from === 'any' ? 'expenses any method' : 'expenses cash only'}`}>
        <Field
          label="What a shift starts with in the drawer"
          hint="Starting at nothing every time only makes sense if somebody physically empties the till at the end of each shift."
        >
          <Select
            value={form.shift_float_policy ?? 'zero'}
            onChange={(e) => set('shift_float_policy', e.target.value as Settings['shift_float_policy'])}
          >
            <option value="zero">Nothing, count in whatever is there</option>
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
        <p className="small dim">
          Off is the safer setting and the default. A drawer cannot physically hold less than no money, so a negative
          count nearly always means cash was paid out and never recorded, blocking it makes somebody enter the missing
          expense instead of closing over it.
        </p>

        <Field
          label="What money spent during a shift can come out of"
          hint="This covers shop runs, gas, transport; anything staff record as spent while a shift is open."
        >
          <Select
            value={form.expense_paid_from ?? 'cash_only'}
            onChange={(e) => set('expense_paid_from', e.target.value as Settings['expense_paid_from'])}
          >
            <option value="cash_only">Cash only</option>
            <option value="any">Any payment method</option>
          </Select>
        </Field>
        <p className="small dim" style={{ marginBottom: 0 }}>
          Cash only is the default, and it is not about tidiness. Money taken from the drawer has to be missing
          from the drawer when it is counted at the end of the shift, so a wrong entry surfaces within hours.
          An expense recorded against mobile money reduces nothing anybody counts, which makes it the easiest
          entry in the whole system to write and never have questioned. Turn it on only if you genuinely pay
          suppliers by transfer from this screen, and expect those entries to rest on the receipt rather than on
          a count.
        </p>

        <h3 style={{ marginTop: '1.6rem' }}>The stock check at the end of a shift</h3>
        <Field
          label="What staff are asked"
          hint="Both end up in the same place, an OK, Low or Out against every ingredient. The difference is who decides which."
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
              whoever is closing, and what was counted can be set against what the recipes say should have gone, 
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
              label="Allow part amounts, 0.5, 0.25"
            />
            <p className="small dim" style={{ marginBottom: 0 }}>
              On for anything measured: half a bucket of rice, a quarter bottle of oil. Off for anything counted in
              pieces, nobody has 2.5 eggs, and a till with a numeric keypad will produce one by accident if the
              decimal point is there to be pressed.
            </p>
          </>
        )}

        {/* Only where there is a bar. A kitchen counts once, at the end, and
            nobody hands the rice over. */}
        {form.bar_enabled && (
          <>
            <h3 style={{ marginTop: '1.6rem' }}>The bar&rsquo;s count at both ends of a shift</h3>
            <p className="small dim" style={{ marginTop: 0 }}>
              The bar is counted when a shift opens and again when it closes: one person accepts what is behind
              the bar, the next hands it over, and the difference is what somebody is answerable for. Both counts
              happen at the till.
            </p>
            <Toggle
              checked={form.bar_count_skippable === true}
              onChange={(v) => set('bar_count_skippable', v)}
              label="Let staff skip the count"
            />
            <p className="small dim" style={{ marginBottom: 0 }}>
              {form.bar_count_skippable === true ? (
                <>
                  <strong>On.</strong> Staff can leave the sheet unfinished and carry on, and a shift can close
                  on a shelf nobody counted. It gets skipped on the busy nights, which are the nights it would
                  have caught something — a shortage then has two shifts it could belong to and no way to choose
                  between them. Turn this on only if the count genuinely cannot be made every time.
                </>
              ) : (
                <>
                  <strong>Off, which is the safe setting.</strong> Every line has to be answered before the bar
                  can be accepted or handed over. There is no way past it at the till, so leave this off unless
                  somebody is stuck. A shelf with nothing set up on it, or a sheet that will not load, lets
                  people through either way — nobody is ever locked out of the till over a count the system
                  cannot describe.
                </>
              )}
            </p>
          </>
        )}
        <h3 style={{ marginTop: '1.6rem' }}>Petty cash counts</h3>
        <p className="small dim" style={{ marginTop: 0 }}>
          A petty cash box is counted against what its records say should be in it. That count is the check on
          whoever holds the box, which is why it is normally somebody else who makes it.
        </p>
        <Toggle
          checked={form.imprest_custodian_counts === true}
          onChange={(v) => set('imprest_custodian_counts', v)}
          label="Let whoever holds a box count it themselves"
        />
        <p className="small dim" style={{ marginBottom: 0 }}>
          {form.imprest_custodian_counts === true ? (
            <>
              <strong>On.</strong> The person holding a box can count it and settle any difference. That is the
              only moment the system catches a shortage, and it catches nothing when the person answerable for
              the money is the one answering — a figure typed to match makes a shortage disappear. Turn this on
              where there genuinely is nobody else to count, which is a real situation and better than a box
              nobody counts at all.
            </>
          ) : (
            <>
              <strong>Off, which is the safe setting.</strong> Whoever holds a box can spend from it and see its
              history, but the count is made by an admin or by somebody granted{' '}
              <strong>Put money into petty cash boxes</strong> under Staff. The screen says so where the button
              would have been, so a missing button is never a mystery.
            </>
          )}
        </p>
      </FoldCard>

      <FoldCard title="Orders and the kitchen" summary={`Numbers ${form.order_number_prefix ?? ''}0001 · ping every ${form.kitchen_ack_sla_seconds ?? 60}s`}>
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
            <option value="continuous">Keep counting, numbers never repeat</option>
            <option value="daily">Start again each morning, lower numbers, repeated daily</option>
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

        <h3 style={{ marginTop: '1.6rem' }}>Kitchen</h3>
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
      </FoldCard>

      <FoldCard
        title="Reports, backups and email"
        summary={subs.filter((r) => r.active !== false).length === 0
          ? 'Going to nobody'
          : `${subs.filter((r) => r.active !== false).length} recipient${subs.filter((r) => r.active !== false).length === 1 ? '' : 's'}`}
      >
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
          message, report success, and then quietly drop it if the from-address is not one of their verified senders, 
          so receipts show as <em>sent</em> here and never arrive. If that is happening, this is almost always why.
          Check Brevo → Senders, Domains &amp; Dedicated IPs → Senders, and put exactly that address here.
        </Notice>

        <h3 style={{ marginTop: '1.6rem' }}>Who gets them</h3>
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
            hint: 'Once a day after close. A day with two shifts produces two shift reports and no figure for the day; this is that figure.',
          },
          {
            key: 'backup',
            label: 'Nightly backup',
            hint: 'Every record as spreadsheets, attached. This hosting plan keeps no backups of its own, so this is your only copy, keep one somewhere other than your inbox.',
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

        {/* Which reports currently have nobody to go to.
            Ticking a box and typing an address are two separate acts, and it
            is entirely possible to do one and not the other, after which the
            report is generated nightly and thrown away in silence. */}
        {(() => {
          const live = subs.filter((r) => r.active !== false);
          const orphans = [
            { key: 'shift_close', label: 'End-of-shift report' },
            { key: 'daily_digest', label: 'Daily summary' },
            { key: 'backup', label: 'Nightly backup' },
          ].filter((k) => !live.some((r) => (r.events ?? []).includes(k.key)));
          if (orphans.length === 0) return null;
          return (
            <Notice tone="warn">
              <strong>Nobody is receiving {orphans.map((o) => o.label.toLowerCase()).join(', ')}.</strong>{' '}
              These are still being produced; they simply have nowhere to go. Add an address above, tick the
              box, and press Save recipients.
            </Notice>
          );
        })()}

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

        <h3 style={{ margin: '1.4rem 0 0.4rem' }}>What actually happened</h3>
        <p className="small dim" style={{ marginTop: 0 }}>
          The last few reports the server produced, and what happened when it tried to send them.
        </p>
        {/*
          The limit of what this panel can know, said before somebody reads
          more into it than it says. Three different failures used to look
          identical from here, and only two of them are ours.
        */}
        <p className="small dim">
          <strong>Handed to the mail server</strong> means the provider took the message — not that it reached an
          inbox. If it says that and nothing arrived, the message left this system correctly and went astray
          afterwards: check the spam folder first, then look the reference below up in your mail provider&rsquo;s own
          records, which will say whether it was delivered, bounced or blocked.
        </p>
        {deliveries === null ? (
          <p className="small dim">Loading…</p>
        ) : deliveries.length === 0 ? (
          /*
            An empty list is a finding, not a blank.

            Nothing here means the server never got as far as recording an
            attempt — and that has one cause, not several: the background job
            was not called. A report that WAS attempted and failed leaves a row
            saying why, so silence and failure look different and lead
            different places. Saying only "nothing yet" sent people to look at
            their mail provider, which is the one thing that cannot be at
            fault when nothing was ever sent.
          */
          <>
            <p className="small dim">
              <strong>Nothing has been produced at all.</strong> A report that was attempted and failed leaves a
              row here saying why, so an empty list means the background job was never called rather than that
              mail is going astray.
            </p>
            <p className="small dim" style={{ marginBottom: 0 }}>
              If shifts have been closed since this was set up, run <strong>Deploy functions</strong> — that is
              what subscribes the job to the events it answers, and until it has run, closing a shift tells
              nothing on the server that anything happened. The end-of-shift report appears when a shift is
              closed; the daily ones after the hour set above.
            </p>
          </>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>When</th><th>Report</th><th>Result</th></tr>
              </thead>
              <tbody>
                {deliveries.map((d) => (
                  <tr key={d.$id}>
                    <td className="small dim">{new Date(d.$createdAt).toLocaleString()}</td>
                    <td className="small">{REPORT_NAMES[d.kind] ?? d.kind}</td>
                    {/*
                      "Handed over", not "arrived".

                      This column said Sent, and people read that as "it is in
                      their inbox". It never meant that and cannot: all this
                      end knows is that the mail server took the message. A
                      provider can accept a message and drop it — an unverified
                      sender, a bounce, a spam filter — and every one of those
                      shows here as a success, correctly, because the send did
                      succeed. So it now says what actually happened, and
                      carries the server's own reference for the message, which
                      is what the provider's records are searched by when the
                      answer to "was it delivered" has to come from them.
                    */}
                    <td className="small">
                      {d.delivery_status === 'failed' ? (
                        <>
                          <Badge tone="danger">Not sent</Badge>{' '}
                          <span className="dim">{d.last_error || 'No reason recorded.'}</span>
                        </>
                      ) : (
                        <>
                          <Badge tone={d.delivery_status === 'partial' ? 'warn' : 'ok'}>
                            {d.delivery_status === 'partial' ? 'Partly accepted' : 'Handed to the mail server'}
                          </Badge>{' '}
                          <span className="dim">{d.delivered_to || ''}</span>
                          {d.last_error && <div className="dim">{d.last_error}</div>}
                          {(d.provider_reply || d.provider_ref) && (
                            <div className="dim" style={{ wordBreak: 'break-all' }}>
                              {d.provider_reply || d.provider_ref}
                            </div>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </FoldCard>

      <FoldCard title="Colours and logo" summary="How the customer menu and receipts look">
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
            to read; the app will use dark text instead, but a deeper colour would look better.
          </Notice>
        )}
      </FoldCard>

      <FoldCard title="Who can see what" summary="Which admin pages each role may open">
        <p className="small dim" style={{ marginTop: 0 }}>
          Which parts of this admin app each role can open. Admins always see everything; there is no switch for that
          on purpose, and it is what makes the rest of this safe to hand out — no combination of these can lock you
          out of your own business.
        </p>
        <p className="small dim">
          Accounting is granted a part at a time. Somebody needs the Accounting row to get in at all, and then only
          the parts ticked beneath it — a bookkeeper can be given the journal and the bank without being given the
          chart of accounts, and a manager can be given the profit and loss without being given any of it.
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
                  {/* A part of a page is indented under it, so a row reads as
                      "inside accounting" rather than as another page in the
                      Money group with a confusingly similar name. */}
                  <td style={section.parent ? { paddingLeft: '2rem' } : undefined}>
                    {section.label}
                    <div className="small dim">
                      {section.parent
                        ? `part of ${ADMIN_SECTIONS.find((x) => x.key === section.parent)?.label ?? section.parent}`
                        : section.group}
                    </div>
                  </td>
                  {GRANTABLE_ROLES.map((role) => (
                    <td key={role} style={{ textAlign: 'center' }}>
                      {/* Every row is a real choice now. These used to show a
                          dash and could not be granted at all, which meant a
                          bookkeeper could not be given the books and a manager
                          could not be trusted with the settings of a business
                          they run. An admin keeps all of it regardless, so
                          nothing here can lock the owner out. */}
                      <input
                        type="checkbox"
                        checked={(access[role] ?? []).includes(section.key)}
                        onChange={() => toggleAccess(role, section.key)}
                        aria-label={`${role} can open ${section.label}`}
                      />
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
      </FoldCard>

    </>
  );
}
