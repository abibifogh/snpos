import { SEVERITY_LABEL } from '../score.mjs';
import { WORDLIST_UPDATED } from '../analyze/lexical.mjs';
import { summaryParts } from './summary.mjs';
import { displayText } from './annotate.mjs';

/**
 * The terminal report.
 *
 * Ordered so that the strongest evidence is the first thing on screen and the
 * statistical guesswork is last, under a heading that says what it is. A
 * marker skim-reading the top of the output should come away with the right
 * impression; that is only true if the ordering does the work.
 */

const useColour = !process.env.NO_COLOR && process.stdout.isTTY;
const c = (code) => (s) => (useColour ? `\x1b[${code}m${s}\x1b[0m` : s);

const bold = c('1');
const dim = c('2');
const red = c('31');
const yellow = c('33');
const blue = c('36');
const green = c('32');

const SEVERITY_COLOUR = {
  critical: red, high: red, medium: yellow, low: blue, info: dim, none: green,
};

export function textReport(result, opts = {}) {
  const lines = [];
  const { documents, batch } = result;

  lines.push('');
  lines.push(bold(`Checked ${documents.length} submission${documents.length === 1 ? '' : 's'}`));
  lines.push(dim(`${new Date(result.generatedAt).toUTCString()}`));
  lines.push('');

  for (const doc of documents) lines.push(...documentSection(doc, opts));

  if (batch.findings.length) {
    lines.push(rule());
    lines.push(bold('Across the batch'));
    lines.push('');
    for (const f of batch.findings) lines.push(...finding(f));
  }

  lines.push(rule());
  lines.push(...limitations());

  return lines.join('\n');
}

function documentSection(doc, opts) {
  const lines = [rule(), bold(doc.name)];

  if (doc.error) {
    lines.push(`  ${red('Could not read this file')}: ${doc.error}`);
    lines.push('');
    return lines;
  }

  const bandColour = { direct: red, strong: red, moderate: yellow, low: green }[doc.scored.band.key];
  lines.push(`  ${bandColour(doc.scored.band.label.toUpperCase())} — ${doc.scored.band.blurb}`);
  lines.push(`  ${bold('What to do:')} ${doc.scored.band.action}`);
  lines.push('');

  lines.push(dim(`  ${summaryParts(doc).join(' · ')}`));
  lines.push('');

  const { direct, supporting, inference } = doc.scored.groups;

  if (direct.length) {
    lines.push(`  ${bold(red('Evidence'))} ${dim('— facts about the file, not inferences from it')}`);
    lines.push('');
    for (const f of direct) lines.push(...finding(f, 2));
  }

  if (supporting.length) {
    lines.push(`  ${bold('Document history and structure')} ${dim('— circumstantial, but independent of writing style')}`);
    lines.push('');
    for (const f of supporting) lines.push(...finding(f, 2));
  }

  if (inference.length) {
    lines.push(`  ${bold('Writing style')} ${dim('— weak signals; see the note at the end before weighing these')}`);
    lines.push('');
    for (const f of inference) lines.push(...finding(f, 2));
    if (doc.scored.breakdown.inferenceCapped) {
      lines.push(dim('    (Style signals are capped in the overall picture: they mostly measure one trait, not several.)'));
      lines.push('');
    }
    if (doc.scored.breakdown.styleDiscarded) {
      lines.push(dim('    (Excluded from the overall picture: too little text for these to mean anything.)'));
      lines.push('');
    }
  }

  if (doc.styleNote) { lines.push(dim(`  ${doc.styleNote}`)); lines.push(''); }

  lines.push(...annotationLines(doc, opts));

  if (!direct.length && !supporting.length && !inference.length) {
    lines.push(`  ${green('Nothing flagged.')}`);
    lines.push('');
  }

  if (doc.facts?.length && opts.verbose !== false) {
    lines.push(dim('  File details'));
    for (const f of doc.facts) lines.push(dim(`    · ${f}`));
    lines.push('');
  }

  if (opts.metrics && doc.metrics?.words) {
    lines.push(dim('  Measurements'));
    for (const [k, v] of Object.entries(doc.metrics)) {
      if (v == null || typeof v === 'object') continue;
      lines.push(dim(`    ${k.padEnd(24)} ${typeof v === 'number' ? Number(v.toFixed(3)) : v}`));
    }
    lines.push('');
  }

  return lines;
}

/**
 * Every flagged string, where it is, and what to put instead.
 *
 * Capped in the terminal because a long essay can carry sixty of these and a
 * screen of them scrolls the findings off the top. The full set always reaches
 * the HTML report, and the count of what was withheld is printed so the cap is
 * never mistaken for the total.
 */
function annotationLines(doc, opts) {
  const all = doc.annotations ?? [];
  if (!all.length) return [];

  const limit = opts.allAnnotations ? all.length : 15;
  const shown = all.slice(0, limit);
  const lines = [
    `  ${bold('Where it is, and what to say instead')}`,
    dim('  Plain-English alternatives for feedback. Most of what is flagged here is padding,'),
    dim('  which is worth cutting whoever wrote it.'),
    '',
  ];

  for (const [i, a] of shown.entries()) {
    const where = a.where ? dim(` — ${a.where}`) : '';
    lines.push(`    ${dim(`${String(i + 1).padStart(2)}.`)} ${yellow(`“${displayText(a.text)}”`)}${where}`);

    if (a.suggestion?.action === 'delete-sentence') {
      lines.push(`        ${green('Cut the whole sentence.')} ${dim(a.suggestion.why)}`);
    } else if (a.noVisibleChange) {
      lines.push(`        ${green('Delete them.')} ${dim('Nothing a reader can see changes.')}`);
    } else if (a.after && a.before) {
      const [was, now] = focusPair(a.before, a.after, 84);
      lines.push(dim(`        was:  ${was}`));
      lines.push(`        ${green('now:')}  ${now}`);
      const alts = (a.suggestion.alternatives ?? []).slice(1);
      if (alts.length) lines.push(dim(`        or:   ${alts.join(' · ')}`));
    } else if (a.suggestion) {
      lines.push(dim(`        ${a.suggestion.why}`));
    }
    lines.push('');
  }

  if (all.length > shown.length) {
    lines.push(dim(`    …and ${all.length - shown.length} more. Use --html for the full marked-up document, or --all.`));
    lines.push('');
  }

  return lines;
}

function finding(f, indent = 0) {
  const pad = ' '.repeat(indent + 2);
  const colour = SEVERITY_COLOUR[f.severity] ?? ((s) => s);
  const lines = [`${pad}${colour('●')} ${bold(f.title)} ${dim(`[${SEVERITY_LABEL[f.severity] ?? f.severity}]`)}`];

  for (const line of wrap(f.detail, 92 - pad.length)) lines.push(`${pad}  ${line}`);

  if (f.reference) lines.push(dim(`${pad}  ${f.reference}`));
  for (const q of f.quotes ?? []) lines.push(dim(`${pad}  “${q}”`));
  if (f.context) lines.push(dim(`${pad}  …${f.context}…  ${dim('(· marks an invisible character)')}`));

  lines.push('');
  return lines;
}

function limitations() {
  return [
    bold('How to read this'),
    '',
    ...wrap(
      'No tool can prove text was machine-written, this one included. Statistical style detectors are '
      + 'measurably biased against writers working in a second language and against anyone taught to write in a plain, '
      + 'formal register: Stanford researchers found detectors flagging over half of TOEFL essays by non-native '
      + 'speakers while misclassifying almost none by native speakers. Treat the style section as a reason to read '
      + 'more carefully, never as a finding in itself.',
      96,
    ).map((l) => dim(l)),
    '',
    ...wrap(
      'The findings that carry weight are the ones about the file rather than the prose: editing time, save '
      + 'history, hidden characters, references that do not resolve. Those do not depend on how well someone writes.',
      96,
    ).map((l) => dim(l)),
    '',
    ...wrap(
      'Cryptographic watermarks (Google\'s SynthID, and green-list token biasing generally) live in the choice of '
      + 'words and cannot be read without the provider\'s key. This tool does not detect them, and neither does '
      + 'anything else you can buy. A clean report is not evidence that a document was written by hand.',
      96,
    ).map((l) => dim(l)),
    '',
    dim(`Vocabulary lists current as of ${WORDLIST_UPDATED}; they age quickly as models change.`),
    '',
    ...wrap(
      'The reliable next step is a conversation about process, not a verdict from a report: ask for drafts, ask what '
      + 'was cut and why, ask about a source they cited. That holds up in a way that a score never does.',
      96,
    ).map((l) => dim(l)),
    '',
  ];
}

function rule() {
  return dim('─'.repeat(96));
}

/**
 * Trim a before/after pair to a window that contains the change.
 *
 * Truncating from the left hides the edit whenever it falls late in a long
 * sentence, which leaves two identical-looking lines and no visible
 * suggestion. Both strings are cut at the same offset so they stay aligned.
 */
function focusPair(before, after, width) {
  const a = String(before).replace(/\s+/g, ' ').trim();
  const b = String(after).replace(/\s+/g, ' ').trim();
  if (a.length <= width && b.length <= width) return [a, b];

  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;

  const start = Math.max(0, i - Math.floor(width / 3));
  const cut = (s) => `${start > 0 ? '…' : ''}${s.slice(start, start + width)}${start + width < s.length ? '…' : ''}`;
  return [cut(a), cut(b)];
}

function truncate(s, n) {
  const clean = String(s ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > n ? `${clean.slice(0, n - 1)}…` : clean;
}

function wrap(text, width) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    if (line.length + w.length + 1 > width) { lines.push(line); line = w; }
    else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  return lines;
}
