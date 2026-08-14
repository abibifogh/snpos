#!/usr/bin/env node
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import { analyseBatch } from './src/analyze.mjs';
import { textReport } from './src/report/text.mjs';
import { htmlReport } from './src/report/html.mjs';

/**
 * Command line entry point.
 *
 * Point it at a folder of submissions; that is the shape of the job. Marking is
 * batch work, and the cross-document comparison, which is the most useful part
 * of this tool, only exists when there is a batch to compare.
 */

const SUPPORTED = new Set(['.docx', '.xlsx', '.xlsm', '.pdf', '.odt', '.ods', '.rtf', '.txt', '.md']);

const USAGE = `
submission-check — examine documents for signs of generated text, hidden content and overlap

  node tools/submission-check/cli.mjs <file|folder>... [options]

Options
  --html <path>          write a standalone HTML report
  --json <path>          write the full findings as JSON
  --verify-citations     look references up against Crossref (sends titles to crossref.org)
  --email <addr>         contact address for the Crossref polite pool
  --all                  list every flagged string, not just the first 15 per file
  --metrics              include the raw measurements in terminal output
  --quiet                findings only, no per-file details
  --serve [port]         start the upload interface instead (default port 4321)
  -h, --help             this

Examples
  node tools/submission-check/cli.mjs ./submissions --html report.html
  node tools/submission-check/cli.mjs essay.docx --verify-citations --email me@uni.edu
  node tools/submission-check/cli.mjs --serve
`;

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('-h') || argv.includes('--help') || argv.length === 0) {
    process.stdout.write(USAGE);
    return;
  }

  if (argv.includes('--serve')) {
    const port = Number(argv[argv.indexOf('--serve') + 1]) || Number(process.env.PORT) || 4321;
    const { serve } = await import('./server.mjs');
    serve(port);
    return;
  }

  const opts = {
    html: flagValue(argv, '--html'),
    json: flagValue(argv, '--json'),
    verifyCitations: argv.includes('--verify-citations'),
    contactEmail: flagValue(argv, '--email'),
    metrics: argv.includes('--metrics'),
    verbose: !argv.includes('--quiet'),
    allAnnotations: argv.includes('--all'),
  };

  const targets = argv.filter((a, i) => !a.startsWith('--') && !isFlagValue(argv, i));
  const paths = (await Promise.all(targets.map(collect))).flat();

  if (!paths.length) {
    process.stderr.write(`No supported files found. Supported: ${[...SUPPORTED].join(', ')}\n`);
    process.exitCode = 1;
    return;
  }

  const inputs = [];
  for (const path of paths) {
    inputs.push({ buffer: await readFile(path), name: basename(path) });
  }

  const result = await analyseBatch(inputs, {
    ...opts,
    onProgress: (done, total, name) => {
      if (process.stderr.isTTY) process.stderr.write(`\r  reading ${done}/${total}  ${name.slice(0, 50)}\x1b[K`);
    },
  });
  if (process.stderr.isTTY) process.stderr.write('\r\x1b[K');

  process.stdout.write(`${textReport(result, opts)}\n`);

  if (opts.html) {
    await writeFile(opts.html, htmlReport(result, { title: targets.join(', ') }));
    process.stdout.write(`HTML report written to ${opts.html}\n`);
  }
  if (opts.json) {
    // The extracted text is dropped: it is the student's work, it makes the
    // file enormous, and a findings archive should not quietly become a copy
    // of everyone's coursework.
    await writeFile(opts.json, JSON.stringify(result, (k, v) => (k === 'text' ? undefined : v), 2));
    process.stdout.write(`JSON written to ${opts.json}\n`);
  }

  // A non-zero exit when something needs a human, so this can sit in a script.
  if (result.documents.some((d) => ['direct', 'strong'].includes(d.scored?.band?.key))) process.exitCode = 2;
}

async function collect(path) {
  const info = await stat(path).catch(() => null);
  if (!info) {
    process.stderr.write(`Skipping ${path}: not found\n`);
    return [];
  }
  if (info.isFile()) return SUPPORTED.has(extname(path).toLowerCase()) ? [path] : [];

  const entries = await readdir(path, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name.startsWith('~$')) continue; // Word lock files
    out.push(...await collect(join(path, e.name)));
  }
  return out.sort();
}

function flagValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
}

function isFlagValue(argv, index) {
  const prev = argv[index - 1];
  return ['--html', '--json', '--email', '--serve'].includes(prev);
}

main().catch((err) => {
  process.stderr.write(`${err.stack ?? err.message}\n`);
  process.exitCode = 1;
});
