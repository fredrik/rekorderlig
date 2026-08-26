/**
 * Feature extraction: a story becomes a sparse map of `feature name -> weight`.
 *
 * Everything is a readable string ("w:rust", "dom:github.com") rather than a hash
 * bucket, so the trained weights can be shown back to the user as "you like X".
 */

// Words that carry no taste signal. Deliberately short: on titles, most words matter.
const STOP = new Set([
  'a', 'an', 'the', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'is', 'are', 'was',
  'be', 'by', 'it', 'its', 'as', 'at', 'from', 'that', 'this', 'with', 'you', 'your',
  // "I" is a pronoun, not a topic: 112 titles in a 3.3k corpus, none of them
  // about the same thing. The shape it signals — "Show HN: I built…" — is
  // already carried by `t:narrative` and `t:showhn`.
  'i',
]);

const SUFFIXES = ['ing', 'ers', 'er', 'ed', 'es', 's'];

/** Light stemmer: collapses plurals/gerunds so "compiler"/"compilers" share a weight. */
export function stem(word) {
  if (word.length <= 4) return word;
  for (const suf of SUFFIXES) {
    if (word.length - suf.length >= 4 && word.endsWith(suf)) return word.slice(0, -suf.length);
  }
  return word;
}

export function tokenize(title) {
  return String(title)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // combining diacritics left over from NFKD
    // Apostrophes vanish rather than split: “isn't” -> “isnt”, “musk's” -> “musks”
    // (then stemmed to “musk”), instead of shedding junk “t”/“s” tokens.
    .replace(/[’‘'`]/g, '')
    // `&` and `/` survive *inside* a word (they are trimmed off the ends
    // below), because as separators they shred things that mean something:
    // "S&P 500" became "s" + "p" + "500", and "278 tok/s" left a bare "s"
    // behind — which is exactly the junk signal that showed up as a learned
    // term. AT&T, R&D, M&A and km/h have the same shape.
    .replace(/[^a-z0-9+#.\-&/\s]/g, ' ')
    // keep "c++", "c#", "asp.net", "gpt-4", "s&p", "tok/s". Punctuation on the
    // ends goes, so a bare ".net" arrives as "net" — inside a word it stays.
    .split(/\s+/)
    .map((t) => t.replace(/^[.\-&/]+|[.\-&/]+$/g, ''))
    .filter((t) => t.length > 0 && t.length < 30);
}

export function domainOf(url) {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return host || null;
  } catch {
    return null;
  }
}

/** github.com -> ["dom:github.com"]; blog.acme.co.uk -> also "dom:acme.co.uk" */
function domainFeatures(domain, add) {
  if (!domain) return;
  add(`dom:${domain}`, 1);
  const parts = domain.split('.');
  if (parts.length > 2) {
    const registrable = parts.slice(-(parts.length > 3 ? 3 : 2)).join('.');
    if (registrable !== domain) add(`dom:${registrable}`, 0.5);
  }
  const tld = parts.at(-1);
  if (tld) add(`tld:${tld}`, 0.3);
}

/**
 * @param {{title:string,url?:string|null,domain?:string|null,author?:string|null,
 *          points?:number,num_comments?:number}} story
 * @returns {Map<string, number>}
 */
export function featurize(story) {
  const f = new Map();
  const add = (name, weight = 1) => f.set(name, (f.get(name) ?? 0) + weight);

  add('__bias__', 1);

  const raw = tokenize(story.title ?? '');
  const words = raw.filter((w) => !STOP.has(w)).map(stem);

  for (const w of words) {
    add(`w:${w}`, 1);
    // "llm-assisted" also votes for "llm" and "assist", so related titles share signal.
    if (w.includes('-') || w.includes('.')) {
      for (const part of w.split(/[-.]/)) {
        if (part.length > 1 && part !== w && !STOP.has(part)) add(`w:${stem(part)}`, 0.5);
      }
    }
  }
  for (let i = 0; i < words.length - 1; i++) add(`b:${words[i]}_${words[i + 1]}`, 0.7);

  // Shape of the title, independent of vocabulary. Deliberately weak: these fire
  // on almost every story, so at full strength they drown out the actual topic.
  const title = String(story.title ?? '');
  const style = 0.6;
  if (/\?\s*$/.test(title)) add('t:question', style);
  if (/^show hn/i.test(title)) add('t:showhn', style);
  if (/^ask hn/i.test(title)) add('t:askhn', style);
  if (/^tell hn/i.test(title)) add('t:tellhn', style);
  if (/\b(19|20)\d{2}\b/.test(title)) add('t:has_year', style);
  if (/\d/.test(title)) add('t:has_number', style);
  if (/^(how|why|what|when|the case for|i )/i.test(title)) add('t:narrative', style);
  // Title length correlates with taste far less than it appears to at 20 votes.
  add(`t:len${Math.min(6, Math.floor(raw.length / 3))}`, 0.3);

  const domain = story.domain ?? domainOf(story.url);
  domainFeatures(domain, add);
  if (!domain) add('t:selfpost', 1);

  if (story.author) add(`by:${String(story.author).toLowerCase()}`, 0.6);

  return f;
}

/** Human-readable label for a feature name, for the "what it learned" panel. */
export function describeFeature(name) {
  const [kind, ...rest] = name.split(':');
  const body = rest.join(':');
  switch (kind) {
    case '__bias__': return { kind: 'baseline', label: 'baseline' };
    case 'w': return { kind: 'word', label: body };
    case 'b': return { kind: 'phrase', label: body.replace(/_/g, ' ') };
    case 'dom': return { kind: 'site', label: body };
    case 'tld': return { kind: 'site', label: `.${body}` };
    case 'by': return { kind: 'author', label: `@${body}` };
    case 't': return { kind: 'style', label: STYLE_LABELS[body] ?? body };
    default: return { kind, label: body || name };
  }
}

const STYLE_LABELS = {
  question: 'titles that ask a question',
  showhn: 'Show HN posts',
  askhn: 'Ask HN posts',
  tellhn: 'Tell HN posts',
  has_year: 'titles containing a year',
  has_number: 'titles containing a number',
  narrative: 'first-person / explainer titles',
  selfpost: 'text posts (no link)',
  len0: 'very short titles',
  len1: 'short titles',
  len2: 'medium titles',
  len3: 'longer titles',
  len4: 'long titles',
  len5: 'very long titles',
  len6: 'extremely long titles',
};
