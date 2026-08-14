import { INVISIBLE } from '../analyze/hidden.mjs';

/**
 * The document, shown back with every flagged string marked in place.
 *
 * This is the part of the report a student can actually be shown. A list of
 * findings tells a marker what to think; a marked-up page lets both of them
 * look at the same sentence. Paragraphs are numbered in the margin, and the
 * numbers are the same ones the findings quote, so "paragraph 4, sentence 2"
 * resolves to somewhere the eye can land.
 *
 * Highlights are keyed to a numbered list of suggestions below, because a
 * tooltip cannot be printed and much of this ends up on paper.
 */

export function annotatedHtml(text, annotations) {
  if (!text.trim()) return '';

  let html = '';
  let cursor = 0;

  annotations.forEach((a, i) => {
    // Annotations are deduplicated upstream, but a stray overlap here would
    // produce interleaved tags and a broken page, so it is skipped instead.
    if (a.start < cursor || a.end > text.length) return;

    html += esc(text.slice(cursor, a.start));
    html += `<mark class="hl sev-${esc(a.severity)}" id="hl-${i + 1}">`
      + `${renderSpan(text.slice(a.start, a.end))}`
      + `<a class="ref" href="#note-${i + 1}" title="${esc(a.label)}">${i + 1}</a></mark>`;
    cursor = a.end;
  });

  html += esc(text.slice(cursor));
  return numberParagraphs(html);
}

/**
 * Render a flagged span.
 *
 * A watermark's characters are invisible by definition, so printing them
 * verbatim would produce a highlight around apparently nothing. Those get a
 * label saying what is there instead.
 */
function renderSpan(raw) {
  const visible = raw.replace(INVISIBLE, '');
  if (visible.trim()) return esc(raw);

  const n = [...raw].length;
  return `<span class="ghost">${n} invisible character${n === 1 ? '' : 's'}</span>`;
}

/** Wrap each paragraph with the number the findings refer to. */
function numberParagraphs(html) {
  return html
    .split(/\n\s*\n/)
    .filter((p) => p.trim())
    .map((p, i) => `<p class="para"><span class="pnum" aria-hidden="true">${i + 1}</span>${p.replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

/**
 * The numbered suggestions that sit under the marked-up document.
 *
 * Each entry says where it is, what is there, and what to put instead. The
 * before/after pair is the useful part: it is a sentence the marker can paste
 * into a comment without rewriting it themselves.
 */
export function noteList(annotations) {
  if (!annotations.length) return '';

  return `<ol class="notes">${annotations.map((a, i) => `
    <li id="note-${i + 1}" class="note sev-${esc(a.severity)}">
      <div class="note-head">
        <a class="back" href="#hl-${i + 1}" title="Back to the text">↑</a>
        <code>${esc(displayText(a.text))}</code>
        ${a.where ? `<span class="where">${esc(a.where)}</span>` : ''}
      </div>
      ${a.suggestion ? `<p class="why">${esc(a.suggestion.why)}</p>` : ''}
      ${suggestionHtml(a)}
    </li>`).join('')}</ol>`;
}

function suggestionHtml(a) {
  if (!a.suggestion) return '';

  if (a.suggestion.action === 'delete-sentence') {
    return '<p class="fix"><strong>Cut the whole sentence.</strong> Nothing in it is about the topic.</p>';
  }
  if (a.suggestion.action === 'advise') return '';

  if (a.noVisibleChange) {
    return '<p class="fix"><strong>Delete them.</strong> Nothing a reader can see changes, which is exactly why '
      + 'they are worth asking about.</p>';
  }

  if (!a.after || !a.before) {
    const alts = a.suggestion.alternatives ?? [];
    if (a.suggestion.action === 'delete') return '<p class="fix"><strong>Delete it.</strong></p>';
    return alts.length ? `<p class="fix"><strong>Try:</strong> ${alts.map((x) => `<em>${esc(x)}</em>`).join(' · ')}</p>` : '';
  }

  const alternatives = (a.suggestion.alternatives ?? []).slice(1);
  return `<div class="ba">
    <div class="was"><span class="tag">as written</span>${esc(a.before)}</div>
    <div class="now"><span class="tag">suggested</span>${esc(a.after)}</div>
    ${alternatives.length ? `<p class="alts">Or: ${alternatives.map((x) => `<em>${esc(x)}</em>`).join(' · ')}</p>` : ''}
  </div>`;
}

/** Invisible spans need a description rather than their own characters. */
export function displayText(s) {
  const visible = s.replace(INVISIBLE, '');
  if (visible.trim()) return s.replace(/\s+/g, ' ').trim();
  const n = [...s].length;
  return `${n} invisible character${n === 1 ? '' : 's'}`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

export const ANNOTATION_CSS = `
.annotated{background:var(--bg);border:1px solid var(--line);border-radius:10px;
  padding:1.1rem 1.3rem;margin:.8rem 0;max-height:32rem;overflow-y:auto}
.para{position:relative;margin:0 0 .85rem;padding-left:2.2rem;font-size:.9rem;line-height:1.75}
.pnum{position:absolute;left:0;top:.15rem;width:1.6rem;text-align:right;
  font:11px ui-monospace,Menlo,monospace;color:var(--muted);opacity:.65;user-select:none}
mark.hl{background:var(--blue-bg);color:inherit;border-bottom:2px solid var(--blue);
  border-radius:2px;padding:0 .05rem}
mark.hl.sev-critical,mark.hl.sev-high{background:var(--red-bg);border-bottom-color:var(--red)}
mark.hl.sev-medium{background:var(--amber-bg);border-bottom-color:var(--amber)}
mark.hl .ref{font-size:.62rem;vertical-align:super;margin-left:.12rem;font-weight:700;
  text-decoration:none;color:var(--muted)}
.ghost{font:11.5px ui-monospace,Menlo,monospace;color:var(--muted);font-style:normal;
  border:1px dashed var(--line);border-radius:3px;padding:0 .25rem}
.notes{margin:.8rem 0 0;padding-left:0;list-style:none;counter-reset:n}
.note{counter-increment:n;border-left:2px solid var(--line);padding:.15rem 0 .15rem .85rem;margin:.85rem 0}
.note.sev-critical,.note.sev-high{border-left-color:var(--red)}
.note.sev-medium{border-left-color:var(--amber)}
.note-head{display:flex;align-items:baseline;gap:.5rem;flex-wrap:wrap}
.note-head::before{content:counter(n) ".";font-weight:700;font-size:.78rem;color:var(--muted)}
.note-head code{font-size:12px;background:var(--bg);padding:.1rem .35rem;border-radius:4px}
.back{text-decoration:none;color:var(--muted);font-size:.75rem}
.where{font-size:.76rem;color:var(--muted)}
.why{margin:.3rem 0;font-size:.84rem;color:var(--muted)}
.fix{margin:.3rem 0;font-size:.86rem}
.ba{margin:.4rem 0;font-size:.85rem;display:grid;gap:.3rem}
.was,.now{padding:.4rem .6rem;border-radius:6px;background:var(--bg);border:1px solid var(--line)}
.now{border-left:3px solid var(--green)}
.was{border-left:3px solid var(--line);color:var(--muted)}
.tag{display:block;font-size:.64rem;text-transform:uppercase;letter-spacing:.07em;
  color:var(--muted);margin-bottom:.15rem}
.alts{margin:.25rem 0 0;font-size:.8rem;color:var(--muted)}
@media print{.annotated{max-height:none;overflow:visible}}
`;
