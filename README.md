# grokbot-headless

[![CI](https://github.com/andreanjos/grokbot-headless/actions/workflows/ci.yml/badge.svg)](https://github.com/andreanjos/grokbot-headless/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Run the official Grok Bot local-computer daemon on a Linux host without the Electron chat window, a renderer, X11, Wayland, or Xvfb.

`grokbot-headless` is a small, unofficial management layer. It authenticates, starts, and supervises the local-execution daemon that is already present in the official Grok Bot Linux package. It does not replace Grok Bot and does not include proprietary Grok Bot code.

> [!WARNING]
> This project uses an internal Grok Bot protocol. xAI does not publish this protocol as a stable public API. A Grok Bot update can require a matching controller update.

## Contents

- [How it works](#how-it-works)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Execution policy](#execution-policy)
- [Commands](#commands)
- [Compatibility checks](#compatibility-checks)
- [Updates](#updates)
- [Service operation](#service-operation)
- [Files and credentials](#files-and-credentials)
- [Security](#security)
- [Custom paths](#custom-paths)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Uninstall](#uninstall)
- [Legal status](#legal-status)

## How it works

The official Grok Bot desktop application normally performs these tasks:

1. Authenticate the user.
2. Register the local computer.
3. Request short-lived daemon credentials.
4. Start the official local-execution daemon.
5. Send startup data through Node IPC.
6. Renew credentials and restart the daemon when necessary.

This project performs only those management tasks. It starts the official daemon with `ELECTRON_RUN_AS_NODE=1`, which does not create an Electron window or renderer.

```text
Grok Bot service
       |
       | authenticated internal protocol
       |
grokbot-headless controller
       |
       | Node IPC bootstrap and supervision
       |
official local-exec-daemon
       |
       | approved commands and file operations
       |
Linux user account
```

### Included

- browser-link OAuth with PKCE
- machine identity creation
- daemon and user-computer credential minting
- automatic credential renewal
- official daemon IPC bootstrap
- supervisor heartbeat
- repeated daemon restart handling
- local compatibility checks
- an authenticated remote protocol check
- a systemd user service

### Not included

- the Grok Bot application or daemon
- a replacement Grok Bot model or service
- a local chat user interface
- root access
- automatic approval of local actions unless you select `policy always`
- a guarantee that future internal protocols will remain compatible

## Requirements

- Linux
- Node.js 20 or newer
- systemd user services
- the official Grok Bot Linux application
- a Grok Bot account with local-computer access

The default application location is:

```text
/opt/Grok Bot
```

The current compatibility data lists the official Grok Bot Linux package `0.30.0` as tested. A different version can still work if all structural and remote protocol checks pass.

## Quick start

Clone the public repository:

```bash
git clone https://github.com/andreanjos/grokbot-headless.git
cd grokbot-headless
```

Install the controller and enable its systemd user service:

```bash
./install.sh
```

The installer runs a local compatibility check before it changes installed files. It does not start the service because account credentials do not exist yet.

Authenticate:

```bash
grok-bot-headless login
```

The command prints a one-time URL. Open the URL in any browser and complete authentication. Do not share the URL or the resulting credential files.

Select an execution policy:

```bash
grok-bot-headless policy ask
```

Start the service:

```bash
systemctl --user start grok-bot-headless
```

Verify it:

```bash
grok-bot-headless check
grok-bot-headless status
```

If your shell cannot find `grok-bot-headless`, start a new shell or use:

```bash
~/.local/bin/grok-bot-headless
```

### Start at boot without an interactive login

The installer enables the user service. To let the user service start during boot before desktop login, enable systemd lingering once:

```bash
sudo loginctl enable-linger "$USER"
```

## Execution policy

The policy controls how the official daemon handles local tool requests. The command registers the machine and synchronizes the same policy with the backend machine roster. Run it once after `login` and before the first service start. It is the only command that registers the machine.

| Policy | Behavior | Recommended use |
| --- | --- | --- |
| `ask` | Ask before local actions. | Normal use. |
| `always` | Run local actions without an individual approval prompt. | Dedicated or isolated hosts only. |
| `never` | Reject local actions. | Disable remote local-computer access. |

Set a policy with:

```bash
grok-bot-headless policy <always|ask|never>
systemctl --user restart grok-bot-headless
```

> [!CAUTION]
> `policy always` lets Grok Bot run commands and access files as your Linux user without an individual prompt. If that user has passwordless `sudo`, a remote command can also gain root access.

## Commands

| Command | Purpose |
| --- | --- |
| `grok-bot-headless login` | Complete browser-link OAuth and save account credentials. |
| `grok-bot-headless run` | Run the controller in the foreground. The systemd service normally uses this command. |
| `grok-bot-headless status` | Show machine, daemon, policy, and credential-expiry state as JSON. |
| `grok-bot-headless check --local` | Check the installed package without network access or account credentials. |
| `grok-bot-headless check` | Check the installed package, authentication, and remote credential protocol. |
| `grok-bot-headless policy <value>` | Set `always`, `ask`, or `never`. |
| `grok-bot-headless logout` | Stop the managed service and remove OAuth and active daemon credentials. |

`logout` refuses to remove credentials if a directly started daemon remains active. Stop that foreground process first.

## Compatibility checks

Run the full check after each official Grok Bot package update:

```bash
grok-bot-headless check
```

The full check:

1. Reads the exact installed package version.
2. Confirms that the official application and archive exist.
3. Resolves the expected daemon entry point from the installed archive.
4. Validates the saved OAuth credential format.
5. Refreshes OAuth credentials when required.
6. Requests both required runtime credentials from the current backend and writes them to the runtime data directory. A running service replaces this file again at its next renewal.

It does not send a shell command or file request through Grok Bot.

Example:

```json
{
  "compatible": true,
  "installedVersion": "0.30.0",
  "testedVersion": true,
  "daemonEntryPoint": "verified",
  "authentication": "verified"
}
```

Use the local-only check before login or without network access:

```bash
grok-bot-headless check --local
```

The installer runs the local check before installation. The systemd service runs it as an `ExecCondition` before each start. If this condition fails, the service stays stopped and does not enter its restart loop.

`testedVersion: false` means that the exact package version is not in the tested-version list. It does not mean that the check failed. The structural and remote checks determine the compatibility result.

## Updates

### Update this controller

```bash
cd /path/to/grokbot-headless &&
  git pull --ff-only &&
  ./install.sh &&
  grok-bot-headless check &&
  systemctl --user restart grok-bot-headless
```

The update keeps OAuth credentials, the machine identity, runtime data, and the selected policy.

### After an official Grok Bot update

```bash
grok-bot-headless check &&
  systemctl --user restart grok-bot-headless &&
  systemctl --user status grok-bot-headless --no-pager
```

If the check fails, do not bypass it. Record the installed Grok Bot version and the redacted error, then open a GitHub issue.

## Service operation

Show service state:

```bash
systemctl --user status grok-bot-headless --no-pager
```

Restart or stop the service:

```bash
systemctl --user restart grok-bot-headless
systemctl --user stop grok-bot-headless
```

Follow logs:

```bash
journalctl --user -u grok-bot-headless -f
```

Show recent logs:

```bash
journalctl --user -u grok-bot-headless -n 100 --no-pager
```

The service uses `Restart=on-failure`. The controller also restarts the daemon if the daemon exits while the controller remains active.

## Files and credentials

### Source checkout

The source remains in the directory where you ran `git clone`. This README uses `/path/to/grokbot-headless` when that location is not known.

### Installed files

```text
~/.local/bin/grok-bot-headless
~/.local/lib/grok-bot-headless/grok-bot-headless.mjs
~/.config/systemd/user/grok-bot-headless.service
~/.config/grok-bot-headless/environment
```

### Account configuration

```text
~/.config/grok-bot-headless/credentials.json
~/.config/grok-bot-headless/machine.json
```

### Runtime data and policy

```text
~/.local/share/grok-bot-headless/
```

Credential and environment files use owner-only permissions. New private directories use owner-only access.

OAuth credentials are stored as plaintext JSON because a portable headless Linux host does not always have a desktop keyring. Protect the user account, home directory, backups, and process environment. Never commit these directories or attach their contents to an issue.

## Security

Use the least privilege that supports your work:

1. Start with `policy ask`.
2. Use a dedicated Linux account or isolated host when possible.
3. Do not give the service user passwordless `sudo` unless remote root access is intentional.
4. Keep the official Grok Bot package and this controller current.
5. Review service logs and active sessions.
6. Run `grok-bot-headless logout` when you remove the host from service.

Do not publish:

- OAuth access or refresh tokens
- one-time login URLs
- daemon credentials
- authorization headers
- complete machine identity files
- unredacted service logs

Use GitHub private vulnerability reporting for security defects. See [SECURITY.md](SECURITY.md).

## Custom paths

If the official package uses different paths, pass them during installation:

```bash
GROK_BOT_BINARY=/path/to/grok-bot \
GROK_BOT_DAEMON_SCRIPT=/path/to/local-exec-daemon/main.cjs \
./install.sh
```

The installer saves these paths in:

```text
~/.config/grok-bot-headless/environment
```

For direct CLI development runs, export the same values in the shell.

API and website URLs can also be overridden for development:

```bash
export CURSOR_API_BASE_URL=https://api.example.test
export CURSOR_WEBSITE_URL=https://example.test
```

The backend endpoint receives OAuth credentials. Use only a server that you control and trust. The controller requires HTTPS.

For a local development server only, HTTP can be enabled for `localhost`, `127.0.0.1`, or `::1`:

```bash
export GROK_BOT_ALLOW_INSECURE_LOCALHOST=1
```

## Troubleshooting

### `grok-bot-headless: command not found`

Confirm that `~/.local/bin` is in `PATH`:

```bash
printf '%s\n' "$PATH"
```

You can run the installed command directly:

```bash
~/.local/bin/grok-bot-headless status
```

### No account credentials

Run:

```bash
grok-bot-headless login
```

Then restart the service:

```bash
systemctl --user restart grok-bot-headless
```

### Compatibility check fails

Collect these results:

```bash
grok-bot-headless check --local
systemctl --user status grok-bot-headless --no-pager
journalctl --user -u grok-bot-headless -n 100 --no-pager
```

Remove tokens, credentials, machine IDs, email addresses, and private file contents before you share output.

### The computer does not appear in Grok Bot

Check the service and daemon:

```bash
grok-bot-headless status
systemctl --user is-active grok-bot-headless
```

Then run the authenticated check:

```bash
grok-bot-headless check
```

If authentication has expired, run `grok-bot-headless login` again.

### The service does not start during boot

Check lingering:

```bash
loginctl show-user "$USER" -p Linger
```

Enable it if necessary:

```bash
sudo loginctl enable-linger "$USER"
```

## Development

No third-party Node.js runtime dependency is required.

Run the complete test suite:

```bash
npm test
```

Run syntax and unit-file checks:

```bash
node --check grok-bot-headless.mjs
bash -n install.sh uninstall.sh bin/grok-bot-headless test/install.test.sh
systemd-analyze --user verify grok-bot-headless.service
```

The test suite includes pure protocol-helper tests, an isolated installer test, and an end-to-end test. The end-to-end test runs the CLI against a fake backend server and a fake daemon on the loopback interface. The tests use fake application and systemd commands. They do not contact Grok Bot.

Before you submit a change:

1. Keep the controller separate from proprietary Grok Bot code.
2. Do not add extracted application bundles or credentials.
3. Add a deterministic test for protocol changes when possible.
4. Run the complete test suite.
5. Explain the tested official package version in the pull request.

## Uninstall

Remove the controller and service, but keep credentials and runtime data:

```bash
./uninstall.sh
```

Remove the controller, service, credentials, machine identity, policy, and runtime data:

```bash
./uninstall.sh --purge
```

The uninstall command does not remove the official Grok Bot application.

## Legal status

This is an independent, unofficial project. It is not endorsed by xAI, SpaceXAI, Cursor, or Anysphere.

Grok Bot and related names can be trademarks of their owners. Use the official application and service under their applicable terms.

The original controller code in this repository is available under the [MIT License](LICENSE).
