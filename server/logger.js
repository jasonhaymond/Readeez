// logger.js
// The server's log format: one line per event, "<time> <LEVEL> [<source>] <text>". Lines go to
// stdout/stderr, which Docker captures and rotates (see docker-compose.yml), so they survive
// restarts and can't fill the disk. The newest lines are also kept in memory for the app's admin
// log viewer. Callers must never pass passwords, tokens, codes or book contents to these.

const MAX_KEPT = 2000;
const MAX_LINE = 2000;
const LEVEL_RANK = { INFO: 0, WARN: 1, ERROR: 2 };
// The in-memory copy, oldest first. It's emptied by a restart; Docker's copy isn't.
const recent = [];

/**
 * Makes a logger for one part of the app.
 * In: source, a short name that appears on each line (e.g. 'sync').
 * Out: an object with info, warn and error functions, each taking a message.
 * Side effects: remembers the line and writes it out. Output is silent during tests, so test
 * results stay readable, but lines are still remembered, so the viewer can be tested.
 */
function createLogger(source) {
  const write = (stream, level, message) => {
    const line = `${new Date().toISOString()} ${level} [${source}] ${message}`.slice(0, MAX_LINE);
    recent.push({ level, line });
    if (recent.length > MAX_KEPT) recent.shift();
    if (process.env.NODE_ENV !== 'test') stream.write(`${line}\n`);
  };
  return {
    info: (message) => write(process.stdout, 'INFO', message),
    warn: (message) => write(process.stderr, 'WARN', message),
    error: (message) => write(process.stderr, 'ERROR', message),
  };
}

/**
 * Returns the newest log lines, for the admin viewer.
 * In: minLevel ('INFO', 'WARN' or 'ERROR'; that level and worse are included) and how many.
 * Out: an array of line strings, newest first.
 */
function recentLogs(minLevel, limit) {
  const rank = LEVEL_RANK[minLevel] ?? 0;
  return recent.filter((entry) => LEVEL_RANK[entry.level] >= rank).slice(-limit).reverse().map((entry) => entry.line);
}

module.exports = createLogger;
module.exports.recentLogs = recentLogs;
