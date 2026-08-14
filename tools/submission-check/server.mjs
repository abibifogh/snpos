import { createServer } from 'node:http';
import { analyseBatch } from './src/analyze.mjs';
import { htmlReport } from './src/report/html.mjs';

/**
 * The upload interface.
 *
 * Bound to localhost and nothing else, on purpose. Coursework is other
 * people's work, held under whatever data policy the institution has, and the
 * moment a marking tool becomes a URL that accepts uploads it is a place
 * student work accumulates. Everything here happens in memory on the marker's
 * own machine: nothing is written to disk, nothing leaves the process, and
 * closing it takes the files with it.
 *
 * The one exception is --verify-citations, which asks Crossref about reference
 * titles. It is off unless the box is ticked, and the page says what it sends.
 */

const MAX_FILE = 40 * 1024 * 1024;
const MAX_TOTAL = 200 * 1024 * 1024;

export function serve(port = 4321, host = '127.0.0.1') {
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
        return send(res, 200, 'text/html; charset=utf-8', PAGE);
      }
      if (req.method === 'POST' && req.url === '/analyse') {
        return await handleAnalyse(req, res);
      }
      send(res, 404, 'text/plain', 'Not found');
    } catch (err) {
      send(res, 500, 'text/plain', `Something went wrong: ${err.message}`);
    }
  });

  server.listen(port, host, () => {
    process.stdout.write(`\n  Submission check is running at http://${host}:${port}\n`);
    process.stdout.write('  Files are analysed in memory on this machine and never written to disk.\n');
    process.stdout.write('  Ctrl-C to stop.\n\n');
  });

  return server;
}

async function handleAnalyse(req, res) {
  const contentType = req.headers['content-type'] ?? '';
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!boundary) return send(res, 400, 'text/plain', 'Expected a multipart form upload.');

  const body = await readBody(req, MAX_TOTAL);
  if (!body) return send(res, 413, 'text/plain', 'Upload too large.');

  const parts = parseMultipart(body, boundary[1] ?? boundary[2]);
  const files = parts.filter((p) => p.filename && p.data.length);
  const fields = Object.fromEntries(parts.filter((p) => !p.filename).map((p) => [p.name, p.data.toString('utf8')]));

  if (!files.length) return send(res, 400, 'text/html', errorPage('No files were received. Try choosing them again.'));

  const oversized = files.filter((f) => f.data.length > MAX_FILE);
  if (oversized.length) {
    return send(res, 413, 'text/html', errorPage(`Too large: ${oversized.map((f) => f.filename).join(', ')}`));
  }

  const result = await analyseBatch(
    files.map((f) => ({ buffer: f.data, name: f.filename })),
    { verifyCitations: fields.verifyCitations === 'on', contactEmail: fields.email || null },
  );

  send(res, 200, 'text/html; charset=utf-8', htmlReport(result, { title: `${files.length} files` }));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { req.destroy(); resolve(null); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Parse multipart/form-data.
 *
 * Written against Buffers rather than strings throughout: a .docx is a ZIP,
 * and decoding it to UTF-8 to find the boundaries would corrupt every byte
 * above 0x7f before the file ever reached the reader.
 */
function parseMultipart(body, boundary) {
  const delimiter = Buffer.from(`--${boundary}`);
  const parts = [];
  let index = body.indexOf(delimiter);
  if (index < 0) return parts;

  index += delimiter.length;

  while (index < body.length) {
    if (body[index] === 0x2d && body[index + 1] === 0x2d) break; // closing "--"
    if (body[index] === 0x0d) index += 2; // CRLF after the boundary

    const headerEnd = body.indexOf('\r\n\r\n', index);
    if (headerEnd < 0) break;

    const headers = body.toString('latin1', index, headerEnd);
    const next = body.indexOf(delimiter, headerEnd);
    const end = next < 0 ? body.length : next - 2; // trim the CRLF before the boundary

    const disposition = /content-disposition:[^\n]*/i.exec(headers)?.[0] ?? '';
    const name = /\bname="([^"]*)"/i.exec(disposition)?.[1] ?? '';
    const filenameRaw = /\bfilename="([^"]*)"/i.exec(disposition)?.[1];

    parts.push({
      name,
      // Browsers send the filename in UTF-8; reading the headers as latin1 kept
      // the bytes intact, so decode it back here for names with accents.
      filename: filenameRaw ? Buffer.from(filenameRaw, 'latin1').toString('utf8').replace(/^.*[\\/]/, '') : null,
      data: body.subarray(headerEnd + 4, Math.max(headerEnd + 4, end)),
    });

    if (next < 0) break;
    index = next + delimiter.length;
  }

  return parts;
}

function send(res, status, type, body) {
  res.writeHead(status, {
    'content-type': type,
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:",
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function errorPage(message) {
  return `<!doctype html><meta charset="utf-8"><title>Problem</title>
  <body style="font:15px system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem">
  <h1 style="font-size:1.2rem">That didn't work</h1><p>${message.replace(/[<>&]/g, '')}</p>
  <p><a href="/">Back</a></p>`;
}

const PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Submission check</title>
<style>
:root{--bg:#fbfaf8;--panel:#fff;--ink:#1b1a18;--muted:#6a6660;--line:#e5e1da;--accent:#28536b;--amber:#8a5a00;--amber-bg:#fdf7ea}
@media (prefers-color-scheme:dark){:root{--bg:#16151a;--panel:#1e1d23;--ink:#eceaf0;--muted:#9c98a6;--line:#33313b;--accent:#8fc0d8;--amber:#e5b45f;--amber-bg:#2a2317}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.65 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:640px;margin:0 auto;padding:3rem 1.25rem 4rem}
h1{font-size:1.6rem;margin:0 0 .3rem;letter-spacing:-.02em}
.sub{color:var(--muted);margin:0 0 1.75rem;font-size:.92rem}
form{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:1.5rem}
#drop{border:2px dashed var(--line);border-radius:10px;padding:2.75rem 1rem;text-align:center;
  cursor:pointer;transition:border-color .15s,background .15s}
#drop.over{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 8%,transparent)}
#drop strong{display:block;font-size:1.02rem;margin-bottom:.3rem}
#drop span{color:var(--muted);font-size:.85rem}
input[type=file]{display:none}
#list{margin:1rem 0 0;padding:0;list-style:none;font-size:.86rem;color:var(--muted)}
#list li{padding:.3rem 0;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;gap:1rem}
#list li span{font-variant-numeric:tabular-nums;white-space:nowrap}
.opt{margin-top:1.25rem;font-size:.86rem;display:flex;gap:.55rem;align-items:flex-start}
.opt label{color:var(--muted)}
button{margin-top:1.4rem;width:100%;padding:.8rem;border:0;border-radius:8px;background:var(--accent);
  color:var(--bg);font:inherit;font-weight:650;cursor:pointer}
button:disabled{opacity:.45;cursor:not-allowed}
.note{background:var(--amber-bg);border-left:3px solid var(--amber);border-radius:8px;
  padding:.9rem 1.1rem;margin-top:1.5rem;font-size:.85rem}
.note p{margin:.4rem 0}
.privacy{color:var(--muted);font-size:.8rem;margin-top:1.5rem;text-align:center}
</style></head>
<body><main>
<h1>Submission check</h1>
<p class="sub">Word, Excel, PDF, OpenDocument, RTF or plain text. Upload the whole batch at once, so overlap between
submissions can be compared.</p>

<form method="post" action="/analyse" enctype="multipart/form-data" id="form">
  <div id="drop">
    <strong>Drop files here</strong>
    <span>or click to choose &mdash; .docx .xlsx .pdf .odt .rtf .txt</span>
    <input type="file" name="files" id="files" multiple
      accept=".docx,.xlsx,.xlsm,.pdf,.odt,.ods,.rtf,.txt,.md">
  </div>
  <ul id="list"></ul>

  <div class="opt">
    <input type="checkbox" name="verifyCitations" id="vc">
    <label for="vc"><strong>Check references against Crossref.</strong> Sends reference titles and DOIs to
    crossref.org to see whether the works exist. Nothing else leaves this machine. Off by default.</label>
  </div>

  <button type="submit" id="go" disabled>Check submissions</button>
</form>

<div class="note">
  <p><strong>What this can and cannot tell you.</strong> It finds hidden characters, editing history, references that
  do not resolve, and overlap between submissions. Those are facts about the files.</p>
  <p>It also reports writing-style statistics, which are weak and biased: detectors built on them flag second-language
  writers far more often than native speakers. Nothing here proves authorship. Use it to decide which submissions
  deserve a conversation.</p>
</div>

<p class="privacy">Running locally. Files are analysed in memory and never written to disk.</p>
</main>
<script>
const drop = document.getElementById('drop');
const input = document.getElementById('files');
const list = document.getElementById('list');
const go = document.getElementById('go');

drop.addEventListener('click', () => input.click());
['dragenter','dragover'].forEach(e => drop.addEventListener(e, ev => {
  ev.preventDefault(); drop.classList.add('over');
}));
['dragleave','drop'].forEach(e => drop.addEventListener(e, ev => {
  ev.preventDefault(); drop.classList.remove('over');
}));
drop.addEventListener('drop', ev => { input.files = ev.dataTransfer.files; render(); });
input.addEventListener('change', render);

function render() {
  list.innerHTML = '';
  for (const f of input.files) {
    const li = document.createElement('li');
    li.append(f.name);
    const size = document.createElement('span');
    size.textContent = (f.size / 1024).toFixed(0) + ' KB';
    li.append(size);
    list.append(li);
  }
  go.disabled = input.files.length === 0;
}

document.getElementById('form').addEventListener('submit', () => {
  go.disabled = true;
  go.textContent = 'Reading ' + input.files.length + ' file' + (input.files.length === 1 ? '' : 's') + '…';
});
</script>
</body></html>`;
