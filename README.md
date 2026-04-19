# GSD Utility Extension

A production-focused **gsd-pi extension** that combines four high-impact workflows in one package:

- **Double Esc stop** for fast interruption (`Esc Esc` → `/gsd stop`)
- **OpenAI / OpenAI Codex WHAM usage footer** (`5h` + `7d` windows)
- **OpenAI Codex multi-account switching** (`/swap`, `F2` account picker)
- **Drag & drop screenshot/file session cache** with stable markers like `[Image #1]`

If you are searching for keywords like **"gsd extension"**, **"OpenAI Codex multi account"**, **"terminal drag and drop image to AI"**, **"double esc stop gsd"**, or **"ChatGPT WHAM usage footer"**, this project is built for that exact workflow.

---

## Screenshot

![GSD Utility Extension WHAM Usage Footer](https://i.ibb.co/S7449qTL/Ekran-Resmi-2026-04-19-17-20-05.png)

---

## Why this extension exists

When working in `gsd` sessions, speed and reliability matter:

- You need an instant way to stop auto mode.
- You want visible token/usage windows in the terminal footer.
- You may use multiple OpenAI Codex accounts in one workflow.
- Dragged screenshot paths from temporary folders can disappear before tools read them.

This extension solves all of that in one install.

---

## Features

## 1) Double Esc Stop (Fast Interrupt)

- Detects double Escape (`Esc Esc`, typically `ctrl+alt+[`)
- Sends `/gsd stop` automatically
- Useful when auto mode or a long flow needs immediate stop

## 2) WHAM Usage Footer (OpenAI / OpenAI-Codex)

- Shows usage bars for:
  - **5h window** (primary)
  - **7d window** (secondary)
- Renders directly in footer context line
- Updates periodically

## 3) OpenAI Codex Multi-Account

- Extends `openai-codex` login flow for multiple accounts
- Supports:
  - **Add additional account**
  - **Overwrite existing account**
- Account alias is required for clear account identity
- Switch account using:
  - `/swap <id>`
  - `F2` quick picker (`←/→`, `↑/↓`, `1..9`, `Enter`, `Esc`)
- Footer badges show active/available accounts: `[1] [2] [3] ...`

## 4) Drag & Drop Session Temp Cache (Images + Files)

- Intercepts dragged file paths in terminal input
- Immediately copies files to a **session temp directory**
- Replaces raw paths with stable markers:
  - Image files → `[Image #1]`, `[Image #2]`, ...
  - Other files → `[File #1]`, `[File #2]`, ...
- On prompt submit:
  - `[Image #n]` becomes real image attachment for model input
  - `[File #n]` resolves to cached stable temp path
- Session cache is cleaned automatically on session shutdown

---

## Requirements

- `gsd` installed and available in PATH
- Node.js available in PATH
- A running `gsd` terminal session for `/reload`

> No manual `.env` setup is required for this extension's core behavior.

---

## Installation (Step by Step)

### 1) Clone or open the project directory

```bash
cd /path/to/gsd-utility-extension
```

### 2) Run installer

```bash
./install.sh
```

What installer does:

- Validates extension syntax (`node --check`)
- Removes old split packages if they exist (portable cleanup, no user-specific absolute paths)
- Performs clean local reinstall
- Verifies install via `gsd list`

### Portability note

This repository is designed to be **user/machine agnostic**:

- No hardcoded usernames like `/Users/<name>/...`
- No hardcoded project location assumptions
- Installer resolves paths dynamically from its own location
- Session cache uses OS temp directory (`os.tmpdir()`)

### 3) Reload active session

In your active `gsd` terminal:

```bash
/reload
```

If you do not have an active session, restart `gsd`.

---

## Usage (Step by Step)

## A) Stop with double Escape

1. In active session, press `Esc Esc`
2. Extension sends `/gsd stop`

## B) Check usage footer

1. Use an OpenAI/OpenAI-Codex model
2. Footer shows `5h` and `7d` usage windows

## C) Use multiple OpenAI Codex accounts

1. Run `/login` and choose OpenAI Codex
2. Choose add/overwrite flow
3. Set alias
4. Switch account with `/swap <id>` or `F2`

## D) Drag screenshot and ask question

1. Drag screenshot file into terminal input
2. Marker appears (for example `[Image #1]`)
3. Type your question and send
4. Image is attached from stable session cache

## E) Inspect cached mappings

```bash
/dragcache
```

This pastes marker → cached path mappings into the editor.

---

## Commands and Shortcuts

| Action | Command / Key |
|---|---|
| Stop auto quickly | `Esc Esc` |
| Switch OpenAI account | `/swap <id>` |
| Open quick account picker | `F2` |
| Show drag cache mappings | `/dragcache` |

---

## Troubleshooting

## Extension behavior not updated

- Run `/reload` in active session
- If needed, restart `gsd`

## Double Esc does not trigger

- Check terminal keybinding conflicts
- Ensure extension is installed (`gsd list`)

## Dropped file remains raw path

- Run `/reload` after install
- Retry drag-and-drop once
- Use `/dragcache` to verify cached entries

---

## Project Structure

```text
gsd-utility-extension/
├── extensions/
│   └── utility-extension.js
├── install.sh
├── package.json
└── README.md
```

---

## Local Install Verification

```bash
gsd list
```

You should see this project path in installed project packages.
