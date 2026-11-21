# Changelog

All notable changes to Readeez are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

[Back to the README](README.md)

## [1.2.1] - 2026-11-20

### Changed

- Dependency updates (patch, no behavior change intended): expo 58.0.26, expo-file-system
  58.0.14, @react-navigation/native 7.5.2, @react-navigation/native-stack 7.21.1,
  vitest 5.1.1; server: express-rate-limit 8.7.5, vitest 5.1.1.

### Fixed

- **Android APK file names always say which processor they run on**, e.g.
  `Readeez-v1.2.1-arm64-v8a-release.apk` (phones) and `…-x86_64-release.apk`
  (emulator), so the emulator build can't be installed on a phone by mistake ("not
  compatible"). Build server 2.10.0 names them this way on its dashboard too;
  `npm run build:android` keeps its name rather than adding the processor twice.
- `npm run build:android` says why the build server couldn't be reached (e.g.
  `ENOTFOUND`, `ECONNREFUSED`, a certificate error) instead of only "fetch failed".

### Security

- `npm run build:android` only saves a download under a plain file name: a name sent
  by the build server such as `../../x` could otherwise have written outside
  `dist-android/`.

## [1.2.0] - 2026-11-14

### Added

- **Series**: an optional series name under a book's title, shown in italics in the library. Series already used are
  suggested while typing, search finds books by series, and the library filter can show one series.
- **Books read before Readeez**: a count of books read in a year before using the app, added from Stats under
  "Before Readeez". It adds to the books read total and books per year, but not to authors, categories or ratings,
  and isn't listed in the library. Each year has one count, even when two phones add it offline.
- **Filter by read date**: all time, one year, or a custom from/to range, in the library filter and at the top of
  Stats. Stats totals, top authors, categories and ratings follow the chosen period. A year count is only included in
  a custom range that covers its whole year.
- Exports (CSV and JSON) and imports carry series and year counts.

### Changed

- Admin per-person book counts leave out year counts.
- Database migration 005 adds the `series`, `kind` and `tally_count` columns. It only adds columns, so existing books
  are kept.

### Notes

- Phones still on 1.1.0 show a year count as a single book. Editing one there is refused by the server, so the count
  can't be damaged; update the app to see it properly.

## [1.1.0] - 2026-11-06

### Added

- **A web app**: the full app in a browser, with the same screens as Android, including the family and server panels for
  admins. The server serves it from its own address, so there's nothing extra to host or proxy. It needs a connection:
  books stay in the open page rather than being stored in the browser, and a change that can't reach the server is
  refused and undone. Exports download as files.
- **Choose saved authors and categories** on the book form, without typing.
- **Online title and author suggestions** while adding a book, from Open Library. Choosing a title fills in its
  authors. Google Books can be added as a backup by setting `GOOGLE_BOOKS_API_KEY` on the server. Lookups go through
  the server, are limited per account, and can be turned off in Settings or for everyone with `BOOK_LOOKUP_ENABLED=false`.
  Kindle isn't the source because Amazon's API requires affiliate sales, and its licence doesn't cover an app like this.
- **Category ratings**: optional stars for each of a book's categories, averaged per category in Stats.
- **Book boxes**: one title with a count of the books inside and how many are read. Each book read counts in Stats,
  even before the box is finished. Listing the titles inside is optional, and off until chosen in Settings.
- Exports and imports carry category ratings, box counts and box titles. Older export files still import.

### Changed

- The Stats tile "Finished" is now "Books read", since a box counts for each book read from it.
- The server's Docker image is now built from the repo's top folder, because it includes the web app. The build takes
  longer, and the running image gains only the finished web files.
- On Android, the field being typed in now scrolls above the keyboard on the book, sign-in and Nextcloud forms. Fields low
  on a form could otherwise sit hidden behind it.
- The Library screen now shows a load or sync error above the list, however many books there are. Earlier, it
  disappeared once the list had a book.

### Security

- Browser sessions use a cookie page scripts can't read (`HttpOnly`, `Secure`, `SameSite=Strict`, `__Host-` prefix). A browser
  stays signed in for 365 days after it was last used, so anyone on a shared computer needs to sign out. Requests that
  change something must also prove they come from Readeez's own page, which stops forged requests from other websites,
  including forged sign-ins. If the server can't be reached at sign-out, the browser says so and stays signed in, rather
  than showing the sign-in screen with the session still valid.
- Web pages have a strict content policy allowing only this site's own scripts. The API keeps its "allow nothing" policy.
- Disabling an account now cancels any unused reset code made for it earlier, so an old code can't take the account over
  once it's enabled again. A code made after disabling still works, as the admin guide's lockout steps need.
- A sync still running at sign-out can no longer write the person's encrypted books back to the phone.
- A brief Keystore failure no longer looks like damaged books, which cleared the sync position and could replace unsent
  edits with the server's copies. It now reports the failure and changes nothing.
- Exporting or importing after a failed load is now refused. It would have made an empty export, or planned an import against an empty list.
- Android 13 and later no longer keep a picture of the app in the recent-apps screen, which could show notes. They show a
  blank card once the app is in the background.
- A file that won't delete no longer stops the other leftover export files being removed.
- The live security check now also covers the web page's policy, the no-store rule on private routes, and the lookup route.
  A work-in-progress gate run no longer prints a result beginning `RESULT: PASS`, so it can't be mistaken for an approval.

### Schema

- `004_boxes_ratings_web_sessions.sql` adds `books.box_total`, `books.box_read`, `books.box_titles`, `books.category_ratings` and
  `sessions.web`. All are additions, so rolling back the code to 1.0.3 is safe without restoring the database.

## [1.0.3] - 2026-11-05

The first release to be deployed. Versions 1.0.0 to 1.0.2 were pushed, but never tagged or deployed.

### Security

- A password reset or change now ends other sessions, the Nextcloud link, and unused codes the person made or that
  were made for them, together in one transaction. Before this, an admin invite made during brief access to an
  account survived the password change and could create a permanent admin.
- Codes are only created after re-checking that the request still comes from a working admin, so one created while
  access is ending can't survive.
- A password change already underway can no longer overwrite a newer reset.
- A sign-in overlapping a password change no longer gets a session from the old password.
- A Nextcloud connection request held open across a password change can no longer restore the link. Requests to
  Nextcloud also have an overall time limit.
- Books, notes and the signed-in person's details are now encrypted on the phone, with a key protected by Android's Keystore.
- Every API response now tells the phone not to save a copy, and the app asks for the same. Android was keeping
  plain-text copies in the app's cache folder, including names and emails, and for admins the family list and logs,
  which signing out didn't clear.
- Export and import copies left by the app being stopped mid-share are now removed when it next starts and at sign-out,
  and a failed export no longer leaves a partial file.
- Rate-limit counts now live in the database, so a restart no longer gives anyone fresh sign-in attempts. Signed-in
  sync requests now have a limit too, of 600 per account per 15 minutes.
- Cleared every `npm audit` finding: forced fixed versions of `glob` and `minimatch`, and moved the tests from Jest to
  Vitest, because Jest depends on `deepmerge`, which has no fixed release.

### Added

- The app's logo, an open book with a gold ribbon: on the launcher (including Android's themed icons), the splash
  screen, the sign-in and Library screens, the browser tab and the README. One master drawing, `assets/logo.svg`,
  generates every icon through `scripts/make-icons.mjs`.

### Changed

- A smaller APK: 64-bit ARM only with code and resource shrinking, and only the one icon font the app uses.

### Fixed

- A password reset and a password change at the same moment could deadlock and fail with a server error. They now
  take their locks in the same order, as does issuing a reset code. A rare deadlock that ordering can't rule out, such
  as two admins using each other's codes at once, now rolls back and asks the person to try again.
- A reset code issued while a password change was waiting could survive that change. It's now cancelled.
- A local book that can't be decrypted is kept rather than deleted, and the copy of an import file is deleted after
  reading. A book that stays unreadable no longer re-downloads the library at every launch, and failing to delete the
  import copy no longer fails the import.
- The admin guide's steps for an account someone else is using now keep the account disabled until the code is used.
- A database failure while taking back a rate-limit count can no longer stop the server.
- A sync can no longer start while the library is still loading from the phone. A book saved during loading now stays
  in the list and syncs, and a failure to load is shown on the Library screen.
- The security gate now fails if any test is skipped, and its new `--commit` mode fails if there are uncommitted
  files, if git can't report that, or if the commit changes mid-run, since its results would then describe something
  other than the commit being approved. Without `--commit`, the result says it isn't approval for a commit.

### Schema

- Added `rate_limits` (`003_rate_limits.sql`). Additive: older code runs against it.

## [1.0.2] - 2026-11-04

### Security

- A password reset or password change now disconnects Nextcloud and erases its stored app password. Before
  this, someone who briefly had access to an account could point its daily export at their own Nextcloud, and
  keep receiving the person's books after losing access.
- The reset history now counts uses past the newest 20, so the list can't quietly lose older ones.

### Schema

- No changes.

## [1.0.1] - 2026-11-04

### Security

- A removed admin can no longer get back in with a saved code: disabling, demoting or deleting an admin
  cancels the unused invite and reset codes they created.
- Corrected the privacy wording. Admins don't see anyone's books in the app, but one could sign in as
  someone by using a password reset code on their account. The person now sees the dates codes were used, at
  next sign-in and in Settings. A later reset can't hide an earlier one, and only deleting the account clears the list.
- Android release builds must now be an approved version tag, the same check the server's updates make.
- Control characters are removed from names and refused in emails, so an account can't rewrite what an admin
  sees in the terminal panel.

### Changed

- The admin guide now covers Docker bypassing `ufw` when the reverse proxy is on another host.

### Schema

- No changes.

## [1.0.0] - 2026-11-04

### Added

- First version of the Android app: library, quick add from anywhere, global search, stats, and
  book details with multiple authors and categories, status, an optional 1 to 5 star rating, a read
  date that defaults to the day of entry, and notes.
- Offline-first sync, where the most recent edit wins.
- Family accounts by admin invite, with private libraries, password reset codes, and account
  disabling.
- System, light and dark modes, with five colour themes and four gradient themes.
- CSV and JSON export through Android's share menu, and importing a JSON export back in.
- Personal daily exports to each person's own Nextcloud.
- Encrypted nightly server backups, copied to Nextcloud, with tested restore and disaster recovery.
- In the app, for admins: family accounts, server status and request counters, Back up now and Update
  buttons, and a log viewer. In-app help for everyone.
- A terminal admin panel for managing the server over SSH (`server/admin.sh`): accounts, including role
  changes and deletion, backups, restore, updates, rollback, logs, health and settings.
- Setup, update, backup and restore scripts, and a security gate.

### Schema

- Initial schema (`001_initial.sql`), and admin jobs with a restore marker (`002_admin_jobs.sql`).
