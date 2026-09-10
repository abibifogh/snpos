import { useState, type ReactNode } from 'react';
import { Badge, Button, Modal, Notice } from '@snpos/ui';
import { downloadCsv, toCsv, parseCsv, readXlsx, looksLikeXlsx } from '@snpos/core';
import { humanError } from '../lib';

/**
 * One dialog for everything that arrives as a file.
 *
 * Six uploads — makers, drinks, craft stock, kitchen stock, opening levels,
 * a shelf count — each carried its own copy of the same chrome: a template
 * button, a file picker with the file's name beside it, a table saying what
 * each column means, a list of problems, a read-back, a primary button that
 * names how many rows it will write, and a "done" screen. Six copies drifted:
 * one refused a file over any problem, another skipped the bad rows; one
 * capped the problem list at eight, another at twenty; one parsed CSV with
 * its own splitter that mishandled quotes.
 *
 * The chrome is here, once. Each upload keeps only what is its own: how a
 * file is read into rows, what the read-back shows, and what writing means.
 */
export interface ImportColumn {
  key: string;
  heading: string;
  required?: boolean;
  help: string;
}

export interface ImportProblem {
  line: number;
  message: string;
}

export interface ImportDialogProps<R> {
  title: string;
  /** What this upload is for, in a sentence or two, and anything it must warn about first. */
  intro: ReactNode;
  /** The template: a file name and its rows, headed. */
  template?: { name: string; headings: readonly string[]; rows: readonly (readonly string[])[] };
  /** What each column means, shown until a file is chosen. */
  columns?: readonly ImportColumn[];
  /** Whether a spreadsheet is accepted as well as a csv. */
  xlsx?: boolean;
  /** Turn the file's grid into whatever this upload reads. */
  read: (grid: string[][]) => R | Promise<R>;
  /** The problems in what was read, and whether they stop the write or only skip rows. */
  problems: (read: R) => ImportProblem[];
  problemsStop?: boolean;
  /** How many rows a write would touch. Nothing to write disables the button. */
  count: (read: R) => number;
  /** The button's words, given how many. */
  action: (n: number) => string;
  /** What was read, shown back before anything is written. */
  body: (read: R) => ReactNode;
  /** Write it. What comes back is shown on the done screen; undefined closes instead. */
  write: (read: R) => Promise<ReactNode | undefined>;
  onClose: () => void;
  /** Anything below the intro that is not part of the read-back (a switch, a warning). */
  before?: ReactNode;
  /** A hand-picked read-back replaces the default problems list too. */
  ownProblems?: boolean;
}

const MAX_PROBLEMS = 15;

export function ImportDialog<R>({
  title, intro, template, columns, xlsx, read, problems, problemsStop = true, count, action, body, write, onClose, before, ownProblems,
}: ImportDialogProps<R>) {
  const [got, setGot] = useState<R | null>(null);
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<ReactNode | null>(null);

  const downloadTemplate = () => {
    if (!template) return;
    downloadCsv(template.name, toCsv([...template.headings], template.rows.map((r) => [...r])));
  };

  /** By the bytes, not the name: a csv called .xlsx and the reverse both happen. */
  const take = async (f: File) => {
    setError(null);
    setGot(null);
    setFileName(f.name);
    try {
      const data = await f.arrayBuffer();
      const grid = xlsx && looksLikeXlsx(data) ? await readXlsx(data) : parseCsv(new TextDecoder().decode(data));
      setGot(await read(grid));
    } catch (e) {
      setError(humanError(e));
    }
  };

  const found = got ? problems(got) : [];
  const n = got ? count(got) : 0;
  const stopped = problemsStop && found.length > 0;
  const ready = !!got && n > 0 && !stopped;

  const go = async () => {
    if (!got || !ready) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await write(got);
      if (outcome === undefined) onClose();
      else setDone(outcome);
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <Modal wide title="Done" onClose={onClose} footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
        {done}
      </Modal>
    );
  }

  return (
    <Modal
      wide
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void go()} loading={busy} disabled={!ready}>
            {action(ready ? n : 0)}
          </Button>
        </>
      }
    >
      {error && <div style={{ marginBottom: '0.9rem' }}><Notice>{error}</Notice></div>}

      <div className="small dim" style={{ marginTop: 0 }}>{intro}</div>
      {before}

      <div className="row" style={{ gap: '0.5rem', margin: '0.9rem 0', flexWrap: 'wrap' }}>
        {template && <Button onClick={downloadTemplate}>Download the template</Button>}
        <label className="btn" style={{ cursor: 'pointer' }}>
          {fileName ? 'Choose a different file' : 'Choose a file'}
          <input
            type="file"
            accept={xlsx ? '.csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : '.csv,text/csv'}
            style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void take(f); }}
          />
        </label>
        {fileName && <span className="small dim" style={{ alignSelf: 'center' }}>{fileName}</span>}
      </div>

      {!got && columns && columns.length > 0 && (
        <details>
          <summary className="small dim" style={{ cursor: 'pointer' }}>What each column is for</summary>
          <div className="table-wrap" style={{ marginTop: '0.5rem' }}>
            <table className="data">
              <thead><tr><th>Column</th><th>What to write in it</th></tr></thead>
              <tbody>
                {columns.map((c) => (
                  <tr key={c.key}>
                    <td><code>{c.heading}</code>{c.required && <Badge tone="warn"> needed</Badge>}</td>
                    <td className="small dim">{c.help}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {got && !ownProblems && found.length > 0 && (
        <>
          {stopped ? (
            /* Nothing is written while anything is wrong. Half a file is worse
               than none: nobody would know where it stopped. */
            <Notice>
              <strong>{found.length} thing{found.length === 1 ? '' : 's'} to fix.</strong> Nothing has been saved.
              Correct these in the file and choose it again.
            </Notice>
          ) : (
            /* Warned, not refused: a stock export routinely carries things the
               shelf does not hold, and rejecting the file over one of them
               would be rejecting the useful part. */
            <Notice tone="warn">
              <strong>{found.length} row{found.length === 1 ? '' : 's'} will be skipped.</strong> Everything else still goes in.
            </Notice>
          )}
          <ul className="small">
            {found.slice(0, MAX_PROBLEMS).map((p, i) => <li key={i}>Line {p.line}: {p.message}</li>)}
            {found.length > MAX_PROBLEMS && <li className="dim">and {found.length - MAX_PROBLEMS} more</li>}
          </ul>
        </>
      )}

      {got && !stopped && body(got)}
    </Modal>
  );
}
