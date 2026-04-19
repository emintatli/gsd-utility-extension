# GSD Utility Extension

A production-focused **gsd-pi extension** that combines four high-impact workflows in one package:

- **Esc stop** for fast interruption (`Esc` → `/gsd stop`, `F4` fallback)
- **OpenAI / OpenAI Codex WHAM usage footer** (`5h` + `7d` windows)
- **OpenAI Codex multi-account switching** (`/swap`, `F2` account picker)
- **Drag & drop screenshot/file cache** with stable markers like `[Image #1]`

If you are searching for keywords like **"gsd extension"**, **"OpenAI Codex multi account"**, **"terminal drag and drop image to AI"**, **"Esc stop gsd"**, or **"ChatGPT WHAM usage footer"**, this project is built for that exact workflow.

---

## Features

## 1) Esc Stop (Fast Interrupt)

- Detects `Esc` key press
- Sends `/gsd stop` automatically
- Keeps `F4` as fallback shortcut
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

## 4) Drag & Drop Temp Cache (Images + Files)

- Intercepts dragged file paths in terminal input
- Immediately copies files to extension-managed temp cache
- Replaces raw paths with stable markers:
  - Image files → `[Image #1]`, `[Image #2]`, ...
  - Other files → `[File #1]`, `[File #2]`, ...
- On prompt submit:
  - `[Image #n]` becomes real image attachment for model input
  - `[File #n]` resolves to cached stable temp path
- Marker resolution is resilient across task/session transitions in the same gsd run
- Re-dragging from reused temp paths re-caches the newest file snapshot

---

## Installation

```bash
cd /path/to/gsd-utility-extension
./install.sh
```

Then in active `gsd` terminal:

```bash
/reload
```

---

## Usage

## A) Stop with Esc

1. In active session, press `Esc`
2. Extension sends `/gsd stop`
3. If your terminal intercepts `Esc`, use `F4` fallback

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
4. Image is attached from stable cache

## E) Inspect cached mappings

```bash
/dragcache
```

---

## Commands and Shortcuts

| Action | Command / Key |
|---|---|
| Stop auto quickly | `Esc` (`F4` fallback) |
| Force stop command | `/panicstop` |
| Switch OpenAI account | `/swap <id>` |
| Open quick account picker | `F2` |
| Show drag cache mappings | `/dragcache` |

---

## Troubleshooting

## Esc does not trigger

- Check terminal keybinding conflicts
- Ensure extension is installed (`gsd list`)
- Use `F4` fallback

## Dropped file remains raw path

- Run `/reload` after install
- Retry drag-and-drop once
- Use `/dragcache` to verify cached entries
