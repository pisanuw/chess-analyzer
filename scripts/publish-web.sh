#!/bin/bash
# Publish the local data to the hosted mirror: push the data repo (history),
# sync the hosted drill store, assemble the static site, deploy to Netlify.
# Secrets live in .env.web (gitignored): NETLIFY_AUTH_TOKEN, NETLIFY_SITE_ID,
# SUPABASE_URL, SUPABASE_SERVICE_KEY.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env.web; set +a

npm run push-data

echo "Syncing hosted drill store..."
node scripts/web-sync-drills.js

echo "Assembling web-dist..."
rm -rf web-dist
mkdir -p web-dist/vendor/chessground/assets web-dist/vendor/chess.js
cp -r public/* web-dist/
cp node_modules/chessground/dist/* web-dist/vendor/chessground/
cp node_modules/chessground/assets/* web-dist/vendor/chessground/assets/
cp node_modules/chess.js/dist/esm/* web-dist/vendor/chess.js/

echo "Deploying to Netlify..."
npx --yes netlify-cli@17 deploy --prod --dir web-dist --functions netlify/functions \
  --site "$NETLIFY_SITE_ID" --auth "$NETLIFY_AUTH_TOKEN" --message "publish $(date +%F_%H%M)"
echo "Published."
