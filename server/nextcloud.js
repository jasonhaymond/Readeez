// nextcloud.js
// Saves a person's library export to their own Nextcloud, over WebDAV (Nextcloud's
// file-transfer protocol, built on web requests). Called by routes/nextcloud.js for
// a manual export and by the daily timer in index.js.
//
// Security: family members type in the Nextcloud address, and this server then
// connects to it. Without protection, that could be used to probe the server's own
// network (server-side request forgery, or SSRF), so a connection is refused unless
// every address behind the name is public. The check runs inside the connection's
// own DNS lookup, so a name can't pass the check and then switch to a private
// address. A Nextcloud on the private network must be listed by the server's admin
// in NEXTCLOUD_ALLOWED_PRIVATE_HOSTS.

const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');
const pool = require('./db');
const { decrypt } = require('./secrets');
const { toCsv, toJson } = require('./exportFormat');
const { version } = require('./package.json');
const log = require('./logger')('nextcloud');

const ROOT_FOLDER = 'Readeez';
const TIMEOUT_MS = 30000;
const DAYS_KEPT = 7;
const MAX_RESPONSE = 5 * 1024 * 1024;
// One of this app's export files, e.g. readeez-export-20261104.csv. Only names like
// this are ever deleted from the folder, so a person's other files are never touched.
const EXPORT_FILE = /^readeez-export-(\d{8})\.(json|csv)$/;

/** A problem worth showing the person, such as a wrong password or address. */
class NextcloudError extends Error {}

// Address ranges that aren't on the public internet: this server's own machine,
// private networks, link-local (including cloud metadata addresses), and so on.
const blocked = new net.BlockList();
blocked.addSubnet('0.0.0.0', 8, 'ipv4');
blocked.addSubnet('10.0.0.0', 8, 'ipv4');
blocked.addSubnet('100.64.0.0', 10, 'ipv4');
blocked.addSubnet('127.0.0.0', 8, 'ipv4');
blocked.addSubnet('169.254.0.0', 16, 'ipv4');
blocked.addSubnet('172.16.0.0', 12, 'ipv4');
blocked.addSubnet('192.0.0.0', 24, 'ipv4');
blocked.addSubnet('192.0.2.0', 24, 'ipv4');
blocked.addSubnet('192.168.0.0', 16, 'ipv4');
blocked.addSubnet('198.18.0.0', 15, 'ipv4');
blocked.addSubnet('198.51.100.0', 24, 'ipv4');
blocked.addSubnet('203.0.113.0', 24, 'ipv4');
blocked.addSubnet('224.0.0.0', 4, 'ipv4');
blocked.addSubnet('240.0.0.0', 4, 'ipv4');
blocked.addAddress('::', 'ipv6');
blocked.addAddress('::1', 'ipv6');
// 64:ff9b:: holds IPv4 addresses inside IPv6 for NAT64, which could otherwise reach private ones.
blocked.addSubnet('64:ff9b::', 96, 'ipv6');
blocked.addSubnet('100::', 64, 'ipv6');
blocked.addSubnet('2001:db8::', 32, 'ipv6');
blocked.addSubnet('fc00::', 7, 'ipv6');
blocked.addSubnet('fe80::', 10, 'ipv6');
blocked.addSubnet('ff00::', 8, 'ipv6');

/**
 * Says whether an IP address is off the public internet.
 * In: an address string. Out: true if it's private or reserved. An IPv4 address
 * written in IPv6 form (::ffff:10.0.0.1) is unwrapped first, since it would
 * otherwise slip past the IPv4 ranges. A URL's parser rewrites that to hex
 * (::ffff:a00:1), which net.BlockList also recognises as the same address.
 */
function isPrivateAddress(address) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return blocked.check(mapped[1], 'ipv4');
  return blocked.check(address, net.isIPv6(address) ? 'ipv6' : 'ipv4');
}

/**
 * Says whether the admin has approved this host despite it being private.
 * In: a host name. Out: true if it's in NEXTCLOUD_ALLOWED_PRIVATE_HOSTS.
 */
function isAllowedPrivateHost(hostname) {
  return String(process.env.NEXTCLOUD_ALLOWED_PRIVATE_HOSTS || '')
    .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)
    .includes(hostname.toLowerCase());
}

/**
 * Checks a typed Nextcloud address.
 * In: the address text. Out: the address tidied, with no trailing slash.
 * Throws a NextcloudError with a message to show if it's unusable.
 * Plain http is accepted only for an admin-approved private host: elsewhere it
 * would send the person's app password across the internet unencrypted.
 */
function checkBaseUrl(input) {
  let url;
  try {
    url = new URL(String(input || '').trim());
  } catch {
    throw new NextcloudError('That isn\'t a web address. It should start with https://');
  }
  const approved = isAllowedPrivateHost(url.hostname.replace(/^\[|\]$/g, ''));
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && approved)) {
    throw new NextcloudError('The address must start with https://');
  }
  if (url.username || url.password) throw new NextcloudError('Leave the user name and password out of the address.');
  if (url.search || url.hash) throw new NextcloudError('Enter just the address of your Nextcloud.');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * A DNS lookup for outgoing connections that refuses private addresses.
 * In/out: the callback form Node expects for a request's "lookup" option.
 */
function publicOnlyLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    if (!isAllowedPrivateHost(hostname) && addresses.some((a) => isPrivateAddress(a.address))) {
      return callback(new NextcloudError(`${hostname} is a private address, which this server doesn't allow.`));
    }
    if (options && options.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

/**
 * Sends one request to the person's Nextcloud.
 * In: link ({ baseUrl, username, password }), a method, a path of already-encoded
 * pieces after the WebDAV root, and optionally a body and headers.
 * Out: { status, text }. Redirects aren't followed, since one could point at a
 * private address or carry the password somewhere else.
 * Side effects: whatever the method does on the Nextcloud.
 */
function davRequest(link, method, davPath, { body, headers = {} } = {}) {
  const base = new URL(checkBaseUrl(link.baseUrl));
  const hostname = base.hostname.replace(/^\[|\]$/g, '');
  // A literal IP skips DNS, so the lookup guard never sees it; it's checked here.
  if (net.isIP(hostname) && !isAllowedPrivateHost(hostname) && isPrivateAddress(hostname)) {
    return Promise.reject(new NextcloudError(`${hostname} is a private address, which this server doesn't allow.`));
  }
  // A URL with no folder has the pathname "/", which is removed here to avoid "//remote.php".
  const target = `${base.pathname.replace(/\/+$/, '')}/remote.php/dav/files/${encodeURIComponent(link.username)}/${davPath}`;
  const lib = base.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        protocol: base.protocol, hostname, port: base.port, path: target, method,
        lookup: publicOnlyLookup,
        timeout: TIMEOUT_MS,
        headers: {
          Authorization: `Basic ${Buffer.from(`${link.username}:${link.password}`).toString('base64')}`,
          ...headers,
          ...(body !== undefined ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        },
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          // Caps the reply, so a hostile server can't exhaust this server's memory.
          size += chunk.length;
          if (size > MAX_RESPONSE) req.destroy(new NextcloudError('Nextcloud sent back too much data.'));
          else chunks.push(chunk);
        });
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    req.on('timeout', () => req.destroy(new NextcloudError(`${hostname} took too long to answer.`)));
    req.on('error', (err) => reject(err instanceof NextcloudError ? err : new NextcloudError(`Couldn't reach ${hostname}.`)));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/**
 * Turns an unsuccessful answer into a message a person can act on.
 * In: the HTTP status and what was being attempted. Out: a NextcloudError.
 */
function statusError(status, doing) {
  if (status === 401 || status === 403) return new NextcloudError('Nextcloud refused that user name or app password.');
  return new NextcloudError(`Nextcloud answered ${status} while ${doing}.`);
}

/**
 * Confirms the address and credentials work, by listing the top of the person's
 * files. Used when they save the connection.
 * In: link. Out: nothing; throws a NextcloudError if it doesn't work.
 */
async function testConnection(link) {
  const { status } = await davRequest(link, 'PROPFIND', '', { headers: { Depth: '0' } });
  if (status !== 207) throw statusError(status, 'checking the connection');
}

// Makes a safe folder name out of an email: anything but letters, digits, dot, dash
// and underscore becomes a dash. Keeps family members apart if they share one
// Nextcloud account, so one person's export can't overwrite another's.
const accountFolder = (email) => String(email).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 100) || 'account';

/**
 * Creates a folder if it's missing.
 * In: link and an encoded path. Throws if it can't. 405 means it already exists.
 */
async function ensureFolder(link, davPath) {
  const { status } = await davRequest(link, 'MKCOL', davPath);
  if (status !== 201 && status !== 405) throw statusError(status, 'creating a folder');
}

/**
 * Deletes this app's exports older than the retention window.
 * In: link, the encoded folder path, and the current time.
 * Side effects: deletes old export files only, recognised by their exact name. A
 * failure here is ignored, because it shouldn't fail an export that already worked.
 */
async function pruneOldExports(link, folder, now) {
  const { status, text } = await davRequest(link, 'PROPFIND', folder, { headers: { Depth: '1' } });
  if (status !== 207) return;
  const cutoff = new Date(now.getTime() - DAYS_KEPT * 24 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
  // Pulls each file path out of the XML reply, e.g.
  // <d:href>/remote.php/dav/files/sam/Readeez/readeez-export-20261104.csv</d:href>
  for (const match of text.matchAll(/<[a-z0-9]*:?href>([^<]+)<\/[a-z0-9]*:?href>/gi)) {
    const name = decodeURIComponent(match[1].split('/').pop());
    const parsed = EXPORT_FILE.exec(name);
    // Dates written as YYYYMMDD sort correctly when compared as text.
    if (parsed && parsed[1] < cutoff) {
      await davRequest(link, 'DELETE', `${folder}/${encodeURIComponent(name)}`);
    }
  }
}

/**
 * Exports one person's library to their Nextcloud, as one JSON and one CSV file in
 * Readeez/<email>/. Repeating it on the same day replaces that day's files.
 * In: the user's id, and the current time (replaceable in tests).
 * Out: nothing; throws a NextcloudError if it couldn't finish.
 * Side effects: writes files to Nextcloud, and records the result in nextcloud_links
 * so the person can see it in Settings.
 */
async function exportForUser(userId, now = new Date()) {
  const { rows: [row] } = await pool.query(
    `select l.*, u.email from nextcloud_links l join users u on u.id = l.user_id where l.user_id = $1`,
    [userId]
  );
  if (!row) throw new NextcloudError('Connect your Nextcloud first.');

  try {
    const link = { baseUrl: row.base_url, username: row.username, password: decrypt(row.app_password_enc) };
    // Only this person's books: their export must never contain anyone else's.
    const { rows: books } = await pool.query(
      `select id, title, authors, categories, status, rating, read_date, notes, updated_at
         from books where user_id = $1 and not deleted order by title`,
      [userId]
    );
    const shaped = books.map((b) => ({
      id: b.id, title: b.title, authors: b.authors, categories: b.categories, status: b.status,
      rating: b.rating, readDate: b.read_date, notes: b.notes, updatedAt: b.updated_at.toISOString(),
    }));

    const folder = `${ROOT_FOLDER}/${encodeURIComponent(accountFolder(row.email))}`;
    await ensureFolder(link, ROOT_FOLDER);
    await ensureFolder(link, folder);
    const stamp = now.toISOString().slice(0, 10).replace(/-/g, '');
    const files = [
      [`readeez-export-${stamp}.json`, toJson(shaped, version, now.toISOString()), 'application/json'],
      [`readeez-export-${stamp}.csv`, toCsv(shaped), 'text/csv'],
    ];
    for (const [name, body, type] of files) {
      const { status } = await davRequest(link, 'PUT', `${folder}/${name}`, { body, headers: { 'Content-Type': `${type}; charset=utf-8` } });
      if (status !== 201 && status !== 204) throw statusError(status, 'saving the export');
    }
    await pruneOldExports(link, folder, now).catch(() => {});

    await pool.query('update nextcloud_links set last_export_at = $2, last_error = null where user_id = $1', [userId, now]);
  } catch (err) {
    // Only this module's own messages are shown to the person. Anything unexpected
    // gets a generic one, so internal details stay in the server log.
    const message = err instanceof NextcloudError ? err.message : 'The export failed. Your admin can check the server log.';
    if (!(err instanceof NextcloudError)) log.error(`export failed for user ${userId}: ${err.message}`);
    await pool.query('update nextcloud_links set last_error = $2 where user_id = $1', [userId, message]);
    throw new NextcloudError(message);
  }
}

/**
 * Runs the daily export for everyone who has it on and is due. Called hourly from
 * index.js. One person's failure is recorded and doesn't stop the others.
 * Out: nothing. Side effects: writes to each person's Nextcloud.
 */
async function runDueExports() {
  const { rows } = await pool.query(
    `select l.user_id from nextcloud_links l join users u on u.id = l.user_id
      where l.daily_export and u.disabled_at is null
        and (l.last_export_at is null or l.last_export_at < now() - interval '23 hours')`
  );
  for (const { user_id: userId } of rows) {
    await exportForUser(userId).catch((err) => log.warn(`daily export failed for user ${userId}: ${err.message}`));
  }
}

module.exports = { NextcloudError, checkBaseUrl, testConnection, exportForUser, runDueExports, isPrivateAddress };
