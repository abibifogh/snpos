import { useEffect, useState } from 'react';
import { Button, Field, Input, Modal, Notice, Segmented, Select, Spinner } from '@snpos/ui';
import { humanError } from '../lib';
import {
  listAll, Query, barChargePrices, chargeBarLine, chargeShopLine, chargeProblem, chargeWords, chargeAmount,
  parseMoney, toInput,
} from '@snpos/core';
import type { ReviewLine, WaitingRef, StaffProfile, PriceBasis } from '@snpos/core';

/**
 * Charge one short line of a count to a person.
 *
 * Anybody on the staff list can be charged — whoever counted is only the
 * first suggestion. Priced at what the missing stock sells for, because that
 * is what the business would have taken for it; cost, or a figure typed by
 * hand, when that is what was agreed. See staff-charges.ts.
 */
export function ChargeLineModal({ refOf, line, countedBy, userId, money, onClose, onDone }: {
  refOf: WaitingRef;
  line: ReviewLine;
  /** Who filed the count, so they are offered first. */
  countedBy?: string;
  userId: string;
  money: (n: number) => string;
  onClose: () => void;
  onDone: (words: string) => Promise<void>;
}) {
  const short = -(line.delta ?? 0);
  const [people, setPeople] = useState<StaffProfile[] | null>(null);
  const [personId, setPersonId] = useState('');
  const [qtyText, setQtyText] = useState(String(short));
  const [prices, setPrices] = useState<{ selling: number | null; sellingFrom: string; cost: number } | null>(null);
  const [basis, setBasis] = useState<PriceBasis>('selling');
  const [priceText, setPriceText] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const [staff, priced] = await Promise.all([
        listAll<StaffProfile>('staff_profiles', [Query.equal('active', true)]).catch(() => [] as StaffProfile[]),
        refOf.kind === 'bar_count' && line.ingredientId
          ? barChargePrices(line.ingredientId).catch(() => ({ selling: null, sellingFrom: '', cost: 0 }))
          : Promise.resolve({ selling: line.unitPrice ?? null, sellingFrom: '', cost: 0 }),
      ]);
      const sorted = [...staff].sort((a, b) => a.display_name.localeCompare(b.display_name));
      setPeople(sorted);
      setPersonId(sorted.find((p) => p.user_id === countedBy || p.$id === countedBy)?.$id ?? '');
      setPrices(priced);
      // Selling price first. Where nothing sells it, cost; where there is no
      // cost either, a price typed by hand.
      const start: PriceBasis = priced.selling ? 'selling' : priced.cost > 0 ? 'cost' : 'custom';
      setBasis(start);
      setPriceText(toInput(start === 'selling' ? priced.selling ?? 0 : start === 'cost' ? priced.cost : 0));
    })();
  }, [refOf, line, countedBy]);

  const pick = (b: PriceBasis) => {
    setBasis(b);
    setError(null);
    if (b === 'selling') setPriceText(toInput(prices?.selling ?? 0));
    if (b === 'cost') setPriceText(toInput(prices?.cost ?? 0));
  };

  const qty = Number(qtyText);
  const unitPrice = parseMoney(priceText) ?? 0;
  const person = people?.find((p) => p.$id === personId);
  const problem = chargeProblem({ personId, qty, short, unitPrice });

  const save = async () => {
    if (problem || !person) { setError(problem ?? 'Choose who this is charged to.'); return; }
    setBusy(true);
    setError(null);
    try {
      const who = { $id: person.$id, user_id: person.user_id, display_name: person.display_name };
      if (refOf.kind === 'bar_count') {
        await chargeBarLine({
          venueId: 'main', shiftId: refOf.shiftId, phase: refOf.phase, lineId: line.id ?? '',
          person: who, qty, unitPrice, basis, note, userId, itemName: line.name,
        });
      } else if (refOf.kind === 'shop_count' || refOf.kind === 'shelf') {
        await chargeShopLine({
          venueId: 'main', countId: refOf.countId, lineId: line.id ?? '',
          person: who, qty, unitPrice, basis, note, userId,
        });
      }
      await onDone(`${money(chargeAmount(qty, unitPrice))} charged to ${person.display_name}. The shelf is corrected.`);
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  const basisOptions: { value: PriceBasis; label: string }[] = [
    ...(prices?.selling ? [{ value: 'selling' as const, label: `Selling ${money(prices.selling)}` }] : []),
    ...(prices && prices.cost > 0 ? [{ value: 'cost' as const, label: `Cost ${money(prices.cost)}` }] : []),
    { value: 'custom', label: 'Another price' },
  ];

  return (
    <Modal
      title={`Charge ${line.name} to a person`}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!!problem || !people} onClick={() => void save()}>
            {person && !problem ? `Charge ${money(chargeAmount(qty, unitPrice))} to ${person.display_name}` : 'Charge'}
          </Button>
        </>
      )}
    >
      {!people || !prices ? <Spinner /> : (
        <div style={{ display: 'grid', gap: '0.7rem' }}>
          <p style={{ margin: 0 }}>{short} short: the shelf said {line.expected}, {line.counted} were found.</p>
          <Field label="Who">
            <Select value={personId} onChange={(e) => { setPersonId(e.target.value); setError(null); }}>
              <option value="">Choose…</option>
              {people.map((p) => (
                <option key={p.$id} value={p.$id}>
                  {p.display_name}{(p.user_id === countedBy || p.$id === countedBy) ? ' (counted this)' : ''}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="How many" hint={`Up to ${short}. Any not charged are applied as an ordinary loss.`}>
            <Input value={qtyText} inputMode="decimal" onChange={(e) => { setQtyText(e.target.value); setError(null); }} />
          </Field>
          <Field
            label="Price each"
            hint={basis === 'selling' && prices.sellingFrom ? `What ${prices.sellingFrom} sells for.`
              : !prices.selling ? 'Nothing on the menu sells this, so there is no selling price to use.' : undefined}
          >
            <Segmented<PriceBasis> value={basis} onChange={pick} ariaLabel="Price each" options={basisOptions} />
            <Input
              value={priceText}
              inputMode="decimal"
              style={{ marginTop: '0.4rem' }}
              onChange={(e) => { setPriceText(e.target.value); setBasis('custom'); setError(null); }}
            />
          </Field>
          <Field label="Note (optional)">
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. agreed at handover" />
          </Field>
          {!problem && person && (
            <Notice tone="info">
              {chargeWords({
                name: line.name, person: person.display_name, qty, short,
                expected: line.expected ?? 0, counted: line.counted ?? 0, unitPrice, money,
              }).map((w) => <div key={w}>{w}</div>)}
            </Notice>
          )}
          {error && <Notice>{error}</Notice>}
        </div>
      )}
    </Modal>
  );
}
