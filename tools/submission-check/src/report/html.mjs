import { SEVERITY_LABEL } from '../score.mjs';
import { WORDLIST_UPDATED } from '../analyze/lexical.mjs';
import { summaryParts, count } from './summary.mjs';
import { annotatedHtml, noteList, ANNOTATION_CSS } from './annotate.mjs';

/**
 * A standalone HTML report.
 *
 * Self-contained by design: one file, no assets, no network. It has to survive
 * being saved to disk, emailed to a colleague, or attached to a record months
 * later, and still say the same thing including its caveats. A report that
 * loses its caveats when it travels is worse than no report.
 */

export function htmlReport(result, opts = {}) {
  const { documents, batch } = result;
  const flagged = documents.filter((d) => ['direct', 'strong'].includes(d.scored?.band?.key)).length;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Submission check${opts.title ? ` — ${esc(opts.title)}` : ''}</title>
<style>${CSS}${ANNOTATION_CSS}</style>
</head>
<body>
<main>
  <header class="head">
    <h1>Submission check</h1>
    <p class="sub">${esc(count(documents.length, 'file'))} examined${flagged ? ` · ${flagged} needing attention` : ''} · ${esc(new Date(result.generatedAt).toUTCString())}</p>
  </header>

  <section class="callout">
    <h2>Before you read the findings</h2>
    <p>This report cannot tell you whether a document was written by a person. Nothing can. What it can do is
    separate <strong>facts about the file</strong> — its editing history, hidden characters, references that do not
    resolve — from <strong>guesses about the prose</strong>, and show you which is which.</p>
    <p>The prose statistics are the weak part, and they are weak in a specific direction. Detectors built on them
    flag second-language writers far more often than native speakers: a Stanford study found over half of TOEFL
    essays by non-native writers misclassified as machine-generated, against almost none written by native
    speakers. Plain, careful, formal writing looks like generated writing to every statistical measure there is.</p>
    <p>Use this to decide which submissions are worth a conversation. A conversation about process — drafts,
    choices, what got cut — settles the question in a way that a score never will.</p>
  </section>

  ${documents.map(documentCard).join('\n')}

  ${batch.findings.length ? `<section class="card">
    <h2>Across the batch</h2>
    <p class="hint">Comparisons between the files you uploaded. These are measured, not inferred.</p>
    ${batch.findings.map((f) => findingHtml(f)).join('\n')}
  </section>` : ''}

  ${batch.pairs?.length ? overlapTable(batch.pairs) : ''}

  <section class="card limits">
    <h2>Limits of this tool</h2>
    <ul>
      <li><strong>Cryptographic watermarks are not detected.</strong> SynthID and green-list token biasing encode a
      signal in <em>which words were chosen</em>, recoverable only with the provider's key. No third-party tool reads
      them. A clean report here is not evidence of human authorship.</li>
      <li><strong>Steganographic watermarks are detected</strong>, where they exist: invisible Unicode, variation
      selectors, homoglyph substitution. These are facts about the bytes and are reported as such.</li>
      <li><strong>Editing history can be edited.</strong> Metadata is trivially strippable by anyone who knows to. Its
      presence is informative; its absence proves nothing.</li>
      <li><strong>Vocabulary lists go stale.</strong> Current as of ${esc(WORDLIST_UPDATED)}. They track how models
      wrote recently, and today's tells become tomorrow's ordinary academic English.</li>
      <li><strong>Assistance is a spectrum.</strong> Grammar checkers, translation tools and outlining help all leave
      traces resembling generation. Where your policy draws the line is a question this tool cannot answer.</li>
    </ul>
  </section>
</main>
</body>
</html>`;
}

function documentCard(doc) {
  if (doc.error) {
    return `<section class="card">
      <h2>${esc(doc.name)}</h2>
      <p class="err">Could not be read: ${esc(doc.error)}</p>
    </section>`;
  }

  const band = doc.scored.band;
  const { direct, supporting, inference } = doc.scored.groups;

  return `<section class="card">
    <div class="doc-head">
      <h2>${esc(doc.name)}</h2>
      <span class="band band-${band.key}">${esc(band.label)}</span>
    </div>
    <p class="blurb">${esc(band.blurb)}</p>
    <p class="action"><strong>What to do:</strong> ${esc(band.action)}</p>

    <p class="meta-line">${summaryParts(doc).map(esc).join(' · ')}</p>

    ${group('Evidence', 'Facts about the file, not inferences from it.', direct)}
    ${group('Document history and structure', 'Circumstantial, but independent of how the student writes.', supporting)}
    ${group('Writing style', 'The weak, biased signals. Read the caution above before weighing these.', inference)}

    ${!direct.length && !supporting.length && !inference.length ? '<p class="clean">Nothing flagged.</p>' : ''}
    ${doc.styleNote ? `<p class="hint">${esc(doc.styleNote)}</p>` : ''}

    ${annotationsSection(doc)}

    ${doc.facts?.length ? `<details><summary>File details</summary><ul class="facts">${
      doc.facts.map((f) => `<li>${esc(f)}</li>`).join('')
    }</ul></details>` : ''}

    ${doc.metrics?.words ? `<details><summary>Measurements</summary>${metricsTable(doc.metrics)}</details>` : ''}
  </section>`;
}

/**
 * The marked-up document and its suggestions.
 *
 * Open by default rather than folded away: locating the flagged strings is
 * most of the value, and a reader who has to go looking for that will not.
 */
function annotationsSection(doc) {
  if (!doc.annotations?.length || !doc.text?.trim()) return '';

  const withFix = doc.annotations.filter((a) => a.suggestion).length;

  return `<div class="group">
    <h3>Where it is, and what to say instead</h3>
    <p class="hint">${esc(count(doc.annotations.length, 'flagged string'))} marked in place${
      withFix ? `, ${withFix} with a suggested rewrite` : ''
    }. Paragraph numbers in the margin match the ones quoted above. The suggestions are plain-English
    alternatives you can paste into feedback — most of what gets flagged is padding, which is worth
    cutting whoever wrote it.</p>
    <div class="annotated">${annotatedHtml(doc.text, doc.annotations)}</div>
    ${noteList(doc.annotations)}
  </div>`;
}

function group(title, hint, findings) {
  if (!findings.length) return '';
  return `<div class="group">
    <h3>${esc(title)}</h3>
    <p class="hint">${esc(hint)}</p>
    ${findings.map((f) => findingHtml(f)).join('\n')}
  </div>`;
}

function findingHtml(f) {
  return `<div class="finding sev-${esc(f.severity)}">
    <div class="f-title"><span class="pill">${esc(SEVERITY_LABEL[f.severity] ?? f.severity)}</span> ${esc(f.title)}</div>
    <p class="f-detail">${esc(f.detail)}</p>
    ${f.reference ? `<p class="f-ref">${esc(f.reference)}</p>` : ''}
    ${f.context ? `<pre class="quote">${esc(f.context)}</pre><p class="hint">· marks an invisible character</p>` : ''}
    ${(f.quotes ?? []).map((q) => `<pre class="quote">${esc(q)}</pre>`).join('')}
    ${f.documents ? `<p class="f-ref">${f.documents.map((d) => `<code>${esc(d)}</code>`).join(' ')}</p>` : ''}
  </div>`;
}

function metricsTable(metrics) {
  const rows = Object.entries(metrics)
    .filter(([, v]) => v != null && typeof v !== 'object')
    .map(([k, v]) => `<tr><td>${esc(label(k))}</td><td>${esc(typeof v === 'number' ? String(Number(v.toFixed(3))) : String(v))}</td></tr>`);
  return `<table class="metrics">${rows.join('')}</table>`;
}

function overlapTable(pairs) {
  const top = pairs.slice(0, 12);
  if (!top.length) return '';
  return `<section class="card">
    <h2>Overlap between submissions</h2>
    <p class="hint">Shared five-word sequences. Essays answering one prompt always share some phrasing, so read these
    as a ranking within this batch rather than against an absolute threshold.</p>
    <table class="metrics wide">
      <tr><th>Pair</th><th>Containment</th><th>Overlap</th></tr>
      ${top.map((p) => `<tr>
        <td>${esc(p.a)} ↔ ${esc(p.b)}</td>
        <td>${Math.round(p.containment * 100)}%</td>
        <td>${Math.round(p.jaccard * 100)}%</td>
      </tr>`).join('')}
    </table>
  </section>`;
}

function label(key) {
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, (m) => m.toUpperCase());
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

const CSS = `
:root{
  --bg:#fbfaf8; --panel:#fff; --ink:#1b1a18; --muted:#6a6660; --line:#e5e1da;
  --red:#a3261d; --red-bg:#fdf2f0; --amber:#8a5a00; --amber-bg:#fdf7ea;
  --blue:#28536b; --blue-bg:#eef4f7; --green:#2c6042; --green-bg:#eef6f0;
}
@media (prefers-color-scheme:dark){
  :root:not([data-theme=light]){
    --bg:#16151a; --panel:#1e1d23; --ink:#eceaf0; --muted:#9c98a6; --line:#33313b;
    --red:#f0928a; --red-bg:#2c1c1c; --amber:#e5b45f; --amber-bg:#2a2317;
    --blue:#8fc0d8; --blue-bg:#182428; --green:#8fcaa4; --green-bg:#17251c;
  }
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
  font:15px/1.65 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:900px;margin:0 auto;padding:2.5rem 1.25rem 5rem}
h1{font-size:1.7rem;margin:0 0 .25rem;letter-spacing:-.02em}
h2{font-size:1.15rem;margin:0 0 .5rem;letter-spacing:-.01em}
h3{font-size:.95rem;margin:1.5rem 0 .15rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.head{margin-bottom:1.5rem}
.sub{color:var(--muted);margin:0;font-size:.9rem}
.card,.callout{background:var(--panel);border:1px solid var(--line);border-radius:12px;
  padding:1.4rem 1.5rem;margin-bottom:1.25rem}
.callout{border-left:3px solid var(--amber);background:var(--amber-bg)}
.callout p{margin:.6rem 0 0;font-size:.9rem}
.doc-head{display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap}
.band{font-size:.72rem;font-weight:650;text-transform:uppercase;letter-spacing:.07em;
  padding:.3rem .6rem;border-radius:99px;white-space:nowrap}
.band-direct,.band-strong{background:var(--red-bg);color:var(--red)}
.band-moderate{background:var(--amber-bg);color:var(--amber)}
.band-low{background:var(--green-bg);color:var(--green)}
.blurb{margin:.6rem 0 .3rem}
.action{margin:.2rem 0 .8rem;font-size:.9rem}
.meta-line,.hint{color:var(--muted);font-size:.82rem;margin:.2rem 0 .6rem}
.clean{color:var(--green);font-weight:600}
.err{color:var(--red)}
.finding{border-left:2px solid var(--line);padding:.1rem 0 .1rem .9rem;margin:.9rem 0}
.finding.sev-critical,.finding.sev-high{border-left-color:var(--red)}
.finding.sev-medium{border-left-color:var(--amber)}
.finding.sev-low{border-left-color:var(--blue)}
.finding.sev-none{border-left-color:var(--green)}
.f-title{font-weight:600;margin-bottom:.25rem}
.f-detail{margin:.2rem 0;font-size:.88rem;color:var(--ink)}
.f-ref{margin:.2rem 0;font-size:.8rem;color:var(--muted)}
.pill{font-size:.66rem;text-transform:uppercase;letter-spacing:.06em;font-weight:700;
  padding:.12rem .4rem;border-radius:4px;background:var(--line);color:var(--muted);vertical-align:2px;margin-right:.3rem}
.sev-critical .pill,.sev-high .pill{background:var(--red-bg);color:var(--red)}
.sev-medium .pill{background:var(--amber-bg);color:var(--amber)}
.sev-none .pill{background:var(--green-bg);color:var(--green)}
.quote{background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:.5rem .7rem;
  font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;
  overflow-x:auto;margin:.4rem 0}
details{margin-top:.9rem;font-size:.85rem}
summary{cursor:pointer;color:var(--muted);font-weight:600}
.facts{margin:.5rem 0;padding-left:1.1rem;color:var(--muted)}
.metrics{border-collapse:collapse;margin:.6rem 0;font-size:.82rem;width:100%}
.metrics td,.metrics th{border-bottom:1px solid var(--line);padding:.3rem .5rem;text-align:left}
.metrics td:last-child{text-align:right;font-variant-numeric:tabular-nums;color:var(--muted)}
.metrics.wide td:last-child,.metrics.wide th:last-child{text-align:right}
.limits ul{padding-left:1.1rem;font-size:.88rem}
.limits li{margin:.5rem 0}
code{font:12.5px ui-monospace,Menlo,monospace;background:var(--bg);padding:.1rem .3rem;border-radius:4px}
@media print{body{background:#fff}.card,.callout{break-inside:avoid;border-color:#ccc}}
`;
