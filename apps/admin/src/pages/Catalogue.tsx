import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Segmented } from '@snpos/ui';
import { catalogueSides, SIDE_NAMES } from '@snpos/core';
import type { Module } from '@snpos/core';
import { useSession } from '../session';
import { CategoriesPage } from './Categories';
import { MenuItemsPage } from './MenuItems';
import { StockPage } from './Stock';

const TO: Record<'categories' | 'items' | 'stock', string> = {
  categories: '/catalogue/categories',
  items: '/catalogue/items',
  stock: '/stock',
};

/**
 * One page per kind of thing, with a side switch.
 *
 * The bistro, the bar and the shop each had their own Categories link,
 * their own catalogue link and their own stock link, each a page of its
 * own under its own heading. Staff learned which heading held their copy
 * and never opened the others; an owner running all three had three of
 * everything. The three are the same screen with a different side, so they
 * are one link now, and the side is a switch at the top.
 *
 * Nothing about permission changed. Each side is still its own grant, and
 * the switch offers only the sides this person holds; with one side held
 * there is no switch, just that side.
 */
export function CataloguePage({ kind }: { kind: 'categories' | 'items' | 'stock' }) {
  const { profile, settings } = useSession();
  const [params, setParams] = useSearchParams();
  const sides = catalogueSides(TO[kind], profile, settings);
  const asked = params.get('side') as Module | null;
  const side: Module | undefined = asked && sides.includes(asked) ? asked : sides[0];

  // The address says which side, so a link and a reload land on the same one.
  useEffect(() => {
    if (side && asked !== side) setParams({ side }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side, asked]);

  if (!side) return null;

  return (
    <>
      {sides.length > 1 && (
        <div style={{ marginBottom: '1rem' }}>
          <Segmented<Module>
            value={side}
            onChange={(m) => setParams({ side: m })}
            ariaLabel="Which side of the business"
            options={sides.map((m) => ({ value: m, label: SIDE_NAMES[m] }))}
          />
        </div>
      )}
      {/* Keyed by side, so switching starts the page afresh rather than
          leaving one side's half-typed form over the other's list. */}
      {kind === 'categories' && <CategoriesPage key={side} module={side} />}
      {kind === 'items' && <MenuItemsPage key={side} module={side} />}
      {kind === 'stock' && <StockPage key={side} module={side} />}
    </>
  );
}
