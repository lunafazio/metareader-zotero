#!/usr/bin/env bash
# (Re)start the dev Zotero in the background (log: /tmp/metareader-zotero.log) and wait until it answers.
cd "$(dirname "$0")/.."
pat="^\S*zotero-bin -app .* -profile $(pwd)/dev-profile"
kill $(pgrep -f "$pat") 2>/dev/null
for i in $(seq 1 20); do pgrep -f "$pat" >/dev/null || break; sleep 0.5; done
(setsid scripts/run-clean-env.sh scripts/dev.sh > /tmp/metareader-zotero.log 2>&1 &)
for i in $(seq 1 60); do curl -s -o /dev/null http://127.0.0.1:23119/connector/ping && break; sleep 1; done
sleep 2
