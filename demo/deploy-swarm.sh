#!/usr/bin/env bash
# Deploy the demo app itself to Ethereum Swarm as a static website.
#
# Builds the demo with relative asset paths and the Bee API baked in, then
# uploads the bundle as a Swarm collection (manifest with an index
# document). The printed /bzz URL serves the app straight from the network —
# app code, images, documents and version history all live on Swarm.
#
# Usage:  BEE_API_URL=http://localhost:1633 ./deploy-swarm.sh
#         SWARM_POSTAGE_BATCH_ID=<id>  pins a batch (else auto-discovered).
set -euo pipefail
cd "$(dirname "$0")"

BEE_API_URL="${BEE_API_URL:-http://localhost:1633}"

if [ -z "${SWARM_POSTAGE_BATCH_ID:-}" ]; then
  SWARM_POSTAGE_BATCH_ID=$(curl -sf "$BEE_API_URL/stamps" |
    python3 -c 'import json,sys; print(next(s["batchID"] for s in json.load(sys.stdin)["stamps"] if s["usable"]))')
fi
echo "Bee node:      $BEE_API_URL"
echo "Postage batch: $SWARM_POSTAGE_BATCH_ID"

echo "Building demo (base ./, Swarm storage enabled)..."
VITE_BEE_API_URL="$BEE_API_URL" npx vite build --base ./

echo "Uploading to Swarm..."
TARBALL=$(mktemp --suffix .tar)
trap 'rm -f "$TARBALL"' EXIT
tar -C dist -cf "$TARBALL" .

REFERENCE=$(curl -sf -X POST "$BEE_API_URL/bzz" \
  -H "content-type: application/x-tar" \
  -H "swarm-postage-batch-id: $SWARM_POSTAGE_BATCH_ID" \
  -H "swarm-index-document: index.html" \
  -H "swarm-collection: true" \
  --data-binary @"$TARBALL" |
  python3 -c 'import json,sys; print(json.load(sys.stdin)["reference"])')

echo
echo "Deployed: $BEE_API_URL/bzz/$REFERENCE/"
echo "(Point an ENS contenthash or a feed at this reference for a stable address.)"
