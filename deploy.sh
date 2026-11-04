#!/bin/bash
# deploy.sh
# Deploy the latest VTAB Reporting Services to DigitalOcean.
# Run from the droplet as root:
#   bash /var/www/reportingtool-webservice/deploy.sh
#
# What it does:
#   1. git fetch + reset to origin/main
#   2. nginx reload to serve new dist-web
#   3. Sends update offer to backend so the update banner shows in the UI

set -e

REPO_DIR="/var/www/reportingtool-webservice"
export VTAB_API_BASE="https://reportservices.vtabsquare.com/api/v1"
export VTAB_AGENT_TOKEN="SDCsfIsSnlOj4ceWprbj-0GrsjxESrOT1DnmNJOGa_Y"

echo ""
echo "============================================="
echo "  VTAB Reporting Services — Deploy"
echo "============================================="
echo ""

cd "$REPO_DIR"

echo "[1/3] Pulling latest code from GitHub..."
git fetch origin
git reset --hard origin/main
NEW_SHA=$(git rev-parse HEAD)
echo "       Commit: $NEW_SHA"
echo ""

echo "[2/3] Reloading nginx..."
nginx -t && systemctl reload nginx
echo "       nginx reloaded OK"
echo ""

echo "[3/3] Notifying backend of new deployment..."
python3 "$REPO_DIR/scripts/send_update_offer.py" "$NEW_SHA"
echo ""

echo "============================================="
echo "  Deployed! https://reportservices.vtabsquare.com"
echo "============================================="
echo ""
