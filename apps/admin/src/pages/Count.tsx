import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Segmented } from '@snpos/ui';
import { catalogueSides, SIDE_NAMES } from '@snpos/core';
import type { Module } from '@snpos/core';
import { useSession } from '../session';
import { BarCountsPage } from './BarCounts';
import { StocktakePage } from './Stocktake';

/**
 * Count: one page for every place, with a side switch.
 *
 * Bar counts, the shop's Count the shelf and the kitchen's count were three
 * pages with three names for one job. The bar and the kitchen count on the
 * same sheet, against whichever place is picked; the shop counts its pieces
 * on the shelf. Every difference waits on Waiting for you.
 *
 * The old addresses (/bar/counts, /stocktake) open this page on their side.
 */
export function CountPage() {
  const { profile, settings } = useSession();
  const [params, setParams] = useSearchParams();
  const sides = catalogueSides('/count', profile, settings);
  const asked = params.get('side') as Module | null;
  const side: Module | undefined = asked && sides.includes(asked) ? asked : sides[0];

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
      {side === 'craft'
        ? <StocktakePage key={side} />
        : <BarCountsPage key={side} module={side} />}
    </>
  );
}
