import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText, negotiate, MIN_USEFUL_TEXT_CHARS } from '@meridian/browser-sdk';

/**
 * Whether a page needs a browser is a question about the response, not the URL.
 *
 * Before this, `engine: 'auto'` resolved to the heaviest backend and the
 * research engine always launched Chromium and then polled four times at 750ms
 * hoping content would appear — on pages that were fully server-rendered and
 * would have answered a single GET immediately.
 */

const article = (words: number): string =>
  `<html><head><title>T</title></head><body><article>${'The retry module maintains its invariants across restarts. '.repeat(words)}</article></body></html>`;

describe('HTML to text', () => {
  it('does not count script contents as page text', () => {
    // A client-rendered page is mostly script. Counting it would make every
    // empty shell look content-rich, which is exactly what has to be detected.
    const shell = `<html><body><div id="root"></div><script>${'var x=1;'.repeat(500)}</script></body></html>`;
    assert.ok(htmlToText(shell).length < 50, `a shell should extract almost nothing, got ${htmlToText(shell).length}`);
  });

  it('extracts the readable text of a server-rendered page', () => {
    const text = htmlToText(article(20));
    assert.ok(text.includes('retry module'));
    assert.ok(text.length > MIN_USEFUL_TEXT_CHARS);
  });
});

describe('Transport negotiation', () => {
  const ok = (body: string, contentType = 'text/html') => ({ status: 200, contentType, body, finalUrl: 'https://x.test/' });

  it('takes the cheap path for a server-rendered page', () => {
    const verdict = negotiate(ok(article(20)));
    assert.equal(verdict.transport, 'http', verdict.reason);
    assert.ok(verdict.text.length > MIN_USEFUL_TEXT_CHARS);
    assert.match(verdict.reason, /server-rendered/);
  });

  it('escalates for an empty mount point', () => {
    const verdict = negotiate(ok('<html><body><div id="root"></div><script src="/app.js"></script></body></html>'));
    assert.equal(verdict.transport, 'browser');
    assert.match(verdict.reason, /mount point/);
  });

  it('escalates when the page says it needs JavaScript', () => {
    const body = `<html><body><noscript>You need to enable JavaScript to run this app.</noscript>${'x '.repeat(300)}</body></html>`;
    const verdict = negotiate(ok(body));
    assert.equal(verdict.transport, 'browser');
    assert.match(verdict.reason, /requires JavaScript/i);
  });

  it('escalates when almost nothing came back', () => {
    const verdict = negotiate(ok('<html><body><p>Loading…</p></body></html>'));
    assert.equal(verdict.transport, 'browser');
    assert.match(verdict.reason, /characters of text/);
  });

  it('never renders JSON, which a browser could not improve', () => {
    const verdict = negotiate(ok('{"a":1}', 'application/json'));
    assert.equal(verdict.transport, 'http');
    assert.equal(verdict.text, '{"a":1}');
  });

  it('escalates on an error status, since some sites serve one only to plain clients', () => {
    const verdict = negotiate({ status: 403, contentType: 'text/html', body: 'no', finalUrl: 'https://x.test/' });
    assert.equal(verdict.transport, 'browser');
    assert.match(verdict.reason, /403/);
  });

  it('escalates when the cheap path returned nothing at all', () => {
    assert.equal(negotiate(null).transport, 'browser');
  });
});
