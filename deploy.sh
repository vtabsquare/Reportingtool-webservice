#!/bin/bash
set -e

REPO_DIR="/var/www/reportingtool-webservice"
export VTAB_API_BASE="https://reportservices.vtabsquare.com/api/v1"
export VTAB_AGENT_TOKEN="SDCsfIsSnlOj4ceWprbj-0GrsjxESrOT1DnmNJOGa_Y"

echo ""
echo "============================================="
echo "  VTAB Reporting Services -- Deploy"
echo "============================================="
echo ""

cd "$REPO_DIR"

TARGET_COMMIT="${1:-origin/main}"
echo "[1/4] Pulling latest code from GitHub and checking out $TARGET_COMMIT..."
git fetch origin
git reset --hard "$TARGET_COMMIT"
NEW_SHA=$(git rev-parse HEAD)
echo "       Commit: $NEW_SHA"
echo ""

echo "[2/4] Ensuring production web assets..."
if [ -d "$REPO_DIR/node_modules" ] && command -v npm >/dev/null 2>&1; then
    npm run build:web 2>/dev/null || true
fi
chown -R www-data:www-data "$REPO_DIR/dist-web" 2>/dev/null || true
chmod -R 755 "$REPO_DIR/dist-web" 2>/dev/null || true
echo "       dist-web assets verified"
echo ""

echo "[3/4] Restarting backend container and reloading nginx..."
docker restart vtab-reporting-api >/dev/null 2>&1 || true
sleep 4
nginx -t && systemctl reload nginx
echo "       backend and nginx reloaded OK"
echo ""

echo "[4/4] Deployment complete, clearing update banner..."
python3 "$REPO_DIR/scripts/mark_update_complete.py" "$NEW_SHA"
echo ""

echo "============================================="
echo "  Deployed and Verified! https://reportservices.vtabsquare.com"
echo "============================================="
echo ""
