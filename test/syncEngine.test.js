// test/syncEngine.test.js
// Tests the phone's half of syncing, against a stand-in server: no edit may be lost,
// including edits made during a sync, and a server problem must not lose anything.

const { mergeServerBook, runSync } = require('../lib/syncEngine');

const book = (id, fields = {}) => ({ id, title: id, updatedAt: '2026-01-01T00:00:00.000Z', dirty: false, ...fields });

/**
 * Builds a fake phone and server around runSync.
 * In: starting books, and post(body), the fake server. Out: the deps plus inspectors.
 */
function setup(initial, post) {
  const books = new Map(initial.map((b) => [b.id, b]));
  const state = { cursor: null, epoch: null, posts: [] };
  return {
    books,
    state,
    deps: {
      getBooks: async () => [...books.values()],
      putBooks: async (list) => list.forEach((b) => books.set(b.id, b)),
      getCursor: async () => state.cursor,
      setCursor: async (c) => { state.cursor = c; },
      getEpoch: async () => state.epoch,
      setEpoch: async (e) => { state.epoch = e; },
      post: async (body) => {
        state.posts.push(body);
        return post(body, books);
      },
    },
  };
}

const done = { cursor: '1', more: false, changes: [], rejected: [] };

describe('merging', () => {
  // An edit made during the sync must survive the server's reply.
  test('a newer local edit is kept', () => {
    const local = book('a', { title: 'typing', dirty: true, updatedAt: '2026-01-02T00:00:00.000Z' });
    expect(mergeServerBook(local, book('a'), '2026-01-01T00:00:00.000Z')).toBe(local);
  });

  // The server's answer settles a conflict over the version that was sent.
  test('the server wins over what was sent', () => {
    const local = book('a', { dirty: true });
    const merged = mergeServerBook(local, book('a', { title: 'server', updatedAt: '2026-01-05T00:00:00.000Z' }), local.updatedAt);
    expect(merged).toMatchObject({ title: 'server', dirty: false });
  });

  // An offline phone that hasn't sent its edit keeps it until it's judged by the server.
  test('an unsent local edit is not overwritten by a pull', () => {
    const local = book('a', { dirty: true, title: 'mine' });
    expect(mergeServerBook(local, book('a', { title: 'server' }), undefined)).toBe(local);
  });

  test('a new server book is added', () => {
    expect(mergeServerBook(undefined, book('a', { dirty: undefined }))).toMatchObject({ id: 'a', dirty: false });
  });
});

describe('a sync', () => {
  // Normal path: unsent books go up without the local-only flag, and are marked sent.
  test('sends dirty books only, and clears the flag', async () => {
    const { deps, books, state } = setup([book('a', { dirty: true }), book('b')], () => done);
    await runSync(deps);
    expect(state.posts[0].changes.map((c) => c.id)).toEqual(['a']);
    expect(state.posts[0].changes[0]).not.toHaveProperty('dirty');
    expect(books.get('a').dirty).toBe(false);
    expect(state.cursor).toBe('1');
  });

  // The first sync starts from position 0, and later ones continue from the saved one.
  test('the cursor is sent and saved', async () => {
    const { deps, state } = setup([], () => ({ ...done, cursor: '9' }));
    await runSync(deps);
    await runSync(deps);
    expect(state.posts.map((p) => p.cursor)).toEqual(['0', '9']);
  });

  // Another device's changes arrive, including a deletion.
  test('applies incoming books', async () => {
    const { deps, books } = setup([book('gone')], () => ({ ...done, changes: [book('new'), book('gone', { deleted: true })] }));
    await runSync(deps);
    expect(books.has('new')).toBe(true);
    expect(books.get('gone').deleted).toBe(true);
  });

  // An edit made while the request is in the air stays unsent, for the next sync.
  test('an edit during the request stays dirty', async () => {
    const { deps, books } = setup([book('a', { dirty: true })], (body, store) => {
      store.set('a', book('a', { title: 'newer', dirty: true, updatedAt: '2026-02-01T00:00:00.000Z' }));
      return done;
    });
    await runSync(deps);
    expect(books.get('a')).toMatchObject({ title: 'newer', dirty: true });
  });

  // A dropped connection loses nothing: the book stays unsent, and the error reaches the
  // caller to show.
  test('a network failure keeps the book unsent', async () => {
    const { deps, books } = setup([book('a', { dirty: true })], () => { throw new Error('offline'); });
    await expect(runSync(deps)).rejects.toThrow('offline');
    expect(books.get('a').dirty).toBe(true);
  });

  // A book the server refuses stays on the phone and is reported, without an endless loop
  // or marking it as saved.
  test('a refused book is kept, reported, and not retried in a loop', async () => {
    const { deps, books, state } = setup([book('bad', { dirty: true })], () => ({ ...done, rejected: [{ id: 'bad', error: 'bad title' }] }));
    const { rejected } = await runSync(deps);
    expect(rejected).toEqual(['bad']);
    expect(books.get('bad').dirty).toBe(true);
    expect(state.posts).toHaveLength(1);
  });

  // Big uploads go in batches, and every book gets sent.
  test('large uploads are sent in batches', async () => {
    const many = Array.from({ length: 450 }, (_, i) => book(`b${i}`, { dirty: true }));
    const { deps, books, state } = setup(many, () => done);
    await runSync(deps);
    expect(state.posts.map((p) => p.changes.length)).toEqual([200, 200, 50]);
    expect([...books.values()].every((b) => !b.dirty)).toBe(true);
  });

  // Big downloads continue until the server says it's finished.
  test('keeps pulling while the server has more', async () => {
    let call = 0;
    const { deps, state } = setup([], () => {
      call += 1;
      return { ...done, cursor: String(call), more: call < 3 };
    });
    await runSync(deps);
    expect(state.posts.map((p) => p.cursor)).toEqual(['0', '1', '2']);
  });

  // A misbehaving server that always claims "more" can't trap the app forever.
  test('a server that never finishes cannot loop forever', async () => {
    const { deps, state } = setup([], () => ({ ...done, more: true }));
    await runSync(deps);
    expect(state.posts.length).toBeLessThanOrEqual(200);
  });

  // The restore id is remembered and sent back, which is how the server can spot a restore.
  test('the epoch is saved and sent on the next sync', async () => {
    const { deps, state } = setup([], () => ({ ...done, epoch: 'e1' }));
    await runSync(deps);
    await runSync(deps);
    expect(state.posts[0].epoch).toBeUndefined();
    expect(state.posts[1].epoch).toBe('e1');
  });

  // After a server restore, books it lost are sent up again from the phone.
  test('a reset sends the phone\'s books back to the server', async () => {
    let call = 0;
    const { deps, state, books } = setup([book('kept')], () => {
      call += 1;
      return call === 1 ? { ...done, reset: true } : done;
    });
    await runSync(deps);
    expect(state.posts[1].changes.map((c) => c.id)).toEqual(['kept']);
    expect(books.get('kept').dirty).toBe(false);
  });
});
