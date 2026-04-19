#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_FILE="${SCRIPT_DIR}/extensions/utility-extension.js"

if ! command -v gsd >/dev/null 2>&1; then
  echo "[error] gsd command not found." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[error] node command not found." >&2
  exit 1
fi

echo "[info] Syntax check: ${EXT_FILE}"
node --check "${EXT_FILE}"

# Remove previous split packages if installed (ignore if absent)
LEGACY_PACKAGE_NAMES=("gsd-openai-usage-bar" "gsd-double-esc-stop")
PROJECT_PARENT="$(cd "${SCRIPT_DIR}/.." && pwd)"

remove_local_install_if_exists() {
  local target="$1"
  [[ -n "$target" ]] || return 0
  gsd remove "$target" -l >/dev/null 2>&1 || true
}

# Try common local checkout shapes (portable, no user-specific absolute paths)
for legacy in "${LEGACY_PACKAGE_NAMES[@]}"; do
  remove_local_install_if_exists "${PROJECT_PARENT}/${legacy}"
  remove_local_install_if_exists "${SCRIPT_DIR}/${legacy}"
done

# Also attempt cleanup for any installed entries that contain old package names
while IFS= read -r installed_entry; do
  [[ -n "$installed_entry" ]] || continue
  for legacy in "${LEGACY_PACKAGE_NAMES[@]}"; do
    if [[ "$installed_entry" == *"$legacy"* ]]; then
      if [[ "$installed_entry" =~ (~/[^[:space:]]+|/[^[:space:]]+) ]]; then
        installed_path="${BASH_REMATCH[1]}"
        remove_local_install_if_exists "$installed_path"
      fi
    fi
  done
done < <(gsd list 2>/dev/null || true)

# Force clean reinstall of this package (ignore if not installed yet)
gsd remove "${SCRIPT_DIR}" -l >/dev/null 2>&1 || true

echo "[info] Installing utility extension: ${SCRIPT_DIR}"
gsd install "${SCRIPT_DIR}" -l

if gsd list | grep -F "${SCRIPT_DIR}" >/dev/null 2>&1; then
  echo "[ok] Installation verified in gsd list."
else
  echo "[error] Installation verification failed: package not found in 'gsd list'." >&2
  exit 1
fi

echo "[ok] Installation completed."
echo "[next] Run /reload in your active GSD session (or restart gsd)."
