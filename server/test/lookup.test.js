// test/lookup.test.js
// Tests for POST /api/lookup, the online title and author suggestions. The catalogues are real outside services, so
// fetch is replaced with a stand-in here. Everything else, including sign-in and rate limiting, runs against real Postgres.

const request = require('supertest');
const pool = require('../db');
const { createApp } = require('../app');
const { resetLookupForTests } = require('../bookLookup');
const { resetDb, createUser, bearer } = require('./helpers');

let app;
let user;
let fetchMock;

/** Makes a stand-in network answer. In: the JSON body and status. */
const answer = (body, status = 200) => ({ ok: status < 400, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const OPEN_LIBRARY = { docs: [{ title: 'Project Hail Mary', author_name: ['Andy Weir'] }] };
const ask = (body, who = user) => request(app).post('/api/lookup').set('Authorization', bearer(who.token)).send(body);

beforeEach(async () => {
  await resetDb();
  resetLookupForTests();
  app = createApp();
  user = await createUser();
  fetchMock = vi.fn(async () => answer(OPEN_LIBRARY));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GOOGLE_BOOKS_API_KEY;
  delete process.env.BOOK_LOOKUP_ENABLED;
  delete process.env.BOOK_LOOKUP_CONTACT;
});
afterAll(() => pool.end());

describe('who can use it', () => {
  // Otherwise anyone on the internet could use this server to query the catalogues and get it blocked.
  test('it refuses a request with no sign-in, without contacting anything', async () => {
    const res = await request(app).post('/api/lookup').send({ kind: 'title', query: 'hail mary' });
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // One account mustn't be able to use the service up for the whole family.
  test('an account past its limit is refused, and another still works', async () => {
    app = createApp({ lookupLimit: 2 });
    await ask({ kind: 'title', query: 'first' });
    await ask({ kind: 'title', query: 'second' });
    expect((await ask({ kind: 'title', query: 'third' })).status).toBe(429);
    const other = await createUser();
    expect((await ask({ kind: 'title', query: 'fourth' }, other)).status).toBe(200);
  });

  // The server's owner can turn this off for everyone, for example for privacy.
  test('the owner can turn it off', async () => {
    process.env.BOOK_LOOKUP_ENABLED = 'false';
    expect((await ask({ kind: 'title', query: 'hail mary' })).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('input handling', () => {
  // Malformed requests get a 400 rather than a crash, and go nowhere.
  test.each([
    [{ kind: 'isbn', query: 'hail mary' }],
    [{ kind: 'title', query: 'ab' }],
    [{ kind: 'title', query: 'x'.repeat(101) }],
    [{ kind: 'title', query: { $ne: 'x' } }],
    [{ kind: 'title' }],
    [{}],
  ])('%j is refused', async (body) => {
    expect((await ask(body)).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Parameter injection: typed text mustn't be able to add settings to the request, or send it somewhere else.
  test('typed text stays inside one parameter, on the fixed address', async () => {
    await ask({ kind: 'title', query: 'x&limit=100000&fields=*#y' });
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.origin).toBe('https://openlibrary.org');
    expect(url.searchParams.get('limit')).toBe('30');
    expect(url.searchParams.get('fields')).toBe('title,author_name');
    expect(url.searchParams.has('title')).toBe(false);
  });

  // Query injection: the catalogue's search language gives meaning to ( ) : * and capitalised OR. Typed text mustn't be
  // able to widen a search or reach other fields, however it's written.
  test('search-language characters are removed', async () => {
    await ask({ kind: 'title', query: 'dune) OR author_name:(*' });
    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get('q')).toBe('title:(dune or author (name OR name*))');
  });

  test('text with no words in it asks nothing', async () => {
    const res = await ask({ kind: 'title', query: '!!! ***' });
    expect(res.body).toEqual({ results: [], source: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Titles with apostrophes and accents are real, and must survive.
  test('apostrophes and accented letters are kept', async () => {
    await ask({ kind: 'title', query: "Hitchhiker's Café" });
    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get('q')).toBe("title:(hitchhiker's (café OR café*))");
  });

  // A redirect could lead the server to an internal address, so it's refused rather than followed.
  test('redirects are refused', async () => {
    await ask({ kind: 'title', query: 'hail mary' });
    expect(fetchMock.mock.calls[0][1].redirect).toBe('error');
  });
});

describe('what comes back', () => {
  test('it returns tidy titles and authors, naming the source', async () => {
    const res = await ask({ kind: 'title', query: 'hail mary' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ results: [{ title: 'Project Hail Mary', authors: ['Andy Weir'] }], source: 'Open Library' });
  });

  test('author searches return names', async () => {
    fetchMock.mockResolvedValueOnce(answer({ docs: [{ name: 'Andy Weir' }] }));
    const res = await ask({ kind: 'author', query: 'andy weir' });
    expect(res.body).toEqual({ results: [{ name: 'Andy Weir' }], source: 'Open Library' });
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.pathname).toBe('/search/authors.json');
    // The real service answers 500 if asked for the name field alone.
    expect(url.searchParams.get('fields')).toBe('key,name');
  });

  // Words are often half typed, so the last one has to match the start of a word, and exactly as well.
  test('the last word can be unfinished', async () => {
    await ask({ kind: 'author', query: 'neil gaim' });
    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get('q')).toBe('neil (gaim OR gaim*)');
  });

  // The catalogue's looser matches would look wrong as suggestions, so each must contain what was typed.
  test('results without the typed words are left out, ignoring accents and capitals', async () => {
    fetchMock.mockResolvedValueOnce(answer({ docs: [{ title: 'Treasure Island' }, { title: 'PIRAte Tales' }, { title: 'Piráte Song' }] }));
    const res = await ask({ kind: 'title', query: 'pira' });
    expect(res.body.results.map((item) => item.title)).toEqual(['PIRAte Tales', 'Piráte Song']);
  });

  // Answers come from outside, so wrong types, control characters and repeats are all dealt with here.
  test('a hostile or malformed answer is cleaned', async () => {
    fetchMock.mockResolvedValueOnce(answer({
      docs: [
        null,
        { title: 5, author_name: 'x' },
        { title: 'x'.repeat(201) },
        { title: 'Clean\u001b[31m Title', author_name: ['Good', 7, null] },
        { title: 'Clean[31m Title', author_name: ['Good'] },
      ],
    }));
    const res = await ask({ kind: 'title', query: 'clean title' });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([{ title: 'Clean[31m Title', authors: ['Good'] }]);
  });

  // Someone typing a title is after that book, not the study guides about it.
  test('titles starting with what was typed come first, otherwise in the catalogue\'s order', async () => {
    fetchMock.mockResolvedValueOnce(answer({ docs: [{ title: 'Summary of Dune' }, { title: 'The Dune Guide' }, { title: 'Dune' }, { title: 'Dune Messiah' }] }));
    const res = await ask({ kind: 'title', query: 'dune' });
    expect(res.body.results.map((item) => item.title)).toEqual(['Dune', 'Dune Messiah', 'Summary of Dune', 'The Dune Guide']);
  });

  // Catalogue entries like this would add one garbled "author" made of several people.
  test('author names with commas are left out', async () => {
    fetchMock.mockResolvedValueOnce(answer({ docs: [{ name: 'Gaiman, Neil, Reaves, Michael' }, { name: 'Gaiman, Neil' }, { name: 'Neil Gaiman' }] }));
    const res = await ask({ kind: 'author', query: 'neil gaiman' });
    expect(res.body.results).toEqual([{ name: 'Neil Gaiman' }]);
  });

  // Open Library asks callers to cache, and a repeated search shouldn't cost a request.
  test('a repeated search is answered from memory', async () => {
    await ask({ kind: 'title', query: 'hail mary' });
    await ask({ kind: 'title', query: 'HAIL   MARY' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // A failure says only that suggestions aren't available, with no detail of what went wrong.
  test('an unavailable catalogue answers 503 and reveals nothing', async () => {
    fetchMock.mockResolvedValueOnce(answer('secret-internal-detail', 500));
    const res = await ask({ kind: 'title', query: 'hail mary' });
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toContain('secret-internal-detail');
  });

  test('anything other than JSON counts as unavailable', async () => {
    fetchMock.mockResolvedValueOnce(answer('<html>maintenance</html>'));
    expect((await ask({ kind: 'title', query: 'hail mary' })).status).toBe(503);
  });

  // A misbehaving service mustn't be able to fill this server's memory with one reply.
  test('an oversized answer counts as unavailable', async () => {
    fetchMock.mockResolvedValueOnce(answer('x'.repeat(1024 * 1024 + 1)));
    expect((await ask({ kind: 'title', query: 'hail mary' })).status).toBe(503);
  });
});

describe('Google Books', () => {
  // Without a key, Google is never contacted, whatever happens to Open Library.
  test('with no key it is left out entirely', async () => {
    fetchMock.mockResolvedValueOnce(answer({ docs: [] }));
    const res = await ask({ kind: 'title', query: 'obscure' });
    expect(res.body).toEqual({ results: [], source: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // With a key, it's only a backup: a search Open Library can answer stays with Open Library.
  test('it is not used when Open Library has results', async () => {
    process.env.GOOGLE_BOOKS_API_KEY = 'test-key';
    await ask({ kind: 'title', query: 'hail mary' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('it fills in when Open Library finds nothing', async () => {
    process.env.GOOGLE_BOOKS_API_KEY = 'test-key';
    fetchMock.mockResolvedValueOnce(answer({ docs: [] }));
    fetchMock.mockResolvedValueOnce(answer({ items: [{ volumeInfo: { title: 'Found', authors: ['Writer'] } }] }));
    const res = await ask({ kind: 'title', query: 'found' });
    expect(res.body).toEqual({ results: [{ title: 'Found', authors: ['Writer'] }], source: 'Google Books' });
  });

  test('it fills in when Open Library fails', async () => {
    process.env.GOOGLE_BOOKS_API_KEY = 'test-key';
    fetchMock.mockResolvedValueOnce(answer('down', 503));
    fetchMock.mockResolvedValueOnce(answer({ items: [{ volumeInfo: { title: 'Found' } }] }));
    expect((await ask({ kind: 'title', query: 'found' })).body.source).toBe('Google Books');
  });

  // Key exposure: the key must stay out of the address, where logs and error messages could capture it, and out of
  // what the app receives.
  test('the key goes only in a header, and never reaches the app', async () => {
    process.env.GOOGLE_BOOKS_API_KEY = 'very-secret-key';
    fetchMock.mockResolvedValueOnce(answer({ docs: [] }));
    fetchMock.mockResolvedValueOnce(answer({ items: [{ volumeInfo: { title: 'Found' } }] }));
    const res = await ask({ kind: 'title', query: 'found' });
    const [url, options] = fetchMock.mock.calls[1];
    expect(url).not.toContain('very-secret-key');
    expect(options.headers['x-goog-api-key']).toBe('very-secret-key');
    expect(JSON.stringify(res.body)).not.toContain('very-secret-key');
  });

  // Privacy and key exposure in logs: failures record only a status, never the search text or the key.
  test('a failure logs neither the search nor the key', async () => {
    process.env.GOOGLE_BOOKS_API_KEY = 'very-secret-key';
    const output = [];
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((text) => { output.push(String(text)); return true; });
    const err = vi.spyOn(process.stderr, 'write').mockImplementation((text) => { output.push(String(text)); return true; });
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      fetchMock.mockResolvedValue(answer('down', 500));
      await ask({ kind: 'title', query: 'private-search-words' });
      const text = output.join('');
      expect(text).toContain('answered 500');
      expect(text).not.toContain('private-search-words');
      expect(text).not.toContain('very-secret-key');
    } finally {
      process.env.NODE_ENV = env;
      out.mockRestore();
      err.mockRestore();
    }
  });
});
