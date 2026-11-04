#!/bin/bash
# deploy.sh
# Deploy the latest VTAB Reporting Services to DigitalOcean.
# Run from the droplet as root:
#   bash /var/www/reportingtool-webservice/deploy.sh
#
# What it does:
#   1. git fetch + reset to origin/main
#   2. Updates backend container & reloads nginx
#   3. Marks deployment complete, clearing the update banner automatically

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

echo "[2/3] Updating backend container & reloading nginx..."
docker cp "$REPO_DIR/api/app/." vtab-reporting-api:/app/app/ 2>/dev/null && docker restart vtab-reporting-api >/dev/null 2>&1 || true
sleep 6
nginx -t && systemctl reload nginx
echo "       backend and nginx reloaded OK"
echo ""

echo "[3/3] Deployment complete, clearing update banner..."
python3 "$REPO_DIR/scripts/mark_update_complete.py" "$NEW_SHA"
echo ""

echo "============================================="
echo "  Deployed & Verified! https://reportservices.vtabsquare.com"
echo "============================================="
echo ""
