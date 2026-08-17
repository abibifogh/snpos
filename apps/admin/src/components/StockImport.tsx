import { useRef, useState } from 'react';
import { Badge, Button, Field, Modal, Notice, Select } from '@snpos/ui';
import { db, DB_ID, ID, humanError } from '../lib';
import { parseMoney, toInput, packProblem } from '@snpos/core';
import type { Ingredient, Settings, Module } from '@snpos/core';
import type { KeyedRow } from './KeyedList';

/**
 * Bulk stock entry from a spreadsheet.
 *
 * Typing sixty ingredients one modal at a time is the reason stock never gets
 * set up. The template exists because "just upload a CSV" is only simple for
 * people who already know what columns it wants.
 *
 * Nothing is written until the whole file has been read and shown back. An
 * import that half-works leaves a stock list nobody trusts, which is worse
 * than one that refused.
 */

interface Supplier { $id: string; name: string }

const COLUMNS = [
  'name', 'unit', 'cost_per_unit', 'in_stock', 'par_level',
  'low_warning_at', 'category', 'supplier', 'expense_category', 'critical',
  // How it arrives, when that is not how it is counted: a bar buys a bottle
  // and pours shots. Both optional — a kitchen buying rice by the kilo leaves
  // them off entirely and nothing changes. See packs.ts.
  'bought_as', 'units_per_purchase',
];

/**
 * Bar units are here too, and they are not decoration.
 *
 * "0.7 l of gin" is a sentence nobody at a bar says while holding a bottle,
 * and a spreadsheet that refuses `bottle` sends somebody to convert forty
 * lines into litres by hand — which is where the mistakes come from.
 */
const UNITS = ['g', 'kg', 'ml', 'l', 'each', 'pack', 'bottle', 'case', 'shot', 'cl'];

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

/** Split one CSV line, honouring quotes so "Rice, long grain" stays one field. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map((v) => v.trim());
}

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
  const fileInput = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<ParsedRow[] | null>(null);
  const [fileName, setFileName] = useState('');
  const [onConflict, setOnConflict] = useState<'update' | 'skip'>('update');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decimals = settings?.currency_decimals ?? 2;

  /** A file with the headings filled in and one example row to copy. */
  const downloadTemplate = () => {
    const example = [
      'Rice (long grain)', 'kg', toInput(1250, decimals), '40', '25', '8',
      categories?.[0]?.name ?? 'Dry goods',
      suppliers[0]?.name ?? '',
      expenseCategories?.[0]?.name ?? 'Supplies',
      'no',
    ];
    const csv = [COLUMNS.join(','), example.map((v) => (v.includes(',') ? `"${v}"` : v)).join(',')].join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'stock-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const read = async (file: File) => {
    setError(null);
    setFileName(file.name);
    const text = await file.text();
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) {
      setError('That file has headings but no rows.');
      setRows(null);
      return;
    }

    const headers = splitCsvLine(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, '_'));
    const missing = ['name', 'unit'].filter((c) => !headers.includes(c));
    if (missing.length) {
      setError(`The file needs a "${missing.join('" and a "')}" column. Download the template to see the layout.`);
      setRows(null);
      return;
    }

    const at = (cells: string[], col: string) => cells[headers.indexOf(col)] ?? '';
    const parsed: ParsedRow[] = [];

    for (let i = 1; i < lines.length; i += 1) {
      const cells = splitCsvLine(lines[i]);
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

      parsed.push({
        line: i + 1,
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
    }

    setRows(parsed);
  };

  const usable = (rows ?? []).filter((r) => r.problems.length === 0);
  const broken = (rows ?? []).filter((r) => r.problems.length > 0);
  const updates = usable.filter((r) => r.existingId);
  const creates = usable.filter((r) => !r.existingId);

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      let created = 0;
      let updated = 0;
      for (const r of usable) {
        const payload = {
          venue_id: venueId,
          name: r.name,
          unit: r.unit,
          base_unit_cost: r.cost,
          // Which side's shelves these sit on, taken from the page doing the
          // importing. A bar counting rice and a kitchen counting gin are both
          // counting somebody else's larder.
          module,
          current_qty: r.qty,
          par_level: r.par,
          critical: r.critical,
          supplier_id: r.supplierId,
          category: r.category,
          expense_category_key: r.expenseKey,
          active: true,
          pack_size: r.packSize,
          pack_name: r.packName,
          ...(r.low !== undefined ? { low_threshold: r.low } : {}),
        };
        if (r.existingId) {
          if (onConflict === 'skip') continue;
          await db.updateDocument(DB_ID, 'ingredients', r.existingId, payload);
          updated += 1;
        } else {
          await db.createDocument(DB_ID, 'ingredients', ID.unique(), payload);
          created += 1;
        }
      }
      onDone(`${created} added, ${updated} updated${broken.length ? `, ${broken.length} skipped` : ''}`);
    } catch (e) {
      setError(humanError(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Import stock from a spreadsheet"
      wide
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={apply} loading={busy} disabled={usable.length === 0}>
            {usable.length === 0 ? 'Nothing to import' : `Import ${usable.length} ${usable.length === 1 ? 'row' : 'rows'}`}
          </Button>
        </>
      }
    >
      {error && <div style={{ marginBottom: '1rem' }}><Notice>{error}</Notice></div>}

      <p className="small dim" style={{ marginTop: 0 }}>
        Start from the template; it has the right headings and one example row. Fill it in with any spreadsheet
        program, save as CSV, and bring it back here. Nothing is written until you have seen what will happen.
      </p>

      <div className="row" style={{ marginBottom: '1rem' }}>
        <Button size="sm" onClick={downloadTemplate}>Download the template</Button>
        <Button size="sm" variant="primary" onClick={() => fileInput.current?.click()}>
          {fileName ? 'Choose a different file' : 'Choose your file'}
        </Button>
        {fileName && <span className="small dim">{fileName}</span>}
        <input
          ref={fileInput}
          type="file"
          accept=".csv,text/csv"
          style={{ display: 'none' }}
          onChange={(e) => e.target.files?.[0] && read(e.target.files[0])}
        />
      </div>

      {rows && (
        <>
          <div className="row row-wrap" style={{ marginBottom: '0.7rem' }}>
            <Badge tone="ok">{creates.length} new</Badge>
            {updates.length > 0 && <Badge tone="warn">{updates.length} already exist</Badge>}
            {broken.length > 0 && <Badge tone="danger">{broken.length} cannot be read</Badge>}
          </div>

          {updates.length > 0 && (
            <Field label="Ingredients that already exist" hint="Matched by name, ignoring capitals.">
              <Select value={onConflict} onChange={(e) => setOnConflict(e.target.value as 'update' | 'skip')}>
                <option value="update">Update them with the values in the file</option>
                <option value="skip">Leave them exactly as they are</option>
              </Select>
            </Field>
          )}

          {broken.length > 0 && (
            <div style={{ marginBottom: '0.8rem' }}>
              <Notice tone="warn">
                These rows are skipped. Everything else still imports, fix them and run the file again.
              </Notice>
              <ul className="small" style={{ margin: '0.5rem 0 0', paddingLeft: '1.2rem' }}>
                {broken.slice(0, 8).map((r) => (
                  <li key={r.line}>
                    Row {r.line}{r.name ? ` (${r.name})` : ''}: {r.problems.join('; ')}
                  </li>
                ))}
                {broken.length > 8 && <li className="dim">…and {broken.length - 8} more</li>}
              </ul>
            </div>
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
                {usable.map((r) => (
                  <tr key={r.line}>
                    <td>{r.name}</td>
                    <td className="dim">{r.unit}</td>
                    <td className="num">{toInput(r.cost, decimals)}</td>
                    <td className="num dim">{r.qty}</td>
                    <td className="num dim">{r.par}</td>
                    <td>
                      {r.existingId
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
      )}
    </Modal>
  );
}
