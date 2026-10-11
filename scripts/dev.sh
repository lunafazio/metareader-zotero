#!/usr/bin/env bash
# Start Zotero with an isolated profile + data dir (dev-profile/) and the unpacked add-on from build/addon/.
# Your real profile and ~/Zotero library are not touched. From the VS Code snap terminal use: npm run dev
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
zotero_bin="${ZOTERO_BIN:-$HOME/.local/share/zotero/zotero}"
prof="$root/dev-profile"
mkdir -p "$prof/extensions" "$prof/data"
printf '%s/build/addon/' "$root" > "$prof/extensions/metareader@lunafazio"
# Dev-only eval endpoint used by test/zeval.sh (never part of the .xpi).
printf '%s/test/devbridge/' "$root" > "$prof/extensions/metareader-devbridge@lunafazio"
cat > "$prof/user.js" <<PREFS
user_pref("extensions.zotero.dataDir", "$prof/data");
user_pref("extensions.zotero.useDataDir", true);
user_pref("extensions.autoDisableScopes", 0);
user_pref("extensions.enabledScopes", 15);
user_pref("xpinstall.signatures.required", false);
user_pref("extensions.zotero.firstRun2", false);
user_pref("extensions.zotero.debug.log", true);
user_pref("devtools.chrome.enabled", true);
PREFS
# Force a rescan of the extensions dir so a rebuilt add-on is picked up.
sed -i '/extensions.lastAppBuildId/d' "$prof/prefs.js" 2>/dev/null || true
exec "$zotero_bin" -profile "$prof" -no-remote -ZoteroDebugText -purgecaches "$@"
