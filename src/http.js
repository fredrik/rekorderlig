/**
 * The one JSON fetch helper, shared by the two Hacker News sources
 * (`hn.js` over Algolia's search index, `firebase.js` over the official item
 * API). Extracted so the second source does not fork a copy of the retry rule.
 *
 * Retries only what is worth retrying: 429 and 5xx are the remote having a bad
 * moment, while a 4xx is the request itself being wrong and will not improve by
 * being asked again.
 */
const UA = 'rekorderlig/1.0 (personal HN recommender)';

export async function getJson(url, { retries = 3 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30_000) });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { fatal: true });
      return await res.json();
    } catch (err) {
      lastError = err;
      if (err.fatal || attempt === retries) break;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw lastError;
}
