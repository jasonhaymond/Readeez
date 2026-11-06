# Readeez admin guide

For whoever runs the family's Readeez server. It assumes comfort with SSH, but not with this app's
internals. [Back to the README](../README.md) · [Changelog](../CHANGELOG.md)

**Most things are one menu away:** run `server/admin.sh` over SSH. See
[section 12](#12-the-terminal-admin-panel).

**Status:** the steps below were tested end to end in a Linux container against a real Nextcloud:
setup, the admin panel, backup, restore, disaster recovery, and update refusals. Readeez hasn't been
deployed to a production host yet, so the reverse-proxy and firewall steps are untested as written.

## Contents

1. [What you're setting up](#1-what-youre-setting-up)
2. [Before you start](#2-before-you-start)
3. [Deploy with the setup script](#3-deploy-with-the-setup-script)
4. [Deploy by hand](#4-deploy-by-hand)
5. [Connect the reverse proxy and firewall](#5-connect-the-reverse-proxy-and-firewall)
6. [Create your account and invite the family](#6-create-your-account-and-invite-the-family)
7. [Build the Android app](#7-build-the-android-app)
8. [Update the server](#8-update-the-server)
9. [Roll back](#9-roll-back)
10. [Backups](#10-backups)
11. [Restore](#11-restore)
12. [The terminal admin panel](#12-the-terminal-admin-panel)
13. [Logs and health](#13-logs-and-health)
14. [Known limitations](#14-known-limitations)

## 1. What you're setting up

Two Docker containers: the API (`api`) and its own Postgres (`postgres`). The API listens on a
private port, and your reverse proxy provides HTTPS in front of it. The database has no published
port at all.

What holds data: the Postgres volume `readeez_pg_data`, and `server/.env`, which holds secrets.
Everything else comes from git.

## 2. Before you start

You need a Linux host with these installed. Check each one:

```bash
docker --version
docker compose version
git --version
gpg --version | head -1
curl --version | head -1
openssl version
```

Success: each prints a version. To install what's missing on Debian or Ubuntu:

```bash
sudo apt install git gnupg curl openssl
```

For Docker, follow <https://docs.docker.com/engine/install/>. Your account must be able to use it.
Test with `docker info`. If it says permission denied:

```bash
sudo usermod -aG docker "$USER"
# Then log out and back in.
```

You also need:

- A domain name pointing at your reverse proxy, e.g. `readeez.example.com`.
- A Nextcloud **app password** for backups, from Nextcloud's Personal settings, then Security.
- A password manager, to hold the backup passphrase.

Clone the repo as the non-root account that will run it:

```bash
git clone https://github.com/jasonhaymond/Readeez.git ~/Readeez
cd ~/Readeez
git checkout "$(git tag -l 'v*' --sort=-v:refname | head -n 1)"
```

Success: `git describe --tags` prints the newest version.

Now follow **either** section 3 (the script) **or** section 4 (by hand). They end in the same state.

## 3. Deploy with the setup script

```bash
cd ~/Readeez/server
bash setup.sh
```

It checks the prerequisites, then asks for:

| Question | What to answer |
|---|---|
| Port for the API | Accept the suggestion. It has already found a free one. |
| Reverse proxy here or other | `here` if Caddy runs on this machine. `other`, plus this machine's private address, if not. |
| Public address | `https://readeez.example.com` |
| Nextcloud address, user, app password | Where backups go. Leave the address empty to skip. |
| Type SAVED | Only after putting the shown passphrase in your password manager. |
| Schedule | `yes` adds the 3:00 nightly backup and the every-minute helper to this account's crontab. |

Success: `The API is running at http://...`, followed by an **Admin invite code**. Keep that code
for section 6, and continue at section 5.

## 4. Deploy by hand

This reaches the same end state as the script.

1. **Choose a free port.** List what's listening. Pick a port not shown, starting from 3020:

   ```bash
   ss -ltn
   ```

2. **Create the settings file:**

   ```bash
   cd ~/Readeez/server
   cp .env.example .env
   chmod 600 .env
   ```

3. **Generate the three secrets.** Run this three times, and use one result for each of
   `POSTGRES_PASSWORD`, `SECRETS_KEY` and `BACKUP_PASSPHRASE` in `.env`:

   ```bash
   openssl rand -hex 32
   ```

   **Save `BACKUP_PASSPHRASE` in your password manager now.** The backup contains `.env`, so it
   can't open itself. Without a separate copy of this value, no backup can ever be opened.

4. **Fill in the rest of `.env`:**

   ```ini
   READEEZ_PORT=3020
   # 127.0.0.1 if the proxy is on this machine. This machine's private address if it isn't.
   READEEZ_BIND=127.0.0.1
   TRUST_PROXY=1
   PUBLIC_URL=https://readeez.example.com
   BACKUP_NEXTCLOUD_URL=https://cloud.example.com
   BACKUP_NEXTCLOUD_USER=your-user
   BACKUP_NEXTCLOUD_APP_PASSWORD=your-app-password
   ```

5. **Start it:**

   ```bash
   docker compose up -d --build
   ```

6. **Check it**, using your port:

   ```bash
   curl http://127.0.0.1:3020/api/health
   ```

   Success: `{"status":"ok"}`.

7. **Schedule the nightly backup and the helper.** The helper is what makes the app's Back up now and
   Update buttons work. It opens no network port. Run `crontab -e` and add these two lines, using your
   real path. Or run `bash install-cron.sh`, which adds the same two lines.

   ```cron
   0 3 * * * PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; cd "/home/you/Readeez/server" && bash ./backup.sh >> backups/backup.log 2>&1 # readeez-backup
   * * * * * PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; cd "/home/you/Readeez/server" && bash ./host-agent.sh > /dev/null 2>&1 # readeez-agent
   ```

8. **Make your admin invite code:**

   ```bash
   docker compose exec api node scripts/create-admin-invite.js
   ```

   Success: it prints `Admin invite code: XXXX-XXXX-XXXX-XXXX`. It works once and expires in 7
   days. Keep it for section 6.

## 5. Connect the reverse proxy and firewall

These need root, so no script does them for you.

**Caddy** (the default). Add this to your Caddyfile, using your domain and port, and the private
address instead of `127.0.0.1` if Caddy is on another machine:

```caddy
readeez.example.com {
    reverse_proxy 127.0.0.1:3020
}
```

Then:

```bash
sudo systemctl reload caddy
```

**Nginx with certbot** also works. Proxy to the same address, and forward the real client address:

```nginx
location / {
    proxy_pass http://127.0.0.1:3020;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 13m;
}
```

**Check it** from another machine:

```bash
curl https://readeez.example.com/api/health
```

Success: `{"status":"ok"}`.

**Firewall.** Allow only SSH, 80 and 443 from the internet:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80
sudo ufw allow 443
sudo ufw enable
```

Never open the API port or 5432 to the internet.

**If Caddy is on another machine, `ufw` isn't enough, because Docker-published ports bypass it.** Traffic to a
container is routed before `ufw`'s rules apply, so a `deny` rule alone leaves the port open to your whole
network. Add a rule to Docker's own `DOCKER-USER` chain too. Here, `PROXY` is the proxy's address and `PORT` is
your API port. `--ctorigdstport` matches the published port as it arrived, since by this point Docker has
already rewritten it to the container's.

```bash
sudo ufw allow from PROXY to any port PORT proto tcp
sudo ufw deny PORT/tcp
sudo iptables -I DOCKER-USER ! -s PROXY/32 -p tcp -m conntrack --ctstate NEW --ctorigdstport PORT -j DROP
```

That `iptables` rule is lost on reboot. To make it permanent, create `/usr/local/sbin/readeez-docker-user-fw.sh`,
with mode 755:

```bash
#!/bin/sh
# Keeps the Readeez API port reachable only from the reverse proxy. -C checks whether the rule already exists.
iptables -C DOCKER-USER ! -s PROXY/32 -p tcp -m conntrack --ctstate NEW --ctorigdstport PORT -j DROP 2>/dev/null \
  || iptables -I DOCKER-USER ! -s PROXY/32 -p tcp -m conntrack --ctstate NEW --ctorigdstport PORT -j DROP
```

Replace `PROXY` and `PORT` in that script too. Then create `/etc/systemd/system/readeez-docker-user-fw.service`:

```ini
[Unit]
Description=Ensure Readeez DOCKER-USER firewall rule (API port, proxy only)
After=docker.service
Requires=docker.service
PartOf=docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/readeez-docker-user-fw.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
```

And enable it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now readeez-docker-user-fw.service
```

**Check it** from a machine that isn't the proxy, with the server's address and your port:

```bash
curl -m 5 http://SERVER:PORT/api/health
```

Success: it times out. From the proxy itself, the same command answers `{"status":"ok"}`.

**Check the security of the live server** from a machine with this repo:

```bash
bash scripts/security-check.sh --live https://readeez.example.com
```

Success: `RESULT: PASS`.

## 6. Create your account and invite the family

1. Install the app (section 7) and open it.
2. Choose **I have an invite code**, enter the admin code, your name, email and a password of at
   least 10 characters.
3. To add someone: ⋮ menu, Settings, **Family accounts**, **Invite someone**, or `server/admin.sh`,
   then Accounts. Give them the code, which is shown once, works once, and lasts 7 days.
4. If someone is locked out: **Reset code** next to their name. It's shown once and lasts 24 hours.
5. To remove someone: **Disable**. It signs them out everywhere and keeps their books. The terminal panel
   can also change someone's role, or permanently delete an account and its books.

If you're ever locked out of every admin account, make a new admin code in `server/admin.sh`: Accounts,
then Invite someone, with the role `admin`.

Admins can see each person's email and book count, and no titles or notes in the admin screens. Two things
go further, so be straight with your family about them:

- **A reset code signs in as that person.** Whoever redeems one can see that person's books. So redeeming one
  signs the person out and disconnects their Nextcloud, and at next sign-in they see the dates codes were used,
  which stay in Settings. A later reset can't hide an earlier one. Only deleting the account clears the list,
  which the terminal panel can do. Only issue a code when someone asks.
- **Anyone with access to the server or its backups can read the database.**

Disabling, demoting or deleting an admin cancels the unused codes they created, so a saved code can't be used
to get back in. So does that admin changing their password, or using a reset code. Invite codes made in the terminal
panel belong to no account, so they last until they're used or expire.

**After a suspected break-in on an admin account,** change its password, then check Family accounts for anyone you
don't recognise. A code that was already used can't be undone this way: its account has to be disabled or deleted.

**If someone is actively in an account,** disable it first, then issue the reset code, then enable it. Disabling ends
their sessions at once. Otherwise they could keep changing the password, and each change cancels your unused code.

## 7. Build the Android app

Builds run on your self-hosted build server, which clones from GitHub, so what's built must be
pushed first.

**One-time setup:**

1. On the build server, create a signing key named `readeez` (Profile, then Android signing keys).
   **Never replace this key.** Android only installs an update signed by the same key as the
   installed app, so a new key means everyone uninstalling and setting up again.
2. Create an API key with the scopes `build:create`, `build:read`, `build:logs`,
   `artifact:download` and `signing:use`.
3. On the machine that runs builds, create the settings file and fill it in. Keep the credentials
   on that machine.

   ```bash
   cp .env.example .env
   chmod 600 .env
   ```

**To build a released version:**

```bash
npm run build:android -- --ref v1.0.3
```

A release build must be an approved version tag: anything else is refused. Use `--debug` for a test build.

Success: it ends with `✔ dist-android/...apk`. The build is also on the build server's dashboard.

**Before giving a build to the family**, install it on a test device or emulator and check that it
opens and signs in. Release builds shrink code in ways that development builds don't, and that can
surface crashes only a release build shows. For an emulator build, use `--abi x86_64`.

To install on a phone, allow installs from your browser or file manager when Android asks, then open
the APK.

## 8. Update the server

```bash
cd ~/Readeez
bash server/update.sh
```

It deploys the newest released version. It refuses to run over uncommitted changes, refuses a version
with no recorded security approval, backs up first, rebuilds, applies database changes, and confirms
the new version is really serving. If `PUBLIC_URL` is set, it also runs the live security check.

Success: `Now running vX.Y.Z`, then `RESULT: PASS`.

You can also update from the app (Settings, then **Server**, then **Update server**, typing UPDATE to
confirm) or from `server/admin.sh`. All three run this same script. The app's button needs the helper
scheduled, and starts within a minute.

Keep the app and server on the same version: build and share a new APK with each release.

## 9. Roll back

```bash
cd ~/Readeez
bash server/update.sh v1.0.0
```

**This always restores the code exactly. It doesn't touch the database.**

- If the schema didn't change between the two versions (see the **Schema** notes in the
  [changelog](../CHANGELOG.md)), or changes were only additions, you're done.
- If a column or table was renamed, removed or tightened, the old code can break against the current
  database. The only real fix is restoring a backup from that version (section 11), which
  **discards everything added since**. Nothing does this automatically. It's your decision.

To return to the newest version afterward, run `bash server/update.sh` with no version.

## 10. Backups

**What a backup holds:** the whole database and `server/.env`, in one encrypted file (GPG, AES-256)
named after the version that was running, e.g. `readeez-v1.0.0-20261104-030000.tar.gz.gpg`.

**Where they go:** `server/backups/` (the newest 14) and your Nextcloud's `Readeez-backups` folder
(the newest 30). Change these with `BACKUP_KEEP_LOCAL` and `BACKUP_KEEP_REMOTE`.

**When they run:** nightly at 3:00 if you scheduled it, and before every update and restore.

**To run one now:** use **Back up now** in the app's Server panel, `server/admin.sh`, or:

```bash
cd ~/Readeez/server
bash backup.sh
```

Success: it prints the file's path. Exit code 3 means the local file is fine, but the Nextcloud copy
failed.

**How to check:** Settings, then **Server**, in the app shows the last backup and whether it reached
Nextcloud. On the server, `backups/backup.log` holds the nightly output.

**What you could lose:** up to 24 hours of changes that exist only on the server, which is little in
practice, because each phone also holds a copy of its owner's library. A restore takes a few minutes.

**Personal exports** are separate. Each person can connect their own Nextcloud under Settings, then
**Nextcloud**, for a daily JSON and CSV copy in `Readeez/<their email>/`, keeping 7 days. Those are for
the person's own records. To bring one back: Settings, then **Import a JSON export**. Books edited more
recently are left alone, and deleted books come back. Changing a password or using a reset code disconnects
that person's Nextcloud, so anyone who had access can't keep receiving their books. They reconnect it in Settings.

**A private-network Nextcloud** for personal exports must be listed in
`NEXTCLOUD_ALLOWED_PRIVATE_HOSTS`, otherwise it's refused, so accounts can't use this server to reach
your internal network. Backups from `backup.sh` aren't subject to this: only you configure those.
Use `https://` for `BACKUP_NEXTCLOUD_URL`, since the app password is sent with each request.

## 11. Restore

Restores run on the server, never from the app, because a restore replaces the database the app talks to.
In `server/admin.sh`, choose Backups and restore. It can also download a backup from Nextcloud first.

**To restore on the same machine by command:**

```bash
cd ~/Readeez/server
ls -1t backups/
bash restore.sh backups/readeez-v1.0.0-20261104-030000.tar.gz.gpg
```

It shows the backup's version, asks you to type `RESTORE`, takes a safety backup of the current data,
replaces the database, and restarts the API. **Everything added since that backup is discarded**,
unless a phone still holds it (see below).

Success: `Restore complete. Data from v1.0.0, now running v1.0.0, with N books.`

**To recover onto a new machine:**

1. Do section 2, on the new machine.
2. Check out the version the backup came from:

   ```bash
   cd ~/Readeez
   git checkout v1.0.0
   ```

3. Download the backup file from Nextcloud's `Readeez-backups` folder to `~/`.
4. Run the restore, and paste the passphrase from your password manager when asked:

   ```bash
   cd server
   bash restore.sh ~/readeez-v1.0.0-20261104-030000.tar.gz.gpg
   ```

   With no `.env` present, it restores that from the backup as well.

5. Do section 5, then point your domain at the new machine.

Success: the same message as above, and signing in works.

**What phones do after a restore:** the restore marks the database as restored, so on their next sync
phones download its current state and send back any books the server no longer has. Books added since
the backup usually return that way, as long as a phone that holds them syncs.

## 12. The terminal admin panel

For managing everything over SSH, with no commands to remember:

```bash
cd ~/Readeez/server
bash admin.sh
```

The top of the screen shows the API's health and version, account and book counts, the last backup, and
whether the helper is running. The menu covers:

| Menu | What's there |
|---|---|
| Accounts | List, invite, password reset code, disable, enable, make admin or member, delete |
| Backups and restore | Back up now, list, download from Nextcloud, restore, nightly log |
| Update or roll back | Choose a version, with a warning about what a rollback does and doesn't do |
| Logs | Last 100 lines, warnings and errors only, follow live, database logs |
| Health | Containers, API, disk space, backup size |
| Settings | Everything in `server/.env`, with secrets shown only as "set" or "not set" |
| Check security | The live checks against your public address |
| Schedule | Adds the nightly backup and the helper to this account's crontab |
| Start or restart | Brings the containers up |

Run it as the account that owns the checkout, without `sudo`. Having SSH access to that account is what
authorizes it, so protect that account accordingly. Anything hard to undo asks you to retype a word first,
and each action runs the same scripts this guide documents.

**What the panel can do that the app can't, on purpose:** restoring, deleting accounts and changing roles.

## 13. Logs and health

The app's **Server** panel has a **View logs** screen, covering what's happened since the server last
started, plus request counters. For the longer history, use `server/admin.sh` or these commands:

```bash
cd ~/Readeez/server
docker compose logs --tail 100 api      # recent lines
docker compose logs -f api              # follow live
docker compose ps                       # are both containers running and healthy?
curl http://127.0.0.1:3020/api/health   # your port; {"status":"ok"} means the API and database work
```

Lines look like `2026-11-04T03:00:00.000Z INFO [http] POST /api/sync 200`. Docker caps logs at about
30 MB per service. Passwords, tokens and book contents are never logged.

`/api/health` needs no sign-in, so an uptime monitor can point at it. It says only up or down.

## 14. Known limitations

- **Editing the same book on two devices** keeps only the most recent edit, for the whole book. Fields
  aren't merged.
- **Import reads JSON exports only.** CSV is for spreadsheets, and can't restore a book's id.
- **There's no staging environment.** For a family-sized library, the pre-update backup and rollback cover
  a bad deploy. Add one if that stops being true.
