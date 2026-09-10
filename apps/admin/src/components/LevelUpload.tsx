import { Notice } from '@snpos/ui';
import { readLevelImport, applyLevelImport, levelTotals, LEVEL_TEMPLATE_ROWS } from '@snpos/core';
import type { StockLocation, LevelImportResult } from '@snpos/core';
import { ImportDialog } from './ImportDialog';

/**
 * Opening levels for every place, from one file.
 *
 * A bar moving in has stock in a store room and stock behind the bar, and
 * counting forty items twice on day one is the kind of task that gets done
 * badly or not at all. Every system that holds stock per location can export
 * this shape: one row per thing, one column per place.
 *
 * The place columns are matched by NAME against the places already set up
 * rather than being fixed in the code, so a business with a cellar as well
 * gets a third column by naming it, not by anybody editing anything.
 */
export function LevelUpload({
  ingredients, locations, userId, onClose, onDone,
}: {
  ingredients: { $id: string; name: string; unit: string }[];
  locations: StockLocation[];
  userId: string;
  onClose: () => void;
  onDone: (message: string) => Promise<void>;
}) {
  return (
    <ImportDialog<LevelImportResult>
      title="Upload opening levels"
      intro={<>
        <p style={{ marginTop: 0 }}>
          One row per thing, one column per place, headed with the place&rsquo;s name. A blank cell leaves that
          place alone; a nought empties it.
        </p>
        {/* The one thing that could go badly wrong, said before the button. */}
        <Notice tone="info">
          This <strong>sets</strong> each level rather than adding to it, so running the same file twice leaves
          the same answer. It is an opening balance, not a delivery.
        </Notice>
        {locations.length === 0 && <Notice>Set a place up first — there is nowhere for these levels to go.</Notice>}
      </>}
      // Headed with the places that actually exist, so the file somebody
      // downloads already matches their own rooms.
      template={{ name: 'opening-levels-template', headings: ['name', 'unit', ...locations.map((l) => l.name)], rows: LEVEL_TEMPLATE_ROWS }}
      read={(grid) => readLevelImport(grid, { ingredients, locations })}
      problems={(r) => r.problems}
      problemsStop={false}
      count={(r) => r.rows.length}
      action={(n) => (n ? `Set ${n} item${n === 1 ? '' : 's'}` : 'Set levels')}
      body={(r) => {
        const totals = levelTotals(r.rows);
        return (
          <>
            {r.matchedPlaces.length > 0 && (
              <Notice tone="ok">
                <strong>{r.rows.length} item{r.rows.length === 1 ? '' : 's'} read</strong>, filling {r.matchedPlaces.join(' and ')}.
              </Notice>
            )}
            {r.ignoredColumns.length > 0 && (
              /* Named rather than silently skipped: a column somebody meant as a
                 place and misspelled looks identical to one they meant as a note. */
              <p className="small dim">
                Columns ignored, because they do not match a place you have set up: {r.ignoredColumns.join(', ')}.
              </p>
            )}
            {totals.length > 0 && (
              <div className="row row-wrap" style={{ gap: '1.4rem', margin: '0.8rem 0' }}>
                {totals.map((t) => (
                  <div key={t.place}>
                    <div className="dim small">{t.place}</div>
                    <div style={{ fontSize: '1.3rem', fontWeight: 650 }}>{t.items} items</div>
                    <div className="dim small">{Number(t.units.toFixed(2))} units in all</div>
                  </div>
                ))}
              </div>
            )}
            {r.rows.length > 0 && (
              <div className="table-wrap" style={{ maxHeight: '36vh', overflowY: 'auto' }}>
                <table className="data">
                  <thead>
                    <tr>
                      <th>What</th>
                      {r.matchedPlaces.map((p) => <th key={p} className="num">{p}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {r.rows.map((row) => (
                      <tr key={row.ingredientId}>
                        <td style={{ fontWeight: 550 }}>{row.name}</td>
                        {r.matchedPlaces.map((p) => {
                          const at = row.levels.find((l) => l.locationName === p);
                          return <td key={p} className="num">{at ? at.qty : <span className="dim" title="Left as it is">—</span>}</td>;
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        );
      }}
      write={async (r) => {
        const result = await applyLevelImport({ venueId: 'main', rows: r.rows, userId });
        await onDone(`${result.set} level${result.set === 1 ? '' : 's'} set`);
        return (
          <>
            <Notice tone={result.failed ? 'warn' : 'ok'}>
              <strong>{result.set} level{result.set === 1 ? '' : 's'} set.</strong>
              {result.failed > 0 && ` ${result.failed} could not be — those are unchanged.`}
            </Notice>
            <p className="small dim">
              Each place now holds what the file said, and the total on each item is the sum of its places. A
              movement was written for every difference, so the history explains the jump rather than just showing it.
            </p>
          </>
        );
      }}
      onClose={onClose}
    />
  );
}
