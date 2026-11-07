// bookLookup.js
// Looks up title and author suggestions from online book catalogues, for the add-a-book form. Called by
// routes/lookup.js. Open Library is the default and needs no account. Google Books is an optional backup that's
// used only when the server has a GOOGLE_BOOKS_API_KEY, and only if Open Library finds nothing or fails.
//
// Lookups run here rather than on the phone so that an API key never ships inside the app, and the catalogues see
// this server's address instead of each family member's. What someone types still reaches the catalogue, which is
// why the app explains this in Settings and lets them turn it off. Search text is never logged.
//
// Only these fixed addresses are ever contacted, and redirects are refused, so nothing a person types can make this
// server connect somewhere else. Answers come from outside, so nothing in them is trusted: each is rebuilt field by field.

const log = require('./logger')('lookup');
const { version } = require('./appMeta');

const MAX_RESULTS = 6;
// How many to ask for. Open Library ranks by popularity, so several may not really match and get filtered out in tidy().
const MAX_ASKED = 30;
const TIMEOUT_MS = 4000;
// Larger than any real answer, so a misbehaving service can't make this server hold a huge reply in memory.
const MAX_ANSWER_BYTES = 1024 * 1024;
const MAX_TEXT = 200;
const CACHE_LIMIT = 500;
const CACHE_MS = 60 * 60 * 1000;
// Open Library allows 1 request a second, or 3 from an application that gives contact details.
const OPEN_LIBRARY_GAP_MS = 1000;
const OPEN_LIBRARY_IDENTIFIED_GAP_MS = 350;

// Recent answers, because Open Library asks callers to cache, and the same words are often looked up twice. A Map
// remembers insertion order, so its first entry is the oldest. Held in memory only, and gone on restart.
const cache = new Map();
// When the next Open Library request may go. Requests wait their turn rather than exceed its limit.
let nextOpenLibraryAt = 0;

/** A catalogue couldn't answer. Its message holds a status only, never a key or search text. */
class LookupError extends Error {}

/**
 * Tidies text from a catalogue. In: any value. Out: trimmed text with control characters removed, or '' if it isn't
 * usable. Long values are dropped, as they wouldn't be a real title or name, and the book form limits them anyway.
 */
function cleanText(value) {
  if (typeof value !== 'string') return '';
  // Control characters: invisible codes such as the terminal escape character.
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  return text.length <= MAX_TEXT ? text : '';
}

/**
 * Fetches JSON from a catalogue.
 * In: the address and any headers. Out: the parsed answer. Throws a LookupError on any failure.
 */
async function fetchJson(url, headers) {
  let res;
  let text;
  try {
    // redirect 'error': a redirect could otherwise lead this server to an address nobody chose.
    res = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
    text = await res.text();
  } catch (err) {
    throw new LookupError(`could not connect (${err.name})`);
  }
  if (!res.ok) throw new LookupError(`answered ${res.status}`);
  if (text.length > MAX_ANSWER_BYTES) throw new LookupError('sent too large an answer');
  try {
    return JSON.parse(text);
  } catch {
    throw new LookupError('sent something other than JSON');
  }
}

/**
 * Waits for Open Library's rate limit, then returns the headers to send. It asks applications to identify themselves.
 * BOOK_LOOKUP_CONTACT is an optional contact address, which earns the higher limit.
 * Out: the headers. Side effects: delays the caller when requests come quickly.
 */
async function openLibraryTurn() {
  const contact = cleanText(process.env.BOOK_LOOKUP_CONTACT);
  const gap = contact ? OPEN_LIBRARY_IDENTIFIED_GAP_MS : OPEN_LIBRARY_GAP_MS;
  const now = Date.now();
  const at = Math.max(now, nextOpenLibraryAt);
  nextOpenLibraryAt = at + gap;
  if (at > now) await new Promise((resolve) => { setTimeout(resolve, at - now); });
  return { 'User-Agent': contact ? `Readeez/${version} (${contact})` : `Readeez/${version}` };
}

/**
 * Splits typed text into plain lower-case words.
 * In: the text. Out: an array of words: letters, digits and apostrophes, in any language.
 * Everything else is dropped, because Open Library's search has its own query language, where characters like ( : * and
 * capitalised words like OR have meaning. This way a title can't change what the search does. Lower case matters
 * for the same reason.
 */
const searchWords = (text) => text.toLowerCase().match(/[\p{L}\p{N}']+/gu) || [];

/**
 * Builds Open Library's search for words still being typed.
 * In: the words. Out: the query. The last word may be unfinished, so it matches either exactly or as the start of a word.
 * Both are needed: "gaim*" finds "Gaiman", but in testing "mary*" alone didn't find "Mary".
 */
function openLibraryQuery(words) {
  const last = words[words.length - 1];
  return [...words.slice(0, -1), `(${last} OR ${last}*)`].join(' ');
}

/**
 * Asks Open Library.
 * In: 'title' or 'author', and the search words. Out: [{ title, authors }] or [{ name }], possibly long or repetitive.
 * URLSearchParams encodes the text, so characters like & can't add parameters to the request.
 */
async function askOpenLibrary(kind, words) {
  const headers = await openLibraryTurn();
  if (kind === 'author') {
    // The key field is requested only because Open Library answers 500 when asked for the name field alone.
    const params = new URLSearchParams({ q: openLibraryQuery(words), limit: String(MAX_ASKED), fields: 'key,name' });
    const data = await fetchJson(`https://openlibrary.org/search/authors.json?${params}`, headers);
    return (Array.isArray(data?.docs) ? data.docs : []).map((doc) => ({ name: doc?.name }));
  }
  const params = new URLSearchParams({ q: `title:(${openLibraryQuery(words)})`, limit: String(MAX_ASKED), fields: 'title,author_name' });
  const data = await fetchJson(`https://openlibrary.org/search.json?${params}`, headers);
  return (Array.isArray(data?.docs) ? data.docs : []).map((doc) => ({ title: doc?.title, authors: doc?.author_name }));
}

/**
 * Asks Google Books. Same contract as askOpenLibrary. The key goes in a header rather than the address, so it can't
 * end up in an error message or a proxy's log.
 */
async function askGoogleBooks(kind, words, key) {
  const params = new URLSearchParams({
    // intitle: and inauthor: are Google's way of searching one field. The words hold nothing with special meaning.
    q: `${kind === 'author' ? 'inauthor' : 'intitle'}:${words.join(' ')}`,
    maxResults: String(MAX_ASKED),
    printType: 'books',
    fields: 'items(volumeInfo(title,authors))',
  });
  const data = await fetchJson(`https://www.googleapis.com/books/v1/volumes?${params}`, { 'x-goog-api-key': key });
  const volumes = (Array.isArray(data?.items) ? data.items : []).map((item) => item?.volumeInfo);
  if (kind !== 'author') return volumes.map((volume) => ({ title: volume?.title, authors: volume?.authors }));
  // Google finds books, so this lists each one's authors. tidy() keeps those whose names match what was typed.
  return volumes.flatMap((volume) => (Array.isArray(volume?.authors) ? volume.authors : [])).map((name) => ({ name }));
}

/**
 * Removes accents and capitals, so "Café" and "cafe" compare as equal.
 * In: text. Out: plain lower-case text.
 */
const foldText = (text) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/**
 * Turns a catalogue's raw answer into the safe, short list the app receives.
 * In: 'title' or 'author', the search words, and the raw results. Out: up to MAX_RESULTS results with repeats removed.
 * Results must contain every typed word, because a catalogue's looser matches ("Treasure Island" for "pira") would
 * only look wrong in a list of suggestions. Titles starting with what was typed come first, so the book itself ranks
 * above "Summary of..." guides to it. Author names with a comma are left out: they're either several people run
 * together ("Gaiman, Neil, Reaves, Michael") or "Surname, First", a duplicate of the same person in normal order.
 */
function tidy(kind, words, raw) {
  const wanted = words.map(foldText);
  const start = wanted.join(' ');
  // sort keeps equal items in their original order, so the catalogue's own ranking stands within each group.
  const startsFirst = (a, b) => Number(foldText(String(b.title ?? '')).startsWith(start)) - Number(foldText(String(a.title ?? '')).startsWith(start));
  const ranked = kind === 'title' ? [...raw].sort(startsFirst) : raw;
  const matches = (text) => {
    const folded = foldText(text);
    return wanted.every((word) => folded.includes(word));
  };
  const seen = new Set();
  const out = [];
  for (const item of ranked) {
    let result;
    let key;
    if (kind === 'author') {
      const name = cleanText(item.name);
      result = name && matches(name) && !name.includes(',') ? { name } : null;
      key = name.toLowerCase();
    } else {
      const title = cleanText(item.title);
      const authors = (Array.isArray(item.authors) ? item.authors : []).map(cleanText).filter(Boolean).slice(0, 5);
      result = title && matches(title) ? { title, authors } : null;
      key = `${title}|${authors.join(',')}`.toLowerCase();
    }
    if (result && !seen.has(key)) {
      seen.add(key);
      out.push(result);
      if (out.length === MAX_RESULTS) break;
    }
  }
  return out;
}

/**
 * Finds suggestions, using the cache when it can.
 * In: 'title' or 'author', and the search text. Out: { results, source }, where source names the catalogue for the
 * credit the app shows. Throws a LookupError if nothing could answer.
 * Side effects: contacts a catalogue, and logs a failure with its status but never the search text.
 */
async function lookup(kind, query) {
  const words = searchWords(query);
  // Typed punctuation alone leaves nothing to search for.
  if (!words.length) return { results: [], source: null };
  const cacheKey = `${kind}:${words.join(' ')}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.answer;

  let answer = null;
  let failure = null;
  try {
    const results = tidy(kind, words, await askOpenLibrary(kind, words));
    if (results.length) answer = { results, source: 'Open Library' };
  } catch (err) {
    if (!(err instanceof LookupError)) throw err;
    failure = err;
    log.warn(`Open Library ${err.message}`);
  }

  const key = process.env.GOOGLE_BOOKS_API_KEY;
  if (!answer && key) {
    try {
      const results = tidy(kind, words, await askGoogleBooks(kind, words, key));
      answer = { results, source: results.length ? 'Google Books' : null };
      failure = null;
    } catch (err) {
      if (!(err instanceof LookupError)) throw err;
      failure = failure || err;
      log.warn(`Google Books ${err.message}`);
    }
  }
  if (!answer && failure) throw failure;
  if (!answer) answer = { results: [], source: null };

  // Forgets the oldest entry when full, so the cache can't grow without limit.
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(cacheKey, { at: Date.now(), answer });
  return answer;
}

/** Empties the cache and the waiting time. Only the tests use this, so each one starts fresh. */
function resetLookupForTests() {
  cache.clear();
  nextOpenLibraryAt = 0;
}

module.exports = { lookup, LookupError, resetLookupForTests };
