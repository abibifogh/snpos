import { Badge, Button, Field, Input, Select, Textarea, Toggle } from '@snpos/ui';
import { parseMoney, toInput } from '@snpos/core';
import type { Consignor, MenuItem, ProductVariant } from '@snpos/core';

/** A size row being edited, before it is written. */
export interface DraftVariant {
  $id?: string;
  label: string;
  kind: ProductVariant['kind'];
  priceText: string;
  sku: string;
  barcode: string;
  onHandText: string;
  active: boolean;
}

export const draftVariantsFrom = (rows: ProductVariant[], decimals: number): DraftVariant[] =>
  rows.map((v) => ({
    $id: v.$id,
    label: v.label,
    kind: v.kind,
    priceText: toInput(v.price, decimals),
    sku: v.sku ?? '',
    barcode: v.barcode ?? '',
    onHandText: String(v.on_hand ?? 0),
    active: v.active,
  }));

export const blankVariant = (): DraftVariant => ({
  label: '', kind: 'size', priceText: '', sku: '', barcode: '', onHandText: '1', active: true,
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
  onHandText, setOnHandText,
}: {
  editing: Partial<MenuItem>;
  setEditing: (v: Partial<MenuItem>) => void;
  /** Held as text so backspacing the last digit does not refill itself. */
  onHandText: string;
  setOnHandText: (v: string) => void;
  consignors: Consignor[];
  variants: DraftVariant[];
  setVariants: (f: (v: DraftVariant[]) => DraftVariant[]) => void;
  removedVariantIds: string[];
  setRemovedVariantIds: (f: (v: string[]) => string[]) => void;
  symbol: string;
  decimals: number;
}) {
  const chosen = consignors.find((c) => c.$id === editing.consignor_id) ?? null;

  const setVariant = (index: number, patch: Partial<DraftVariant>) =>
    setVariants((rows) => rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));

  const removeVariant = (index: number) =>
    setVariants((rows) => {
      const row = rows[index];
      // Saved rows have to be deleted on save, not merely forgotten about —
      // otherwise a size somebody removed carries on being sellable.
      if (row.$id) setRemovedVariantIds((ids) => [...ids, row.$id as string]);
      return rows.filter((_, i) => i !== index);
    });

  return (
    <>
      <div className="grid-2">
        <Field
          label="Whose work is this?"
          hint="Leave blank for anything the shop owns outright — nothing is credited to anybody for those."
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
        <Field
          label="Commission on this piece (%)"
          hint={chosen ? `Blank uses ${chosen.name}'s usual ${(chosen.commission_bp / 100).toFixed(0)}%.` : 'Blank uses their usual rate.'}
        >
          <Input
            inputMode="decimal"
            placeholder={chosen ? String(chosen.commission_bp / 100) : ''}
            value={editing.commission_bp === undefined || editing.commission_bp === null ? '' : String(editing.commission_bp / 100)}
            onChange={(e) => {
              const raw = e.target.value.trim();
              if (raw === '') { setEditing({ ...editing, commission_bp: undefined }); return; }
              const pct = Number(raw);
              if (Number.isFinite(pct)) setEditing({ ...editing, commission_bp: Math.round(pct * 100) });
            }}
          />
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
          label="A one-off piece — there is only ever one of these"
        />
      </Field>

      <Field label="The card beside it" hint="A line about the maker or the making. Shown to customers.">
        <Textarea
          rows={2}
          value={editing.maker_note ?? ''}
          onChange={(e) => setEditing({ ...editing, maker_note: e.target.value })}
        />
      </Field>

      {/* -------------------------------------------------------- sizes ---- */}
      <Field
        label="Sizes"
        hint="A basket in small, medium and large is one product and three prices. Add a row for each; leave it empty if the piece has only one price."
      >
        <div>
          {variants.length === 0 && (
            <p className="small dim" style={{ margin: '0 0 0.5rem' }}>
              No sizes — this sells at the single price above.
            </p>
          )}

          {variants.map((v, i) => (
            <div key={v.$id ?? `new-${i}`} className="variant-row">
              <Input
                placeholder="Large"
                value={v.label}
                onChange={(e) => setVariant(i, { label: e.target.value })}
              />
              <Select
                value={v.kind}
                onChange={(e) => setVariant(i, { kind: e.target.value as ProductVariant['kind'] })}
              >
                <option value="size">Size</option>
                <option value="colour">Colour</option>
                <option value="finish">Finish</option>
                <option value="other">Other</option>
              </Select>
              <Input
                placeholder={symbol}
                inputMode="decimal"
                value={v.priceText}
                onChange={(e) => setVariant(i, { priceText: e.target.value })}
              />
              <Input
                type="number"
                min="0"
                placeholder="Qty"
                value={v.onHandText}
                onChange={(e) => setVariant(i, { onHandText: e.target.value })}
              />
              <Input
                placeholder="Barcode"
                value={v.barcode}
                onChange={(e) => setVariant(i, { barcode: e.target.value })}
              />
              {/* Retired rather than deleted where it has already sold things,
                  but the distinction belongs to the row, not to this button —
                  see the save path in MenuItems. */}
              <Button onClick={() => removeVariant(i)} aria-label={`Remove ${v.label || 'this size'}`}>×</Button>
              {parseMoney(v.priceText, decimals) === null && v.priceText.trim() !== '' && (
                <Badge tone="warn">Price?</Badge>
              )}
            </div>
          ))}

          <Button onClick={() => setVariants((rows) => [...rows, blankVariant()])}>Add a size</Button>
          {removedVariantIds.length > 0 && (
            <p className="small dim" style={{ marginBottom: 0 }}>
              {removedVariantIds.length} removed — saved when you press Save.
            </p>
          )}
        </div>
      </Field>
    </>
  );
}
