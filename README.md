<img src="assets/logo.svg" alt="The Readeez logo: an open book with a gold ribbon" width="96">

# Readeez

A simple book tracker for a family. Log what you've read with its authors, categories, status,
rating, read date and your notes. It's an Android app that works offline, and a web app, both syncing to your own
server, with backups and exports to Nextcloud.

**Current version: 1.1.0** · [Changelog](CHANGELOG.md)

## Documentation

- [Admin guide](docs/admin-guide.md): deploying the server, updates, rollback, backups, restore,
  building the app
- [Changelog](CHANGELOG.md): what changed in each version
- [Licence](LICENSE): MIT
- In-app help: the ⋮ menu, then Help, for everyday use

## What it does

- **Quick add:** the + at the top of every screen. Only the title is required, and the read date
  starts as today.
- **Suggestions:** pick from authors and categories you've already used, or from title and author suggestions from Open
  Library, with Google Books as an optional backup. Online suggestions can be turned off.
- **Book boxes:** one title with a count of the books inside. Each one read counts in your stats. Listing the titles inside is an option in Settings.
- **Ratings:** optional stars for the book and for each of its categories.
- **Global search:** the magnifying glass at the top of every screen searches titles, authors,
  categories and notes.
- **Library:** most recently read first, filtered by status, author, category or rating.
- **Stats:** totals, books per year, top authors and categories, and average stars per category.
- **Works offline on Android:** everything is saved on the phone first and syncs when it can. If a book was
  changed on two devices, the most recent change is kept.
- **Web app:** the full app in a browser, including admin features, served by your server at its own address. It needs a
  connection, and keeps nothing in the browser.
- **Family accounts:** an admin invites each person. Admins see how many books someone has, not what
  they are. An admin could sign in as someone with a password reset code, so the person is signed out and
  shown when codes were used. Anyone who runs the server can read its database.
- **Backups and exports:** nightly encrypted server backups to Nextcloud, optional daily personal
  exports to each person's own Nextcloud, CSV or JSON through Android's share menu or a browser download, and importing a
  JSON export back in.
- **Admin tools:** family accounts, server status, Back up now, Update and a log viewer in the app,
  plus a full terminal admin panel for SSH (`server/admin.sh`).
- **Appearance:** system, light or dark, with colour and gradient themes.

Planned for a later release: image backgrounds from Pexels.

## How it's built

| Part | Technology | Where |
|---|---|---|
| Android and web app | Expo / React Native, JavaScript. `*.web.js` files replace phone-only code in the browser build | repo root (`App.js`, `screens/`, `components/`, `contexts/`, `lib/`) |
| Server | Node, Express | `server/` |
| Database | PostgreSQL | `server/migrations/` |
| App builds | Self-hosted build server | `scripts/build-android.mjs` |

Authors and categories are stored as lists on each book, rather than in their own tables. Two
offline devices adding the same new author have nothing to reconcile, and a family-sized library
gains nothing from the extra tables.

## Local development

You need Node 24 and Docker.

1. Install dependencies:

   ```bash
   npm ci
   (cd server && npm ci)
   ```

2. Start a local database and server (the values here are for local development only):

   ```bash
   docker run -d --name readeez-dev-pg -e POSTGRES_DB=readeez -e POSTGRES_USER=readeez \
     -e POSTGRES_PASSWORD=dev -p 127.0.0.1:15436:5432 postgres:18-alpine
   cd server
   DATABASE_URL=postgres://readeez:dev@127.0.0.1:15436/readeez SECRETS_KEY=dev PORT=3020 node index.js
   ```

   Expected: `Readeez server v1.1.0 listening on port 3020`.

3. In another terminal, make your first account's invite code:

   ```bash
   cd server
   DATABASE_URL=postgres://readeez:dev@127.0.0.1:15436/readeez SECRETS_KEY=dev \
     node scripts/create-admin-invite.js
   ```

4. See the web app: build it, then restart the server pointing at it. The web app signs in with a cookie that only works
   from the server's own address, so `npm run web`'s separate development address can't sign in.

   ```bash
   npx expo export --platform web --output-dir dist
   cd server
   WEB_ROOT=../dist DATABASE_URL=postgres://readeez:dev@127.0.0.1:15436/readeez SECRETS_KEY=dev PORT=3020 node index.js
   ```

   Open `http://localhost:3020` and choose "I have an invite code".

5. Test native features (date picker, secure storage, sharing, keyboard) on Android: `EXPO_PUBLIC_API_URL=http://YOUR-PC-ADDRESS:3020 npm run android`.

## Tests and the security gate

```bash
npm test                  # app logic, no services needed
cd server && npm test     # server and security tests, against a real Postgres in Docker
npm run security          # the full security gate (needs Docker and gitleaks)
npm run security -- --commit   # the same, for approving a commit: fails on uncommitted files
```

Every release passes `npm run security -- --commit` with its results reviewed and approved. The `--` matters: without
it npm keeps the flag for itself, and the gate runs as a work-in-progress check, and says so. The approval is
recorded in the version's annotated git tag, and `server/update.sh` refuses any tag without it.

The sanitize check reads private names from a gitignored `.security-private-patterns` file, one
regular expression per line. Without that file, the check reports NOT RUN.

## APK size

Release APKs stay small through `expo-build-properties` in `app.json`: 64-bit ARM only, which covers essentially
every phone from the last decade, with R8 code shrinking and resource shrinking. Import icons from their own path
(`@expo/vector-icons/Ionicons`), because the package's main entry can pull every icon font into the APK. To
test on an x86_64 emulator, build with `-PreactNativeArchitectures=x86_64`, which overrides the setting.

## Dependency pins

`npm outdated` lists these as behind, on purpose. Expo SDK 58 pins them, so they're installed with
`npx expo install` and move when the SDK does:

- `@react-native-async-storage/async-storage`
- `@react-native-community/datetimepicker`
- `react` and `react-dom`

`package.json` and `server/package.json` also force newer `glob` and `minimatch` through npm `overrides`, because
Expo's CLI and ESLint still ask for versions with known advisories. Remove the overrides once those packages
catch up. The tests run on Vitest rather than Jest because Jest depends on `deepmerge`, which has an advisory and no
fixed release.

## Versioning

One version for the whole app, in `package.json`, `app.json` and `server/package.json`, bumped
together. `app.json`'s `android.versionCode` follows it: MAJOR×10000 + MINOR×100 + PATCH.
