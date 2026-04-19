#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v gsd >/dev/null 2>&1; then
  echo "[error] gsd command not found." >&2
  exit 1
fi

# Remove previous split packages if installed (ignore if absent)
gsd remove "/Users/emin/Desktop/project/gsd-openai-usage-bar" -l >/dev/null 2>&1 || true
gsd remove "/Users/emin/Desktop/project/gsd-double-esc-stop" -l >/dev/null 2>&1 || true

echo "[info] Installing utility extension: ${SCRIPT_DIR}"
gsd install "${SCRIPT_DIR}" -l

echo "[ok] Installation completed."
echo "[next] Run /reload in your active GSD session."
