#!/usr/bin/env bash
# Run a JS file (async function body; `Zotero` and `win` in scope) inside the dev Zotero. Usage: zeval.sh file.js
curl -s --max-time "${ZEVAL_TIMEOUT:-600}" -H 'Content-Type: text/plain' --data-binary @"$1" http://127.0.0.1:23119/metareader-dev/eval \
  | python3 -c 'import json,sys; r=json.load(sys.stdin); print(r["err"], file=sys.stderr) if "err" in r else print(r["ok"] if isinstance(r["ok"],str) else json.dumps(r["ok"],indent=2)); sys.exit(1 if "err" in r else 0)'
