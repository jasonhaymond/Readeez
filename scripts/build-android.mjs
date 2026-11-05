#!/usr/bin/env node
// scripts/build-android.mjs
// Builds the Android app on the self-hosted build server and downloads the APK to
// dist-android/. The build server clones from GitHub, so it builds what's been pushed. Run this
// where the build credentials live: they stay on that machine and aren't copied elsewhere.
//
//   npm run build:android                  # release build of the version tag at HEAD, arm64
//   npm run build:android -- --ref v1.2.0  # release build of that version tag
//   npm run build:android -- --abi x86_64  # another processor type (x86_64 = emulators)
//   npm run build:android -- --abi all     # every processor type
//   npm run build:android -- --debug       # a debug build, of HEAD or any --ref
//   npm run build:android -- --status <id> # re-check or download an earlier build
//
// Settings come from the gitignored .env (see .env.example). A release build is signed by
// the key stored on the build server, referred to only by name: Android only installs an update
// signed with the same key as the installed app, so that key must never change.
//
// A release build must be an approved version: an annotated tag with a recorded security review (the same
// check server/update.sh makes), because a release-signed APK is what family members install.
//
// Before submitting, it refuses a commit that wouldn't match GitHub, a versionCode that doesn't
// follow the version, and Expo native packages from another SDK (which build fine, then crash).

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkNativeVersions } from './check-native-versions.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ALL_ABIS = ['armeabi-v7a', 'arm64-v8a', 'x86', 'x86_64'];
const DEFAULT_ABIS = ['arm64-v8a'];
const OUT_DIR = join(ROOT, 'dist-android');
const POLL_MS = 15000;

/** Prints an error and stops. In: the message. */
function fail(message) {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

/**
 * Reads the .env file. Out: an object of its settings. Each line is matched as NAME=value,
 * with optional surrounding quotes removed from the value.
 */
function readEnv() {
  const path = join(ROOT, '.env');
  const env = {};
  if (!existsSync(path)) return env;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match) env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

const git = (args) => execSync(`git ${args}`, { cwd: ROOT, encoding: 'utf8' }).trim();

/**
 * Checks Android's update number. It must follow the version (MAJOR×10000 + MINOR×100 + PATCH,
 * so 1.2.3 is 10203), because Android refuses an update with a lower number.
 * In: a git ref. Out: a problem message, or null if it's right.
 */
function versionCodeProblem(ref) {
  const app = JSON.parse(git(`show ${ref}:app.json`)).expo;
  const [major, minor, patch] = String(app.version).split('.').map(Number);
  const expected = major * 10000 + minor * 100 + patch;
  return app.android?.versionCode === expected ? null
    : `app.json android.versionCode is ${app.android?.versionCode}, but version ${app.version} needs ${expected}.`;
}

/** Works out the repo's public https address from the origin remote. */
function githubHttpsUrl() {
  const match = git('remote get-url origin').match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/);
  if (!match) fail('Could not work out the GitHub repo from the origin remote.');
  return `https://github.com/${match[1]}/${match[2]}.git`;
}

/**
 * Calls the build server's API.
 * In: config, a path, and fetch options. Out: the parsed answer. Throws on an error status.
 */
async function request(config, path, options = {}) {
  const res = await fetch(`${config.apiUrl}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${config.apiKey}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  const text = await res.text();
  let body = text;
  try { body = JSON.parse(text); } catch { /* Plain text, which is what logs are. */ }
  if (!res.ok) throw new Error(`build server ${options.method || 'GET'} ${path} answered ${res.status}: ${body?.error || text}`);
  return body;
}

/**
 * Waits for a build to finish, then downloads its APK.
 * In: config, the build id, and a suffix that keeps other processor sets from overwriting the
 * normal APK's file name. Side effects: writes to dist-android/.
 */
async function waitAndDownload(config, id, abiSuffix = '') {
  let last = '';
  for (;;) {
    const build = await request(config, `/api/v1/builds/${id}`);
    if (build.status !== last) {
      console.log(`  ${new Date().toLocaleTimeString()}  ${build.status}`);
      last = build.status;
    }
    if (build.status === 'completed') break;
    if (build.status === 'failed' || build.status === 'cancelled') {
      const logs = await request(config, `/api/v1/builds/${id}/logs`).catch(() => '');
      console.error(String(logs).split('\n').slice(-40).join('\n'));
      fail(`Build ${build.status}${build.failureReason ? `: ${build.failureReason}` : ''}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  const { artifacts } = await request(config, `/api/v1/builds/${id}/artifacts`);
  if (!artifacts?.length) fail('The build completed but produced no files.');
  mkdirSync(OUT_DIR, { recursive: true });
  for (const artifact of artifacts) {
    const res = await fetch(artifact.downloadUrl);
    if (!res.ok) fail(`Downloading ${artifact.filename} failed (${res.status}).`);
    const file = join(OUT_DIR, abiSuffix ? artifact.filename.replace(/(-debug|-release)?\.apk$/, `${abiSuffix}$1.apk`) : artifact.filename);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    console.log(`\n✔ ${file} (${(artifact.size / 1e6).toFixed(1)} MB)`);
  }
}

/** Reads the arguments, runs the checks, submits the build, and waits for it. */
async function main() {
  const args = process.argv.slice(2);
  const env = readEnv();
  const config = {
    apiUrl: (env.BUILD_SERVER_API_URL || '').replace(/\/+$/, ''),
    apiKey: env.BUILD_SERVER_API_KEY,
    signingKey: (env.BUILD_SERVER_SIGNING_KEY || '').trim(),
  };
  if (!config.apiUrl) fail('BUILD_SERVER_API_URL is not set in .env. See .env.example.');
  if (!config.apiKey) fail('BUILD_SERVER_API_KEY is not set in .env. See .env.example.');

  const statusIndex = args.indexOf('--status');
  if (statusIndex !== -1) {
    if (!args[statusIndex + 1]) fail('Usage: npm run build:android -- --status <build id>');
    await waitAndDownload(config, args[statusIndex + 1]);
    return;
  }

  const variant = args.includes('--debug') ? 'debug' : 'release';
  if (variant === 'release' && !config.signingKey) fail('BUILD_SERVER_SIGNING_KEY is not set in .env, or use --debug.');

  const abiIndex = args.indexOf('--abi');
  const abiArg = abiIndex !== -1 ? String(args[abiIndex + 1] || '').trim() : '';
  const abis = !abiArg ? DEFAULT_ABIS : abiArg === 'all' ? ALL_ABIS : abiArg.split(',').map((a) => a.trim()).filter(Boolean);
  if (!abis.length || abis.some((a) => !ALL_ABIS.includes(a))) fail(`--abi takes all, or a comma-separated list of: ${ALL_ABIS.join(', ')}`);
  const isDefault = abis.length === DEFAULT_ABIS.length && DEFAULT_ABIS.every((a) => abis.includes(a));
  const abiSuffix = isDefault ? '' : abis.length === ALL_ABIS.length ? '-all' : `-${abis.join('-')}`;

  const refIndex = args.indexOf('--ref');
  let ref = refIndex !== -1 ? args[refIndex + 1] : null;
  if (variant === 'release') {
    // Fetches the tags first, then requires an exact version tag. An exact shape such as v1.2.3 is also
    // what makes it safe to place on the command line below.
    git('fetch --quiet --tags origin');
    if (!ref) {
      try { ref = git('describe --tags --exact-match HEAD'); } catch { fail('A release build needs a version tag: tag this commit, or use --ref vX.Y.Z or --debug.'); }
    }
    if (!/^v\d+\.\d+\.\d+$/.test(ref)) fail(`A release build must be a version tag such as v1.2.3, not "${ref}". Use --debug for anything else.`);
    try {
      execSync(`bash scripts/verify-release-tag.sh ${ref}`, { cwd: ROOT, stdio: 'inherit' });
    } catch {
      fail(`${ref} has no recorded security approval, so it can't be built as a release.`);
    }
    // Builds the exact commit that tag points to. A branch given the same name as the tag then can't
    // change what gets built.
    ref = git(`rev-list -n 1 refs/tags/${ref}`);
  } else if (!ref) {
    // The APK has to match a real, pushed commit, not whatever's in this folder.
    if (git('status --porcelain')) fail('There are uncommitted changes. The build server builds from GitHub, not this folder.');
    git('fetch --quiet origin');
    const head = git('rev-parse HEAD');
    if (git(`branch -r --contains ${head}`) === '') fail('HEAD hasn\'t been pushed to GitHub yet.');
    ref = head;
  }

  const codeProblem = versionCodeProblem(ref);
  if (codeProblem) fail(codeProblem);
  const mismatched = await checkNativeVersions(ref);
  if (mismatched.length) fail(`Native packages from a different Expo SDK:\n${mismatched.map((m) => `  - ${m}`).join('\n')}\nFix with: npx expo install <package>`);

  const apiUrl = env.EXPO_PUBLIC_API_URL;
  if (!apiUrl) fail('EXPO_PUBLIC_API_URL is not set in .env: the app wouldn\'t know its server.');

  console.log(`Submitting Readeez: ${ref}, ${variant}, ${abis.join(', ')}${variant === 'release' ? `, signed with "${config.signingKey}"` : ''}`);
  const build = { platform: 'android', variant, artifact: 'apk', env: { EXPO_PUBLIC_API_URL: apiUrl, ANDROID_ABI: abis.join(',') } };
  if (variant === 'release') build.signing = { key: config.signingKey };
  const { id } = await request(config, '/api/v1/builds', {
    method: 'POST',
    body: JSON.stringify({ project: { name: 'Readeez', source: { type: 'git', url: githubHttpsUrl(), ref } }, build }),
  });
  console.log(`  Build id ${id}. Safe to Ctrl+C. Resume with: npm run build:android -- --status ${id}\n`);
  await waitAndDownload(config, id, abiSuffix);
}

main().catch((err) => fail(err.message));
