/**
 * What the file says about how it was made.
 *
 * This is the strongest evidence the tool can offer, and the reason is worth
 * stating: it does not depend on how the student writes. Stylometry punishes
 * anyone whose prose is plain, which in practice means second-language writers
 * and anyone taught to write formally. Editing history does not care about
 * that. A document typed over four sittings looks like one whether the English
 * is elegant or awkward.
 *
 * It is still circumstantial. Every check here has an innocent explanation
 * attached to it, because a marker who is not told the innocent explanation
 * will assume there isn't one.
 */

/** Software strings that say something specific about how the file was made. */
const TOOL_SIGNATURES = [
  { re: /chatgpt|openai/i, note: 'The producing application names an AI service directly.', weight: 'critical' },
  { re: /\b(claude|anthropic)\b/i, note: 'The producing application names an AI service directly.', weight: 'critical' },
  { re: /gemini|bard\b/i, note: 'The producing application names an AI service directly.', weight: 'critical' },
  { re: /copilot|jasper|writesonic|rytr|copy\.ai/i, note: 'The producing application is an AI writing product.', weight: 'critical' },
  { re: /quillbot|paraphras|humaniz|undetectable|spinbot/i, note: 'The producing application is a paraphrasing or "humanising" service, which is used to rewrite text so it fails detection.', weight: 'critical' },
  { re: /skia\/pdf/i, note: 'Made by Chrome\'s print-to-PDF. A web page was printed, rather than a document exported. Worth knowing what page.', weight: 'medium' },
  { re: /wkhtmltopdf|puppeteer|playwright|headless|weasyprint|dompdf|jsPDF/i, note: 'Generated from HTML by a script or headless browser, not written in an editor.', weight: 'medium' },
  { re: /quartz\s*pdfcontext/i, note: 'Printed to PDF on macOS, so the source was displayed on screen and printed rather than exported.', weight: 'low' },
  { re: /google docs renderer/i, note: 'Exported from Google Docs. Google strips editing history on export, so the absence of one here means nothing.', weight: 'none' },
  { re: /libreoffice|openoffice/i, note: 'Written in LibreOffice/OpenOffice.', weight: 'none' },
  { re: /microsoft.*word|microsoft office word/i, note: 'Written in Microsoft Word.', weight: 'none' },
  { re: /pages\b|keynote/i, note: 'Written in Apple Pages.', weight: 'none' },
  { re: /latex|pdftex|xetex|luatex/i, note: 'Typeset with TeX.', weight: 'none' },
];

/**
 * Sustained composition, including thinking, runs at roughly 15-40 words per
 * minute. Transcription of something already written runs far higher. The
 * threshold is set well above any plausible composition rate so that a fast
 * typist does not trip it.
 */
const IMPLAUSIBLE_WPM = 90;

export function analyseProvenance(doc) {
  const m = doc.meta ?? {};
  const findings = [];
  const facts = [];
  const words = countWords(doc.text);

  const toolText = [m.application, m.producer, m.creator, m.company, ...(m.xmpTools ?? [])].filter(Boolean).join(' | ');
  let historyIsMeaningful = true;

  for (const sig of TOOL_SIGNATURES) {
    if (!sig.re.test(toolText)) continue;
    if (/google docs renderer/i.test(toolText)) historyIsMeaningful = false;
    if (sig.weight === 'none') { facts.push(sig.note); continue; }
    findings.push({
      id: 'prov.tool',
      severity: sig.weight,
      title: `Producing software: ${truncate(toolText, 90)}`,
      detail: sig.note,
    });
  }

  if (toolText) facts.push(`Produced by: ${truncate(toolText, 120)}`);
  if (m.author) facts.push(`Author field: ${m.author}`);
  if (m.lastModifiedBy) facts.push(`Last saved by: ${m.lastModifiedBy}`);
  if (m.created) facts.push(`Created: ${m.created}`);
  if (m.modified) facts.push(`Modified: ${m.modified}`);
  if (m.revisionCount != null) facts.push(`Save count: ${m.revisionCount}`);
  if (m.editingMinutes != null) facts.push(`Total editing time: ${formatMinutes(m.editingMinutes)}`);

  // Editing time is only present, and only meaningful, for files written and
  // saved in a desktop editor.
  if (historyIsMeaningful && m.editingMinutes != null && words > 300) {
    const minutes = m.editingMinutes;
    if (minutes === 0) {
      findings.push({
        id: 'prov.no-editing-time',
        severity: 'high',
        title: `${words.toLocaleString()} words with no recorded editing time`,
        detail: 'Word records how long a document was open. Zero minutes against a document this long means the text '
          + 'arrived in it already written, by paste or by conversion. Innocent explanations: the file was created by '
          + 'an export or converter, or written elsewhere and pasted in for formatting.',
      });
    } else if (words / minutes > IMPLAUSIBLE_WPM) {
      findings.push({
        id: 'prov.fast-composition',
        severity: 'high',
        title: `${words.toLocaleString()} words in ${formatMinutes(minutes)} (${Math.round(words / minutes)} words/minute)`,
        detail: `Sustained original composition runs at roughly 15-40 words per minute. ${Math.round(words / minutes)} `
          + 'is transcription or paste speed, not writing speed. Innocent explanation: the student drafted elsewhere '
          + '(by hand, in another app, on a phone) and typed or pasted the final version in.',
      });
    } else {
      facts.push(`Composition rate: about ${Math.round(words / minutes)} words per minute, which is a normal writing pace.`);
    }
  }

  if (historyIsMeaningful && m.editingSessions != null && m.editingSessions <= 1 && words > 600) {
    findings.push({
      id: 'prov.single-session',
      severity: 'medium',
      title: 'Written in a single editing session',
      detail: 'Word stamps each run of text with the id of the session that typed it, and mints a new one every time '
        + 'the file is opened. One id across a long document means it was never returned to. Innocent explanation: '
        + 'the student wrote it in one sitting, or copied their own finished draft into a fresh file.',
    });
  }

  if (historyIsMeaningful && m.revisionCount === 1 && words > 600) {
    findings.push({
      id: 'prov.single-save',
      severity: 'medium',
      title: 'Saved exactly once',
      detail: 'A document written over time accumulates saves. One save across a long document means it existed in '
        + 'final form the first time it was written to disk.',
    });
  }

  const span = timeSpan(m.created, m.modified);
  if (span != null && words > 600) {
    if (span <= 2) {
      findings.push({
        id: 'prov.instant',
        severity: 'medium',
        title: `Created and last modified within ${span < 1 ? 'the same minute' : `${Math.round(span)} minutes`}`,
        detail: 'The whole life of this file was a couple of minutes. Whatever is in it was not composed in it. '
          + 'Innocent explanation: an export, a "save as", or a fresh copy made just before submitting.',
      });
    } else {
      facts.push(`Written over a span of ${formatMinutes(span)}.`);
    }
  }
  if (span != null && span < 0) {
    findings.push({
      id: 'prov.clock',
      severity: 'medium',
      title: 'Modified before it was created',
      detail: 'The timestamps are inconsistent, which happens when a system clock is wrong or has been changed. '
        + 'Not evidence of anything on its own, but it means the other timestamps cannot be relied on.',
    });
  }

  if (m.author && m.lastModifiedBy && normalise(m.author) !== normalise(m.lastModifiedBy)) {
    findings.push({
      id: 'prov.author-mismatch',
      severity: 'medium',
      title: `Created by "${m.author}", last saved by "${m.lastModifiedBy}"`,
      detail: 'Two different people touched this file. Innocent explanations: a shared or lab computer, a borrowed '
        + 'template, or a family member\'s laptop. Worth asking about when the names are unfamiliar.',
    });
  }

  if (m.trackedInsertions > 0 || m.trackedDeletions > 0) {
    facts.push(`Contains tracked changes (${m.trackedInsertions} insertions, ${m.trackedDeletions} deletions`
      + `${m.trackedAuthors?.length ? `, by ${m.trackedAuthors.join(', ')}` : ''}). Visible revision work is a point in the student's favour.`);
  }

  if (m.textLayer === 'none') {
    findings.push({
      id: 'prov.no-text-layer',
      severity: 'info',
      title: 'PDF has no text layer',
      detail: 'This is a scan or an image-only export, so nothing in it can be read or checked automatically. It also '
        + 'defeats plagiarism matching, which is why some submission policies disallow it. Run OCR, or ask for the source file.',
    });
  } else if (m.textLayer === 'unreadable') {
    findings.push({
      id: 'prov.unreadable-text',
      severity: 'info',
      title: 'PDF text could not be decoded reliably',
      detail: 'The fonts are subset with a custom encoding, so the extracted characters are not trustworthy. Style '
        + 'analysis has been skipped for this file; the metadata findings still hold.',
    });
  }

  if (m.formulaCells != null) {
    const total = m.formulaCells + m.valueCells;
    if (total > 40 && m.formulaCells === 0) {
      findings.push({
        id: 'prov.no-formulas',
        severity: 'medium',
        title: `Workbook has ${total.toLocaleString()} filled cells and no formulas`,
        detail: 'Every number here was typed rather than calculated. If the task was to build a working model, this '
          + 'does not do it, regardless of who produced the numbers. Innocent explanation: values were pasted from '
          + 'another tool, or the workbook is a data table rather than a model.',
      });
    } else if (m.formulaCells > 0) {
      facts.push(`${m.formulaCells.toLocaleString()} formula cells against ${m.valueCells.toLocaleString()} value cells`
        + `${m.sampleFormulas?.length ? `, e.g. ${m.sampleFormulas.slice(0, 3).map((f) => `=${f}`).join(', ')}` : ''}.`);
    }
  }

  if (!historyIsMeaningful) {
    facts.push('Edit-history checks were skipped: this file came out of Google Docs, which does not write one. '
      + 'Their absence here is not a finding.');
  } else if (m.editingMinutes == null && m.revisionCount == null && doc.kind !== 'pdf' && doc.kind !== 'text') {
    facts.push('This file carries no editing history, which happens when a document has been through a converter. '
      + 'No conclusion either way.');
  }

  return { findings, facts, historyIsMeaningful };
}

function countWords(text) {
  return (text.match(/\S+/g) || []).length;
}

function timeSpan(created, modified) {
  if (!created || !modified) return null;
  const a = Date.parse(created);
  const b = Date.parse(modified);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return (b - a) / 60000;
}

function formatMinutes(mins) {
  const m = Math.round(Math.abs(mins));
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function normalise(s) {
  return String(s).trim().toLowerCase();
}

function truncate(s, n) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
