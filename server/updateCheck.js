// updateCheck.js
// Finds the newest released Readeez version, for the admin Server panel, by reading
// the version tags of the GitHub repo named in UPDATE_CHECK_REPO. Sends no data about
// this server. If the setting is empty or GitHub can't be reached, the panel shows
// the running version only.

const log = require('./logger')('update-check');

const CACHE_MS = 60 * 60 * 1000;
// A release tag such as v1.2.3, with the three numbers captured.
const TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
let cached = { at: 0, value: null };

/**
 * Compares two versions.
 * In: two strings such as 'v1.10.0' or '1.9.2'. Out: true if the first is newer.
 * Compared number by number, because as plain text 1.10 would sort before 1.9.
 */
function isNewer(a, b) {
  const parse = (v) => String(v).replace(/^v/, '').split('.').map(Number);
  const [left, right] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] > right[i];
  }
  return false;
}

/**
 * Looks up the newest release, remembering the answer for an hour so opening the
 * panel repeatedly doesn't hit GitHub's request limit.
 * In: nothing. Out: a version like '1.2.3', or null if it can't be determined.
 */
async function latestVersion() {
  const repo = process.env.UPDATE_CHECK_REPO;
  if (!repo) return null;
  if (Date.now() - cached.at < CACHE_MS) return cached.value;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/tags?per_page=100`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Readeez-server' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const tags = (await res.json()).map((tag) => tag.name).filter((name) => TAG.test(name));
    const newest = tags.reduce((best, tag) => (!best || isNewer(tag, best) ? tag : best), null);
    cached = { at: Date.now(), value: newest ? newest.replace(/^v/, '') : null };
  } catch (err) {
    log.warn(`update check failed: ${err.message}`);
    // Remembers the failure too, so an outage doesn't add a 5-second wait each time.
    cached = { at: Date.now(), value: null };
  }
  return cached.value;
}

module.exports = { latestVersion, isNewer };
