# Changelog

All notable changes to Readeez are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

[Back to the README](README.md)

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
- Rate-limit counts now live in the database, so a restart no longer gives anyone fresh sign-in attempts. Signed-in
  sync requests now have a limit too, of 600 per account per 15 minutes.
- Cleared every `npm audit` finding: forced fixed versions of `glob` and `minimatch`, and moved the tests from Jest to
  Vitest, because Jest depends on `deepmerge`, which has no fixed release.

### Changed

- A smaller APK: 64-bit ARM only with code and resource shrinking, and only the one icon font the app uses.

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
