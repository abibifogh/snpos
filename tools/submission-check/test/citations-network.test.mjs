import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { verifyCitations } from '../src/analyze/citations.mjs';

/**
 * The Crossref pass, exercised against a stub that speaks the real API's shape.
 *
 * A live call would make these tests depend on someone else's uptime, on being
 * outside a firewall, and on a rate limit; the stub keeps the failure modes
 * that matter, a 404 for a fabricated DOI and a refused connection, under test.
 */
function stubCrossref(handler) {
  const server = createServer((req, res) => {
    const body = handler(new URL(req.url, 'http://localhost'));
    if (!body) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

const work = (title, year) => ({ title: [title], issued: { 'date-parts': [[year]] } });

test('a DOI that does not resolve is reported as not found', async () => {
  const { server, base } = await stubCrossref((url) => (
    url.pathname.includes('10.1016') ? { message: work('GPT detectors are biased against non-native English writers', 2023) } : null
  ));

  try {
    const { results, findings } = await verifyCitations([
      { raw: 'Liang, W. (2023). GPT detectors are biased…', doi: '10.1016/j.patter.2023.100779', title: 'GPT detectors are biased against non-native English writers', year: 2023 },
      { raw: 'Adjei, P. (2019). A completely invented paper.', doi: '10.9999/notarealjournal.2019.001', title: 'A completely invented paper', year: 2019 },
    ], { apiBase: base });

    assert.equal(results[0].status, 'found');
    assert.equal(results[1].status, 'not-found');
    assert.equal(findings.find((f) => f.id === 'cite.not-found').severity, 'high');
  } finally { server.close(); }
});

test('a real work under a different title is a weak match, not a clean pass', async () => {
  const { server, base } = await stubCrossref(() => ({ message: { items: [work('Attention is all you need', 2017)] } }));

  try {
    const { results, findings } = await verifyCitations([
      { raw: 'Vaswani, A. (2017). Neural machine translation by joint alignment.', title: 'Neural machine translation by joint alignment of everything', year: 2017 },
    ], { apiBase: base });

    assert.equal(results[0].status, 'weak-match');
    assert.ok(findings.some((f) => f.id === 'cite.weak-match'));
  } finally { server.close(); }
});

test('a year that disagrees with the record is flagged', async () => {
  const { server, base } = await stubCrossref(() => ({ message: work('Trade and growth in West Africa', 2014) }));

  try {
    const { findings } = await verifyCitations([
      { raw: 'Mensah, K. (2019). Trade and growth in West Africa.', doi: '10.1234/abcd', title: 'Trade and growth in West Africa', year: 2019 },
    ], { apiBase: base });

    const f = findings.find((x) => x.id === 'cite.year-mismatch');
    assert.match(f.title, /cited as 2019, published 2014/);
  } finally { server.close(); }
});

test('an unreachable Crossref is reported, never mistaken for a clean result', async () => {
  // Port 1 on loopback refuses immediately, standing in for a firewall or outage.
  const { results, findings } = await verifyCitations([
    { raw: 'Somebody, A. (2020). A title.', doi: '10.1234/x', title: 'A title', year: 2020 },
  ], { apiBase: 'http://127.0.0.1:1', timeoutMs: 2000 });

  assert.equal(results[0].status, 'lookup-failed');

  const f = findings.find((x) => x.id === 'cite.lookup-failed');
  assert.ok(f, 'a failed lookup must produce a visible finding');
  assert.match(f.title, /NOT checked/);
  assert.ok(!findings.some((x) => x.id === 'cite.not-found'), 'unreachable must never be reported as fabricated');
});
