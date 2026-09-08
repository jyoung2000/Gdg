/**
 * Choosing between a plain HTTP fetch and a headless browser.
 *
 * Meridian has had both for a long time and no way to choose between them.
 * `engine: 'auto'` resolved to `['chromium']` — the heaviest option — and the
 * only real arbitration was a sentence in the browser agent's system prompt
 * telling the model to "prefer the browse tool". The research engine went
 * further and always launched a browser, then polled four times at 750ms
 * hoping content would appear, on pages that were fully server-rendered and
 * would have answered a single GET immediately.
 *
 * ## The decision is made from the response, not the URL
 *
 * You cannot tell from a URL whether a page needs JavaScript. Domain
 * allow-lists of "SPA sites" go stale, and heuristics on the path are guesses.
 * What you *can* do is fetch it cheaply and look at what came back: a page with
 * real text in it is done, and a page that is an empty shell waiting for a
 * bundle is not. That costs one HTTP request to find out, against the several
 * seconds and hundred-odd megabytes a browser launch costs to assume.
 *
 * A wrong answer in either direction is recoverable and cheap: an unnecessary
 * escalation costs a browser launch, and a missed one cannot happen, because
 * the shell test is what triggers it.
 */

/** Below this much extracted text, a page has not really said anything. */
export const MIN_USEFUL_TEXT_CHARS = 200;

export interface HttpFetchResult {
  status: number;
  contentType: string;
  body: string;
  finalUrl: string;
}

/** Why a page was, or was not, handled without a browser. */
export interface NegotiationVerdict {
  /** 'http' when the cheap path answered; 'browser' when it must escalate. */
  transport: 'http' | 'browser';
  reason: string;
  /** Text extracted from the HTTP response, when that path was enough. */
  text: string;
}

/**
 * Markers of a page whose body is assembled by JavaScript.
 *
 * Deliberately structural rather than framework-specific: an empty mount point
 * plus a script tag is the shape every client-rendered app has, whatever
 * library made it, and a list of framework names would need maintaining and
 * would still miss the next one.
 */
const EMPTY_MOUNT = /<(div|main|body)[^>]*\bid=["'](root|app|__next|___gatsby)["'][^>]*>\s*<\/\1>/i;
const NOSCRIPT_WARNING = /<noscript>[^<]*(enable\s+javascript|javascript\s+(is\s+)?required)/i;

/**
 * Strip tags to comparable text.
 *
 * Script and style contents go first, because a JS-shell page is mostly script
 * and counting it as text would make every shell look content-rich — exactly
 * the case this has to detect.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<template\b[^>]*>[\s\S]*?<\/template>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Decide whether an HTTP response is enough, or a browser is needed.
 *
 * Non-HTML that arrived successfully is always enough: JSON, plain text and
 * XML have nothing a browser would add, and rendering them is pure cost.
 */
export function negotiate(result: HttpFetchResult | null): NegotiationVerdict {
  if (!result) {
    return { transport: 'browser', reason: 'the HTTP fetch did not return anything', text: '' };
  }
  if (result.status >= 400) {
    // A browser may still get a page here: some sites serve a 403 to a plain
    // client and a real page to a browser.
    return { transport: 'browser', reason: `HTTP ${result.status} on the cheap path`, text: '' };
  }

  const type = result.contentType.toLowerCase();
  const isHtml = type.includes('html') || type === '';
  if (!isHtml) {
    return { transport: 'http', reason: `${result.contentType || 'non-HTML'} needs no rendering`, text: result.body };
  }

  if (EMPTY_MOUNT.test(result.body)) {
    return { transport: 'browser', reason: 'the page is an empty mount point waiting for JavaScript', text: '' };
  }
  if (NOSCRIPT_WARNING.test(result.body)) {
    return { transport: 'browser', reason: 'the page says it requires JavaScript', text: '' };
  }

  const text = htmlToText(result.body);
  if (text.length < MIN_USEFUL_TEXT_CHARS) {
    return {
      transport: 'browser',
      reason: `only ${text.length} characters of text without rendering`,
      text: '',
    };
  }

  return { transport: 'http', reason: `${text.length} characters of server-rendered text`, text };
}
