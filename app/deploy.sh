#!/bin/bash
# Build 207 Admin and upload it to Supabase Storage (public bucket "admin-app").
# The Elementor widget on /207-admin/ only holds the loader (wordpress-embed.html), so this is the
# whole deploy: no paste. Browsers/CDN may keep the old copy for up to 60 seconds (cache-control).
# Needs the Supabase personal access token (~/.secrets/bin/secret get SUPABASE_ACCESS_TOKEN); the
# service key is fetched at run time and never written to disk or printed.
set -euo pipefail
cd "$(dirname "$0")"
REF=socluffmclkdljtmiexw
python3 build.py

TOKEN=$(~/.secrets/bin/secret get SUPABASE_ACCESS_TOKEN)
SERVICE=$(curl -fsS "https://api.supabase.com/v1/projects/$REF/api-keys?reveal=true" -H "Authorization: Bearer $TOKEN" \
  | python3 -c 'import json,sys; k=[x for x in json.load(sys.stdin) if x.get("name")=="service_role" or x.get("type")=="secret"]; print(k[0]["api_key"])')

# Headers go through a curl config on a private file descriptor so the key never appears in `ps` (2026-10-06).
AUTH=$(printf 'header = "Authorization: Bearer %s"\nheader = "apikey: %s"\n' "$SERVICE" "$SERVICE")
# Bucket (idempotent): public read, JS only, 2 MB cap.
curl -sS -o /dev/null -X POST "https://$REF.supabase.co/storage/v1/bucket" \
  -K <(printf '%s' "$AUTH") -H "Content-Type: application/json" \
  -d '{"id":"admin-app","name":"admin-app","public":true,"file_size_limit":2097152,"allowed_mime_types":["application/javascript","text/javascript"]}' || true
# Allow the home-screen icons too (2026-09-27). PUT updates an existing bucket's settings.
curl -sS -o /dev/null -X PUT "https://$REF.supabase.co/storage/v1/bucket/admin-app" \
  -K <(printf '%s' "$AUTH") -H "Content-Type: application/json" \
  -d '{"public":true,"file_size_limit":2097152,"allowed_mime_types":["application/javascript","text/javascript","image/png","application/json"]}' || true
# Home-screen icons (assets/*.png), referenced by the app for "Add to Home Screen".
for f in assets/*.png; do
  curl -fsS -o /dev/null -X POST "https://$REF.supabase.co/storage/v1/object/admin-app/icons/$(basename "$f")" \
    -K <(printf '%s' "$AUTH") -H "x-upsert: true" \
    -H "Content-Type: image/png" -H "cache-control: max-age=86400" --data-binary @"$f"
done

# Keep the previous live copy as a rollback (admin-app/prev/207-admin.js).
curl -fsS -o /dev/null -X POST "https://$REF.supabase.co/storage/v1/object/copy" \
  -K <(printf '%s' "$AUTH") -H "Content-Type: application/json" \
  -d '{"bucketId":"admin-app","sourceKey":"207-admin.js","destinationKey":"prev/207-admin-'"$(date +%Y%m%d-%H%M%S)"'.js"}' 2>/dev/null || echo "(no previous copy to keep)"

curl -fsS -o /dev/null -X POST "https://$REF.supabase.co/storage/v1/object/admin-app/207-admin.js" \
  -K <(printf '%s' "$AUTH") -H "x-upsert: true" \
  -H "Content-Type: application/javascript" -H "cache-control: max-age=60" \
  --data-binary @dist/207-admin.js
# Speed (2026-10-24): the same build under its versioned name (kept by phones for a year: it never changes), then
# current.json, which points site/loader.js at it and is never cached. current.json goes last, so nobody is pointed
# at a file that isn't there yet.
VERSIONED=$(python3 -c 'import json; print(json.load(open("dist/current.json"))["js"])')
curl -fsS -o /dev/null -X POST "https://$REF.supabase.co/storage/v1/object/admin-app/$VERSIONED" \
  -K <(printf '%s' "$AUTH") -H "x-upsert: true" \
  -H "Content-Type: application/javascript" -H "cache-control: public, max-age=31536000, immutable" \
  --data-binary @"dist/${VERSIONED#v/}"
curl -fsS -o /dev/null -X POST "https://$REF.supabase.co/storage/v1/object/admin-app/current.json" \
  -K <(printf '%s' "$AUTH") -H "x-upsert: true" \
  -H "Content-Type: application/json" -H "cache-control: no-cache, max-age=0" \
  --data-binary @dist/current.json
echo "Uploaded. Live check:"
LIVE=$(curl -fsS "https://$REF.supabase.co/storage/v1/object/public/admin-app/207-admin.js?nc=$(date +%s)")
if [ "$LIVE" = "$(cat dist/207-admin.js)" ]; then echo "OK: hosted file matches this build ($(wc -c < dist/207-admin.js | tr -d ' ') bytes)"; else echo "WARN: hosted file differs from build (CDN may still be updating)"; fi
CUR=$(curl -fsS "https://$REF.supabase.co/storage/v1/object/public/admin-app/current.json?nc=$(date +%s)" || true)
if [ "$CUR" = "$(cat dist/current.json)" ]; then echo "OK: current.json points at $VERSIONED"; else echo "WARN: current.json differs from build ($CUR)"; fi
