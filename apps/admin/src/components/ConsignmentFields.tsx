import { useState } from 'react';
import { Badge, Button, Field, Input, Select, Textarea, Toggle } from '@snpos/ui';
import { parseMoney, toInput } from '@snpos/core';
import type { Consignor, MenuItem, ProductVariant, VariantType, Module } from '@snpos/core';

/** A size row being edited, before it is written. */
export interface DraftVariant {
  $id?: string;
  label: string;
  kindKey: string;
  priceText: string;
  sku: string;
  barcode: string;
  onHandText: string;
  active: boolean;
  /**
   * Whether this size is its own thing on the shelf.
   *
   * A small Club and a large Club are two objects, counted separately at the
   * bar and in the store. A double gin is not: it pours twice from the same
   * bottle, and giving it a shelf of its own would put a second, wrong number
   * beside the one that is true.
   */
  ownStock: boolean;
}

export const draftVariantsFrom = (rows: ProductVariant[], decimals: number): DraftVariant[] =>
  rows.map((v) => ({
    $id: v.$id,
    label: v.label,
    kindKey: v.kind_key || v.kind || 'size',
    priceText: toInput(v.price, decimals),
    sku: v.sku ?? '',
    barcode: v.barcode ?? '',
    onHandText: String(v.on_hand ?? 0),
    active: v.active,
    // Filled in by the form once the recipes are known: a size already bound
    // to its own ingredient is one that has it.
    ownStock: false,
  }));

export const blankVariant = (kindKey = 'size', ownStock = false): DraftVariant => ({
  label: '', kindKey, priceText: '', sku: '', barcode: '', onHandText: '1', active: true, ownStock,
});

/**
 * The part of a product that only a consignment shop has: whose it is, what was
 * agreed, and what sizes it comes in.
 *
 * Split out of the product editor rather than bolted onto it, so the kitchen
 * form stays the form it was. A cook adding jollof should not scroll past a
 * commission rate to reach the price.
 */
export function ConsignmentFields({
  editing, setEditing, consignors, variants, setVariants,
  removedVariantIds, setRemovedVariantIds, symbol, decimals,
  onHandText, setOnHandText, variantTypes, module,
}: {
  /**
   * Which side is being edited.
   *
   * Sizes belong to the shop AND the bar — a spirit as a single and a double
   * is the same shape as a basket in three sizes. Everything else here is the
   * shop's alone: whose work it is, what commission it carries, whether there
   * is only ever one of them, the card that sits beside it. A bar has no
   * makers and no one-off bottles, and asking a bartender about either is
   * asking a question with no answer.
   */
  module: Module;
  editing: Partial<MenuItem>;
  setEditing: (v: Partial<MenuItem>) => void;
  /** Held as text so backspacing the last digit does not refill itself. */
  onHandText: string;
  setOnHandText: (v: string) => void;
  /** The kinds of variation this shop sells by, as the shop defined them. */
  variantTypes: VariantType[];
  consignors: Consignor[];
  variants: DraftVariant[];
  setVariants: (f: (v: DraftVariant[]) => DraftVariant[]) => void;
  removedVariantIds: string[];
  setRemovedVariantIds: (f: (v: string[]) => string[]) => void;
  symbol: string;
  decimals: number;
}) {
  const chosen = consignors.find((c) => c.$id === editing.consignor_id) ?? null;

  /**
   * Which kind of override this piece carries, worked out from what is on it.
   *
   * From the data rather than from a stored flag: a flat amount above zero IS a
   * flat agreement, so there is nothing to keep in step and nothing that can
   * disagree with the figure beside it.
   */
  const [pieceMode, setPieceMode] = useState<'percent' | 'amount'>(
    (editing.commission_flat ?? 0) > 0 ? 'amount' : 'percent',
  );

  const usualTerms = chosen
    ? (chosen.commission_flat ?? 0) > 0
      ? `${symbol}${((chosen.commission_flat as number) / 10 ** decimals).toFixed(decimals)} a piece`
      : `${(chosen.commission_bp / 100).toFixed(0)}%`
    : '';

  const setVariant = (index: number, patch: Partial<DraftVariant>) =>
    setVariants((rows) => rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  const removeVariant = (index: number) =>
    setVariants((rows) => {
      const row = rows[index];
      // Saved rows have to be deleted on save, not merely forgotten about, 
      // otherwise a size somebody removed carries on being sellable.
      if (row.$id) setRemovedVariantIds((ids) => [...ids, row.$id as string]);
      return rows.filter((_, i) => i !== index);
    });

  const consigned = module === 'craft';

  return (
    <>
      {consigned && (
      <>
      <div className="grid-2">
        <Field
          label="Whose work is this?"
          hint="Leave blank for anything the shop owns outright; nothing is credited to anybody for those."
        >
          <Select
            value={editing.consignor_id ?? ''}
            onChange={(e) => setEditing({ ...editing, consignor_id: e.target.value })}
          >
            <option value="">The shop's own stock</option>
            {consignors.filter((c) => c.active).map((c) => (
              <option key={c.$id} value={c.$id}>{c.code} · {c.name}</option>
            ))}
          </Select>
        </Field>
        {/* A share or a flat amount, the same choice the consignor's own terms
            offer, because a piece negotiated differently is usually negotiated
            differently in kind as well as in size: "keep two cedis on this
            one" is a sentence people say. Blank in either box means the
            maker's usual terms apply. */}
        <Field
          label="Commission on this piece"
          hint={
            chosen
              ? `Blank uses ${chosen.name}'s usual ${usualTerms}.`
              : 'Blank uses their usual terms.'
          }
        >
          <div className="row" style={{ gap: '0.4rem', alignItems: 'center' }}>
            <Select
              value={pieceMode}
              style={{ flex: 1 }}
              onChange={(e) => {
                const mode = e.target.value as 'percent' | 'amount';
                // Clearing both is what makes the switch safe: 2 means two
                // percent in one mode and two cedis in the other, and a figure
                // that quietly changes meaning underpays somebody.
                setEditing({ ...editing, commission_bp: undefined, commission_flat: mode === 'amount' ? 0 : undefined });
                setPieceMode(mode);
              }}
            >
              <option value="percent">Share (%)</option>
              <option value="amount">Per piece ({symbol})</option>
            </Select>
            {pieceMode === 'percent' ? (
              <Input
                inputMode="decimal"
                style={{ width: '6.5rem' }}
                placeholder={chosen ? String(chosen.commission_bp / 100) : ''}
                value={editing.commission_bp === undefined || editing.commission_bp === null ? '' : String(editing.commission_bp / 100)}
                onChange={(e) => {
                  const raw = e.target.value.trim();
                  if (raw === '') { setEditing({ ...editing, commission_bp: undefined }); return; }
                  const pct = Number(raw);
                  if (Number.isFinite(pct)) setEditing({ ...editing, commission_bp: Math.round(pct * 100) });
                }}
              />
            ) : (
              <Input
                inputMode="decimal"
                style={{ width: '6.5rem' }}
                value={editing.commission_flat ? toInput(editing.commission_flat, decimals) : ''}
                onChange={(e) => {
                  const raw = e.target.value.trim();
                  setEditing({ ...editing, commission_flat: raw === '' ? 0 : parseMoney(raw, decimals) ?? 0 });
                }}
              />
            )}
          </div>
        </Field>
      </div>

      <div className="grid-2">
        <Field label="Barcode" hint="Scanned at the till. Leave blank if you label by hand.">
          <Input value={editing.barcode ?? ''} onChange={(e) => setEditing({ ...editing, barcode: e.target.value })} />
        </Field>
        <Field label="How many on the shelf" hint="Only used when this piece has no sizes below.">
          <Input
            type="number"
            min="0"
            value={onHandText}
            onChange={(e) => setOnHandText(e.target.value)}
            disabled={variants.length > 0}
          />
        </Field>
      </div>

      <Field>
        <Toggle
          checked={editing.is_one_off ?? false}
          onChange={(v) => { setEditing({ ...editing, is_one_off: v }); if (v) setOnHandText('1'); }}
          label="A one-off piece; there is only ever one of these"
        />
      </Field>

      <Field label="The card beside it" hint="A line about the maker or the making. Shown to customers.">
        <Textarea
          rows={2}
          value={editing.maker_note ?? ''}
          onChange={(e) => setEditing({ ...editing, maker_note: e.target.value })}
        />
      </Field>
      </>
      )}

      {/* -------------------------------------------------------- sizes ---- */}
      <Field
        label="Variants"
        hint={consigned
          ? `A basket in small, medium and large is one product and three prices. Add a row for each; leave it empty if the piece has only one price. The kinds offered here (${variantTypes.map((t) => t.name.toLowerCase()).join(', ')}) are yours to change under Craft shop, Products, Variant types.`
          : `A spirit as a single and a double is one drink and two prices. Add a row for each; leave it empty if the drink has only one price. The kinds offered here (${variantTypes.map((t) => t.name.toLowerCase()).join(', ')}) are yours to change on the Variant types tab.`}
      >
        <div>
          {variants.length === 0 && (
            <p className="small dim" style={{ margin: '0 0 0.5rem' }}>
              No variants; this sells at the single price above.
            </p>
          )}

          {/*
            Nothing to pick in the Kind box yet.

            Said here rather than left as an empty dropdown, which reads as a
            fault in the form. The variant still saves — it falls back to a
            plain size — so this is a nudge, not a wall.
          */}
          {variantTypes.length === 0 && (
            <p className="small" style={{ margin: '0 0 0.5rem', color: 'var(--warn)' }}>
              No variant types set up yet, so the Kind box will be empty. Add them on the Variant types tab
              {consigned ? '' : ' — “Single and double”, “Glass and carafe”, “Bottle and crate”'}.
            </p>
          )}

          {/*
            Every box says what it is, on every row.

            These were five bare inputs in a line, told apart only by
            placeholder text — which disappears the moment anything is typed,
            so a half-filled row became five boxes with no way to tell which
            was the price and which the barcode. A header row above them would
            align on a wide screen and come apart the moment it wrapped, which
            on a phone is immediately.
          */}
          {variants.map((v, i) => (
            <div key={v.$id ?? `new-${i}`} className="variant-row">
              <label className="variant-cell wide">
                <span>What it is called</span>
                <Input
                  placeholder={consigned ? 'Large' : 'Double'}
                  value={v.label}
                  onChange={(e) => setVariant(i, { label: e.target.value })}
                />
              </label>
              <label className="variant-cell">
                <span>Kind</span>
                <Select
                  value={v.kindKey}
                  onChange={(e) => setVariant(i, { kindKey: e.target.value })}
                >
                  {variantTypes.map((t) => (
                    <option key={t.key} value={t.key}>{t.singular || t.name}</option>
                  ))}
                </Select>
              </label>
              <label className="variant-cell">
                <span>Price ({symbol.trim()})</span>
                <Input
                  placeholder={symbol}
                  inputMode="decimal"
                  value={v.priceText}
                  onChange={(e) => setVariant(i, { priceText: e.target.value })}
                />
              </label>
              {/*
                Only the shop counts pieces. A bar's stock leaves through the
                recipe — the measure comes out of the bottle — so a count here
                would be a number nothing reads and nothing keeps true.
              */}
              {consigned && (
                <label className="variant-cell">
                  <span>On the shelf</span>
                  <Input
                    type="number"
                    min="0"
                    placeholder="0"
                    value={v.onHandText}
                    onChange={(e) => setVariant(i, { onHandText: e.target.value })}
                  />
                </label>
              )}
              <label className="variant-cell wide">
                <span>Barcode <span className="dim">(optional)</span></span>
                <Input
                  placeholder="Scanned at the till"
                  value={v.barcode}
                  onChange={(e) => setVariant(i, { barcode: e.target.value })}
                />
              </label>
              {/*
                Its own shelf, or the drink's.

                On for a bottled drink, where a small and a large are two
                objects bought and counted separately. Off for a cocktail's
                sizes: a double gin pours twice from the same bottle, and a
                "Gin · Double" stock item would be a second number beside the
                one that is actually true.
              */}
              {!consigned && (
                <label className="variant-cell">
                  <span>Counted separately</span>
                  <Toggle
                    checked={v.ownStock}
                    onChange={(on) => setVariant(i, { ownStock: on })}
                    label={v.ownStock ? 'Own stock' : "Drink's stock"}
                  />
                </label>
              )}
              <div className="variant-cell shrink">
                <span aria-hidden="true">&nbsp;</span>
                {/* Retired rather than deleted where it has already sold
                    things, but the distinction belongs to the row, not to
                    this button, see the save path in MenuItems. */}
                <Button onClick={() => removeVariant(i)} aria-label={`Remove ${v.label || 'this variant'}`}>×</Button>
              </div>
              {parseMoney(v.priceText, decimals) === null && v.priceText.trim() !== '' && (
                <Badge tone="warn">That price is not a number</Badge>
              )}
            </div>
          ))}

          {/* A new bar size is its own stock by default: that is what a
              bottled drink is, and it is the case this was asked for. A
              cocktail's sizes get the toggle turned off. */}
          <Button onClick={() => setVariants((rows) => [
            ...rows, blankVariant(variantTypes[0]?.key ?? 'size', !consigned),
          ])}>
            Add a variant
          </Button>
          {removedVariantIds.length > 0 && (
            <p className="small dim" style={{ marginBottom: 0 }}>
              {removedVariantIds.length} removed, saved when you press Save.
            </p>
          )}
        </div>
      </Field>
    </>
  );
}
