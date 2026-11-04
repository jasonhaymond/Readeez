# Changelog

All notable changes to Readeez are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

[Back to the README](README.md)

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
