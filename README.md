# grokbot-headless

An unofficial native headless controller for the local-computer daemon included with the Grok Bot Linux application.

It lets a Linux host appear as a local computer in Grok Bot without starting the Electron chat window, a renderer, X11, Wayland, or Xvfb.

> [!WARNING]
> This project uses an internal Grok Bot protocol. xAI does not publish this protocol as a stable public API. A Grok Bot update can break this controller.

## What it does

The official Grok Bot package includes a local execution daemon. The desktop application normally authenticates, starts, and supervises that daemon. This project supplies only those management functions:

- browser-link OAuth with PKCE
- machine identity creation
- local daemon and user-computer credential minting
- credential renewal
- daemon IPC bootstrap
- supervisor heartbeat
- process restart handling
- a systemd user service

It does not contain or redistribute Grok Bot code. You must install the official Grok Bot Linux application separately.

## Requirements

- Linux
- Node.js 20 or newer
- systemd user services
- the official Grok Bot Linux application at `/opt/Grok Bot`
- a Grok Bot account with local-computer access

The controller was developed against the official Grok Bot `0.30.0` Linux package. Other releases can use a different internal protocol.

## Install

```bash
git clone https://github.com/andreanjos/grokbot-headless.git
cd grokbot-headless
./install.sh
```

Authenticate without opening the Grok Bot desktop client:

```bash
grok-bot-headless login
```

The command prints a one-time URL. Open it in any browser and complete authentication.

Choose a local execution policy:

```bash
# Ask before local actions
grok-bot-headless policy ask

# Run local actions without individual approval prompts
grok-bot-headless policy always

# Block local actions
grok-bot-headless policy never
```

Start the node:

```bash
systemctl --user start grok-bot-headless
```

To start it at boot before an interactive login:

```bash
sudo loginctl enable-linger "$USER"
```

## Commands

```text
grok-bot-headless login
grok-bot-headless run
grok-bot-headless status
grok-bot-headless check [--local]
grok-bot-headless policy <always|ask|never>
grok-bot-headless logout
```

`logout` stops the managed user service before it removes local credentials. It refuses to remove them if a directly started daemon is still active.


Service commands:

```bash
systemctl --user status grok-bot-headless
systemctl --user restart grok-bot-headless
journalctl --user -u grok-bot-headless -f
```

## Compatibility checks

Run the full check after the official Grok Bot package updates:

```bash
grok-bot-headless check
```

The check reads the installed version, resolves the daemon entry point from the installed package, validates the saved credential format, contacts the current backend, and mints both required runtime credentials. It makes no shell or file request through Grok Bot.

Use the local-only check before account login or without network access:

```bash
grok-bot-headless check --local
```

The installer runs the local check before it changes installed files. The systemd service runs it again before each start. An incompatible local package stops the installation or service start with an error. A full check stops with an error if authentication or the remote credential protocol fails.

The JSON result includes `testedVersion`. A value of `false` means that the exact package version is new. It does not mean that the package failed. The structural and remote checks determine the compatibility result.

## Architecture

```text
Grok Bot service
       |
       | authenticated internal protocol
       |
grok-bot-headless controller
       |
       | Node IPC bootstrap and supervision
       |
official local-exec-daemon
       |
       | commands and files
       |
Linux host
```

The official Grok Bot executable runs the daemon with `ELECTRON_RUN_AS_NODE=1`. This mode does not create a chat window or renderer.

## Data and credentials

The controller stores OAuth credentials here:

```text
~/.config/grok-bot-headless/credentials.json
```

It stores runtime data and local policy here:

```text
~/.local/share/grok-bot-headless/
```

These files use owner-only permissions. The OAuth credentials are stored as plaintext JSON because a portable headless Linux system does not always have a desktop keyring. Protect the user account and home directory.

Do not commit either data directory.

## Security

`policy always` gives Grok Bot permission to run commands and access files as the service user without a prompt for each action. Use a dedicated Linux account or isolated host when possible.

This controller does not grant root access. However, passwordless `sudo` for the service user can let remote commands become root commands. Review the host sudo policy before you use `policy always`.

Use `policy ask` when you need per-action approval.

## Custom paths

If the official package uses different paths, pass them when you install. The installer saves them for the systemd service:

```bash
GROK_BOT_BINARY=/path/to/grok-bot \
GROK_BOT_DAEMON_SCRIPT=/path/to/local-exec-daemon/main.cjs \
./install.sh
```

API and website URLs can also be overridden for direct development runs:

```bash
export CURSOR_API_BASE_URL=https://api.example.test
export CURSOR_WEBSITE_URL=https://example.test
```

The backend endpoint receives your OAuth credentials. Use only a server that you trust. The controller requires HTTPS. For a local development server only, set `GROK_BOT_ALLOW_INSECURE_LOCALHOST=1` to permit HTTP on `localhost`, `127.0.0.1`, or `::1`.

## Uninstall

Keep credentials and runtime data:

```bash
./uninstall.sh
```

Remove all local credentials and runtime data:

```bash
./uninstall.sh --purge
```

## Legal status

This is an independent, unofficial project. It is not endorsed by xAI, SpaceXAI, Cursor, or Anysphere. Grok Bot and related names can be trademarks of their owners. Use the official application and service under their applicable terms.
