// scripts/lib/security-parse.mjs
// Reads one scanner's raw JSON output and gives a verdict for scripts/security-check.sh.
//
//   node scripts/lib/security-parse.mjs <semgrep|eslint|audit|gitleaks> <input file> <report file>
//
// Prints "<PASS|FAIL|NOT RUN><tab><one-line detail>" and writes the findings as Markdown to
// the report file. What fails the gate:
//   semgrep   any finding of ERROR severity. WARNING and INFO are listed for review.
//   eslint    any error. Warnings are listed for review.
//   audit     any high or critical advisory. Moderate and low are listed for review.
//   gitleaks  any secret at all.
// Output that can't be understood is NOT RUN, never a pass.

import { readFileSync, writeFileSync } from 'node:fs';

const [kind, inputPath, reportPath] = process.argv.slice(2);

/** Escapes a value for a Markdown table cell, and caps its length. */
const cell = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').slice(0, 300);

/** Counts items by a key. In: items and a function picking the key. Out: { key: count }. */
function tally(items, keyOf) {
  const counts = {};
  for (const item of items) {
    const key = keyOf(item);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

const describe = (counts) => Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ') || 'no findings';

/**
 * Builds a Markdown table.
 * In: column headings and rows. Out: the table text, or a line saying there's nothing.
 */
function table(headers, rows) {
  if (!rows.length) return 'No findings.\n';
  return [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n') + '\n';
}

// One function per scanner. In: the parsed output. Out: { status, detail, report }.
const PARSERS = {
  semgrep(data) {
    const results = data.results || [];
    const counts = tally(results, (r) => r.extra?.severity || 'UNKNOWN');
    const errors = (data.errors || []).filter((e) => e.level === 'error');
    const scanned = (data.paths?.scanned || []).length;
    // A scan that errored or looked at nothing has proved nothing, however empty its results
    // are. A rule set that fails to download, for instance, gives "no findings" and no files.
    if (errors.length || !scanned) {
      return {
        status: 'NOT RUN',
        detail: `the scan didn't complete: ${errors.length} errors, ${scanned} files scanned`,
        report: table(['Level', 'Type', 'Message'], errors.map((e) => [e.level, e.type, e.message])),
      };
    }
    return {
      status: counts.ERROR ? 'FAIL' : 'PASS',
      detail: `${describe(counts)}, ${scanned} files scanned`,
      report: table(['Severity', 'Rule', 'File', 'Line', 'Message'], results.map((r) => [r.extra?.severity, r.check_id, r.path, r.start?.line, r.extra?.message])),
    };
  },
  eslint(data) {
    const items = data.flatMap((file) => file.messages.map((m) => ({ ...m, file: file.filePath })));
    const errors = items.filter((m) => m.severity === 2);
    return {
      status: errors.length ? 'FAIL' : 'PASS',
      detail: `${errors.length} errors, ${items.length - errors.length} warnings, ${data.length} files scanned`,
      report: table(['Level', 'Rule', 'File', 'Line', 'Message'], items.map((m) => [m.severity === 2 ? 'error' : 'warning', m.ruleId, m.file, m.line, m.message])),
    };
  },
  audit(data) {
    if (!data.metadata?.vulnerabilities) throw new Error('no audit data');
    const v = data.metadata.vulnerabilities;
    const direct = Object.values(data.vulnerabilities || {});
    return {
      status: v.high || v.critical ? 'FAIL' : 'PASS',
      detail: `${v.critical} critical, ${v.high} high, ${v.moderate} moderate, ${v.low} low`,
      report: table(['Severity', 'Package', 'Direct?', 'Cause'], direct.map((d) => [d.severity, d.name, d.isDirect ? 'yes' : 'no', d.via.map((x) => x.title || x).join('; ')])),
    };
  },
  gitleaks(data) {
    // Only the rule and location are reported: a report must never repeat the secret itself.
    return {
      status: data.length ? 'FAIL' : 'PASS',
      detail: `${data.length} secrets found`,
      report: table(['Rule', 'File', 'Line', 'Commit'], data.map((f) => [f.RuleID, f.File, f.StartLine, f.Commit])),
    };
  },
};

let result;
try {
  const parser = Object.hasOwn(PARSERS, kind) ? PARSERS[kind] : null;
  if (!parser) throw new Error(`unknown scanner ${kind}`);
  const text = readFileSync(inputPath, 'utf8').trim();
  // gitleaks writes nothing at all when it finds nothing, on some versions.
  result = parser(text ? JSON.parse(text) : []);
} catch (err) {
  result = { status: 'NOT RUN', detail: `couldn't read the output: ${err.message}`, report: 'The scanner\'s output could not be read.\n' };
}
writeFileSync(reportPath, result.report);
process.stdout.write(`${result.status}\t${result.detail}\n`);
