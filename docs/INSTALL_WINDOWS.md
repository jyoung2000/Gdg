# Meridian on Windows

Download, run, use. You do not need Node.js, pnpm, Docker, a terminal, or a
GitHub account.

## Install

1. Download **`Meridian-Setup-x64.exe`** from the
   [latest release](https://github.com/jyoung2000/Gdg/releases/latest).
2. Run it. It installs for your account only, so Windows will not ask for
   administrator permission.
3. Open **Meridian** from the Start menu.

The first launch takes a few seconds longer than the ones after it: Meridian
sets up its database and looks for any AI models already running on your
machine.

### Check what you downloaded

Every release publishes `SHA256SUMS.txt`. To confirm your download is the file
that was built:

```powershell
Get-FileHash .\Meridian-Setup-x64.exe -Algorithm SHA256
```

Compare the result with the line for that filename in `SHA256SUMS.txt`.

---

## First run

Meridian opens with nothing configured, which is a working state rather than a
broken one — it can already find and use models running on your own computer.
To reach hosted models, add a provider key.

**OpenRouter is the easiest place to start.** One key reaches models from many
providers, including free ones.

1. Get a key at [openrouter.ai/keys](https://openrouter.ai/keys).
2. In Meridian, open **Providers**, choose **OpenRouter**, and paste the key.

Meridian discovers what that key can reach and adds those models to its
registry. Nothing routes to a paid model until you turn paid routing on: a free
tier and a paid account are never treated as the same thing.

You can add as many providers as you like, or none. Anthropic, OpenAI, Google,
Groq, Cerebras, Mistral, DeepSeek and others each appear on the Providers screen
with what they need.

---

## Where Meridian keeps things

| What | Where |
| --- | --- |
| Database, credentials, generated files | `%APPDATA%\Meridian` |
| Agent workspaces | `%APPDATA%\Meridian\workspaces` |
| Logs | `%LOCALAPPDATA%\Meridian\logs` |
| The application itself | `%LOCALAPPDATA%\Meridian` |

Your data and the program are deliberately in different places. Uninstalling
removes the program and leaves everything you made with it.

**Your API keys are encrypted**, under a key that Windows protects for your
account through DPAPI. The database on its own is not enough to read them:
copied to another computer, or opened by a different Windows account, the
credentials stay encrypted.

To move Meridian to a new machine, copy `%APPDATA%\Meridian` — but the
credentials will not follow, by design. Add your provider keys again there.

---

## Closing, quitting and the tray

**Closing the window does not quit Meridian.** It keeps serving in the
background and stays in the system tray.

That is deliberate. Meridian is a server as well as an app: the `uag` command
line, your editor, and anything else pointed at its API are all talking to it.
Closing a window should not disconnect them.

The tray icon gives you **Open Meridian**, **Restart the gateway**, **Open
logs**, **Open data folder** and **Quit Meridian**. Quit is the one that
actually stops it.

---

## Docker is optional

Meridian can run an agent's commands inside a Docker container, which is a real
isolation boundary. Without Docker it uses a process sandbox instead, which
limits accidents but **is not a security boundary** — a command can reach your
files and your network.

Meridian says which one it is using on the home screen, and never claims
isolation it does not have. If you want the stronger boundary, install
[Docker Desktop](https://www.docker.com/products/docker-desktop/) and restart
Meridian; it will find it.

You do not need Docker for chat, routing, model discovery, image generation, or
anything that does not run commands on your machine.

---

## If something goes wrong

Meridian tells you what happened rather than showing a blank window.

**"Meridian couldn't start its local gateway."** The screen carries **Try
again**, **Open logs** and **Open data folder**, and the last thing the gateway
said. Your data is untouched; Meridian will use it again as soon as it starts.

**A port conflict.** Meridian prefers port 4639 and moves to a free one if
something else already has it. Nothing to do — it says so and carries on.

**Nothing at all happens when you click the shortcut.** Meridian is probably
already running: look in the system tray. Starting it again brings the existing
window forward rather than opening a second copy.

The log is at `%LOCALAPPDATA%\Meridian\logs\meridian.log`. It is plain text,
and API keys are stripped out of it before it is written — but read it before
you paste it anywhere public.

---

## Uninstalling

**Settings → Apps → Installed apps → Meridian → Uninstall**, or the uninstaller
in `%LOCALAPPDATA%\Meridian`.

This removes the program, the bundled runtime and the shortcuts. It **keeps**
`%APPDATA%\Meridian` — your database, your workspaces and your encrypted
credentials — so reinstalling picks up where you left off.

To remove everything, delete `%APPDATA%\Meridian` and
`%LOCALAPPDATA%\Meridian` yourself after uninstalling. Meridian will not do
that for you: deleting someone's work as a side effect of removing a program is
not a thing software should decide on its own.

---

## What is inside the installer

No hidden downloads. Everything the application needs is in the file you ran:

- Meridian itself — the desktop shell, the gateway, and the web interface
- Node.js 22.23.2, pinned by checksum, used only to run Meridian's gateway
- SQLite, through `better-sqlite3`

Meridian reaches the network only to talk to the AI providers you configure and
to refresh its model catalogue. It sends nothing about you anywhere, and there
is no telemetry.

See [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) for the licences of what
is redistributed.

---

## Also available

- **Portable** — `Meridian-Portable-x64.zip`, if one is attached to the release.
  Unzip and run `Meridian.exe`; no installer, no registry entries. It still
  keeps your data in `%APPDATA%\Meridian`, so it is portable in the sense of
  needing no installation, not in the sense of carrying your data on the stick.
- **Docker** — for running Meridian as a server. See the
  [README](../README.md#docker).
- **From source** — see [DEVELOPMENT_WINDOWS.md](DEVELOPMENT_WINDOWS.md).
