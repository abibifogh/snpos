import { SEVERITY_LABEL } from '../score.mjs';
import { WORDLIST_UPDATED } from '../analyze/lexical.mjs';
import { summaryParts } from './summary.mjs';

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
