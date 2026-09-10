import { useState } from 'react';
import { Badge, Field, Select } from '@snpos/ui';
import { db, DB_ID, ID } from '../lib';
import { parseMoney, toInput, packProblem } from '@snpos/core';
import type { Ingredient, Settings, Module } from '@snpos/core';
import type { KeyedRow } from './KeyedList';
import { ImportDialog, type ImportColumn } from './ImportDialog';

/**
 * Bulk stock entry from a spreadsheet.
 *
 * Typing sixty ingredients one modal at a time is the reason stock never gets
 * set up. The template exists because "just upload a CSV" is only simple for
 * people who already know what columns it wants.
 *
 * A row that cannot be read is skipped and named, and the rest still goes in:
 * a stock export routinely carries a line or two the shelf does not hold, and
 * refusing the whole file over one of them is refusing the useful part.
 */

interface Supplier { $id: string; name: string }

/**
 * Bar units are here too, and they are not decoration.
 *
 * "0.7 l of gin" is a sentence nobody at a bar says while holding a bottle,
 * and a spreadsheet that refuses `bottle` sends somebody to convert forty
 * lines into litres by hand — which is where the mistakes come from.
 */
const UNITS = ['g', 'kg', 'ml', 'l', 'each', 'pack', 'bottle', 'case', 'shot', 'cl'];

const COLUMNS: ImportColumn[] = [
  { key: 'name', heading: 'name', required: true, help: 'What it is called. A name already on the list updates that line.' },
  { key: 'unit', heading: 'unit', required: true, help: `How it is counted: one of ${UNITS.join(', ')}.` },
  { key: 'cost_per_unit', heading: 'cost_per_unit', help: 'What one unit costs to buy.' },
  { key: 'in_stock', heading: 'in_stock', help: 'How many units are on the shelf now.' },
  { key: 'par_level', heading: 'par_level', help: 'How many you like to hold; the buying list works from this.' },
  { key: 'low_warning_at', heading: 'low_warning_at', help: 'Warn when it falls to this. Blank means the usual rule.' },
  { key: 'category', heading: 'category', help: 'A stock category by name, as set up on this page.' },
  { key: 'supplier', heading: 'supplier', help: 'A supplier by name, as set up under Suppliers.' },
  { key: 'expense_category', heading: 'expense_category', help: 'Which spend heading buying it goes under.' },
  { key: 'critical', heading: 'critical', help: 'yes if running out stops service.' },
  // How it arrives, when that is not how it is counted: a bar buys a bottle
  // and pours shots. Both optional — a kitchen buying rice by the kilo leaves
  // them off entirely and nothing changes. See packs.ts.
  { key: 'bought_as', heading: 'bought_as', help: 'What it arrives as, when that differs from how it is counted: bottle, case.' },
  { key: 'units_per_purchase', heading: 'units_per_purchase', help: 'How many counted units one of those holds.' },
];

interface ParsedRow {
  line: number;
  name: string;
  unit: string;
  cost: number;
  qty: number;
  par: number;
  low?: number;
  category: string;
  supplierId: string;
  expenseKey: string;
  critical: boolean;
  packName: string;
  packSize: number;
  existingId?: string;
  problems: string[];
}

interface Read { rows: ParsedRow[] }

export function StockImport({
  existing,
  suppliers,
  categories,
  expenseCategories,
  settings,
  venueId,
  module = 'kitchen',
  onClose,
  onDone,
}: {
  existing: Ingredient[];
  suppliers: Supplier[];
  categories: KeyedRow[] | null;
  expenseCategories: KeyedRow[] | null;
  settings: Settings | null;
  venueId: string;
  /** Whose shelves these are. Taken from the page rather than the file. */
  module?: Module;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [onConflict, setOnConflict] = useState<'update' | 'skip'>('update');
  const decimals = settings?.currency_decimals ?? 2;

  /** One example row to copy, using names this business actually has. */
  const example = [
    'Rice (long grain)', 'kg', toInput(1250, decimals), '40', '25', '8',
    categories?.[0]?.name ?? 'Dry goods',
    suppliers[0]?.name ?? '',
    expenseCategories?.[0]?.name ?? 'Supplies',
    'no', '', '',
  ];

  const read = (grid: string[][]): Read => {
    const [head, ...body] = grid;
    if (!head || body.length === 0) throw new Error('That file has headings but no rows.');

    const headers = head.map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
    const missing = ['name', 'unit'].filter((c) => !headers.includes(c));
    if (missing.length) {
      throw new Error(`The file needs a "${missing.join('" and a "')}" column. Download the template to see the layout.`);
    }

    const at = (cells: string[], col: string) => (cells[headers.indexOf(col)] ?? '').trim();
    const rows: ParsedRow[] = [];

    body.forEach((cells, i) => {
      if (cells.every((c) => !c.trim())) return;
      const problems: string[] = [];
      const name = at(cells, 'name');
      if (!name) problems.push('no name');

      let unit = at(cells, 'unit').toLowerCase();
      if (!UNITS.includes(unit)) {
        problems.push(`unit "${unit || 'blank'}" is not one of ${UNITS.join(', ')}`);
        unit = 'each';
      }

      const costText = at(cells, 'cost_per_unit');
      const cost = costText ? parseMoney(costText, decimals) : 0;
      if (cost === null) problems.push(`"${costText}" is not a price`);

      const num = (col: string) => {
        const raw = at(cells, col);
        if (!raw) return 0;
        const n = Number(raw);
        if (Number.isNaN(n)) { problems.push(`"${raw}" is not a number in ${col}`); return 0; }
        return n;
      };

      const supplierName = at(cells, 'supplier');
      const supplier = supplierName
        ? suppliers.find((s) => s.name.toLowerCase() === supplierName.toLowerCase())
        : undefined;
      if (supplierName && !supplier) problems.push(`no supplier called "${supplierName}"`);

      const catName = at(cells, 'category');
      const cat = catName ? categories?.find((c) => c.name.toLowerCase() === catName.toLowerCase()) : undefined;
      if (catName && !cat) problems.push(`no category called "${catName}"`);

      const expName = at(cells, 'expense_category');
      const exp = expName
        ? expenseCategories?.find((c) => c.name.toLowerCase() === expName.toLowerCase())
        : undefined;
      if (expName && !exp) problems.push(`no expense category called "${expName}"`);

      const lowRaw = at(cells, 'low_warning_at');

      /*
        A pack is refused rather than ignored when it does not make sense.

        Getting this wrong is not a small error: a pack size of 28 on the wrong
        row multiplies that shelf by twenty-eight and divides its cost by the
        same, and nothing downstream looks obviously wrong until a count. So a
        bad one keeps the row out of the import and says why.
      */
      const packName = at(cells, 'bought_as');
      const packSize = num('units_per_purchase');
      const packSays = packProblem(packSize, unit, packName);
      if (packSays) problems.push(packSays);

      rows.push({
        line: i + 2,
        name,
        unit,
        cost: cost ?? 0,
        qty: num('in_stock'),
        par: num('par_level'),
        low: lowRaw ? num('low_warning_at') : undefined,
        category: cat?.key ?? '',
        supplierId: supplier?.$id ?? '',
        expenseKey: exp?.key ?? '',
        critical: /^(y|yes|true|1)$/i.test(at(cells, 'critical')),
        packName,
        packSize,
        existingId: existing.find((e) => e.name.toLowerCase() === name.toLowerCase())?.$id,
        problems,
      });
    });

    return { rows };
  };

  const usableOf = (r: Read) => r.rows.filter((x) => x.problems.length === 0);

  return (
    <ImportDialog<Read>
      title="Import stock from a spreadsheet"
      intro={<p style={{ marginTop: 0 }}>
        Start from the template; it has the right headings and one example row. Fill it in with any spreadsheet
        program, save as CSV, and bring it back here. Nothing is written until you have seen what will happen.
      </p>}
      template={{ name: 'stock-template', headings: COLUMNS.map((c) => c.heading), rows: [example] }}
      columns={COLUMNS}
      read={read}
      problems={(r) => r.rows.filter((x) => x.problems.length > 0).map((x) => ({
        line: x.line,
        message: `${x.name ? `${x.name}: ` : ''}${x.problems.join('; ')}`,
      }))}
      problemsStop={false}
      count={(r) => usableOf(r).length}
      action={(n) => (n ? `Import ${n} ${n === 1 ? 'row' : 'rows'}` : 'Nothing to import')}
      body={(r) => {
        const usable = usableOf(r);
        const updates = usable.filter((x) => x.existingId);
        const creates = usable.filter((x) => !x.existingId);
        return (
          <>
            <div className="row row-wrap" style={{ marginBottom: '0.7rem' }}>
              <Badge tone="ok">{creates.length} new</Badge>
              {updates.length > 0 && <Badge tone="warn">{updates.length} already exist</Badge>}
            </div>

            {updates.length > 0 && (
              <Field label="Ingredients that already exist" hint="Matched by name, ignoring capitals.">
                <Select value={onConflict} onChange={(e) => setOnConflict(e.target.value as 'update' | 'skip')}>
                  <option value="update">Update them with the values in the file</option>
                  <option value="skip">Leave them exactly as they are</option>
                </Select>
              </Field>
            )}

            <div className="table-wrap" style={{ maxHeight: '32vh', overflowY: 'auto' }}>
              <table className="data">
                <thead>
                  <tr>
                    <th>Ingredient</th><th>Unit</th><th className="num">Cost</th>
                    <th className="num">In stock</th><th className="num">Par</th><th>What happens</th>
                  </tr>
                </thead>
                <tbody>
                  {usable.map((x) => (
                    <tr key={x.line}>
                      <td>{x.name}</td>
                      <td className="dim">{x.unit}</td>
                      <td className="num">{toInput(x.cost, decimals)}</td>
                      <td className="num dim">{x.qty}</td>
                      <td className="num dim">{x.par}</td>
                      <td>
                        {x.existingId
                          ? onConflict === 'skip'
                            ? <Badge>Left alone</Badge>
                            : <Badge tone="warn">Updated</Badge>
                          : <Badge tone="ok">Added</Badge>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        );
      }}
      write={async (r) => {
        let created = 0;
        let updated = 0;
        const broken = r.rows.length - usableOf(r).length;
        for (const x of usableOf(r)) {
          const payload = {
            venue_id: venueId,
            name: x.name,
            unit: x.unit,
            base_unit_cost: x.cost,
            // Which side's shelves these sit on, taken from the page doing the
            // importing. A bar counting rice and a kitchen counting gin are both
            // counting somebody else's larder.
            module,
            current_qty: x.qty,
            par_level: x.par,
            critical: x.critical,
            supplier_id: x.supplierId,
            category: x.category,
            expense_category_key: x.expenseKey,
            active: true,
            pack_size: x.packSize,
            pack_name: x.packName,
            ...(x.low !== undefined ? { low_threshold: x.low } : {}),
          };
          if (x.existingId) {
            if (onConflict === 'skip') continue;
            await db.updateDocument(DB_ID, 'ingredients', x.existingId, payload);
            updated += 1;
          } else {
            await db.createDocument(DB_ID, 'ingredients', ID.unique(), payload);
            created += 1;
          }
        }
        onDone(`${created} added, ${updated} updated${broken ? `, ${broken} skipped` : ''}`);
        return undefined;
      }}
      onClose={onClose}
    />
  );
}
