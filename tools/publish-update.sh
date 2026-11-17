#!/bin/bash
# Publish a signed update for AdFree TV. TVs pick it up by themselves over Wi-Fi.
#
#   tools/publish-update.sh            # ad-block script / user agent only (silent on TV)
#   tools/publish-update.sh --apk      # also ship a new app build (TV asks "Install?" once)
#
# Signs update/manifest.json with keys/update-private.pem (never leaves this Mac),
# then commits and pushes the update/ folder to GitHub.
set -euo pipefail
cd "$(dirname "$0")/.."
KEY=keys/update-private.pem
[ -f "$KEY" ] || { echo "Missing $KEY (the signing key). Updates can't be published without it."; exit 1; }
mkdir -p update

cp app/src/main/assets/adblock.js update/adblock.js
PREV=$( [ -f update/manifest.json ] && python3 -c "import json;print(json.load(open('update/manifest.json')).get('scriptVersion',0))" || echo 0)
OLDHASH=$( [ -f update/manifest.json ] && python3 -c "import json;print(json.load(open('update/manifest.json')).get('scriptSha256',''))" || echo "")
HASH=$(shasum -a 256 update/adblock.js | cut -d' ' -f1)
SV=$PREV; [ "$HASH" != "$OLDHASH" ] && SV=$((PREV+1))

APKV=$( [ -f update/manifest.json ] && python3 -c "import json;print(json.load(open('update/manifest.json')).get('apkVersionCode',0))" || echo 0)
APKHASH=$( [ -f update/manifest.json ] && python3 -c "import json;print(json.load(open('update/manifest.json')).get('apkSha256',''))" || echo "")
if [ "${1:-}" = "--apk" ]; then
  ./gradlew assembleRelease -q
  cp app/build/outputs/apk/release/app-release.apk update/app.apk
  APKV=$(grep -E "versionCode" app/build.gradle | grep -oE "[0-9]+")
  APKHASH=$(shasum -a 256 update/app.apk | cut -d' ' -f1)
fi

UA=$(grep -A2 "DEFAULT_USER_AGENT =" app/src/main/java/com/adfree/yttv/Rules.java | grep -oE '"[^"]+"' | tr -d '"' | tr -d '\n')
python3 - "$SV" "$HASH" "$APKV" "$APKHASH" "$UA" <<'PY'
import json,sys
sv,h,av,ah,ua=sys.argv[1:]
json.dump({"scriptVersion":int(sv),"scriptSha256":h,"apkVersionCode":int(av),"apkSha256":ah,"userAgent":ua},
          open("update/manifest.json","w"),indent=2)
PY
openssl dgst -sha256 -sign "$KEY" update/manifest.json | base64 > update/manifest.json.sig
echo "Signed: script v$SV, app v$APKV"
cat update/manifest.json

if git rev-parse --git-dir >/dev/null 2>&1 && git remote get-url origin >/dev/null 2>&1; then
  git add update/ && git commit -qm "Publish update: script v$SV, app v$APKV" && git push -q && echo "Pushed. TVs will pick it up within 6 hours."
else
  echo "No GitHub remote yet - update/ prepared locally only."
fi
