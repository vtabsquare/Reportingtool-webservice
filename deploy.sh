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
echo "[1/5] Pulling latest code from GitHub and checking out $TARGET_COMMIT..."
git fetch origin
git reset --hard "$TARGET_COMMIT"
NEW_SHA=$(git rev-parse HEAD)
echo "       Commit: $NEW_SHA"
echo ""

echo "[2/5] Ensuring production web assets..."
if [ -d "$REPO_DIR/node_modules" ] && command -v npm > /dev/null 2>&1; then
    npm run build:web 2>/dev/null || true
fi
chown -R www-data:www-data "$REPO_DIR/dist-web" 2>/dev/null || true
chmod -R 755 "$REPO_DIR/dist-web" 2>/dev/null || true
echo "       dist-web assets verified"
echo ""

echo "[3/5] Updating release commit SHA in web.env..."
# Remove any stale VTAB_RELEASE_COMMIT_SHA and VTAB_AUTO_OFFER_GITHUB lines
sed -i '/^VTAB_RELEASE_COMMIT_SHA=/d' "$REPO_DIR/web.env"
sed -i '/^VTAB_AUTO_OFFER_GITHUB=/d' "$REPO_DIR/web.env"
# Write fresh values
echo "VTAB_RELEASE_COMMIT_SHA=${NEW_SHA:0:8}" >> "$REPO_DIR/web.env"
echo "VTAB_AUTO_OFFER_GITHUB=false" >> "$REPO_DIR/web.env"
echo "       web.env updated with VTAB_RELEASE_COMMIT_SHA=${NEW_SHA:0:8}"
echo ""

echo "[4/5] Recreating backend container with updated env and reloading nginx..."
# Recreate (not just restart) so the new env-file is loaded
docker rm -f vtab-reporting-api > /dev/null 2>&1 || true
sleep 1
docker run -d --name vtab-reporting-api --restart always -p 8820:8820 \
  --env-file "$REPO_DIR/web.env" \
  -v "$REPO_DIR/api:/app" \
  vtab-reporting-api:latest > /dev/null
sleep 5
# Health check
curl -sf http://127.0.0.1:8820/api/v1/health > /dev/null \
  && echo "       container healthy" \
  || echo "       WARNING: health check failed - check: docker logs vtab-reporting-api"
nginx -t && systemctl reload nginx
echo "       nginx reloaded OK"
echo ""

echo "[5/5] Deployment complete, clearing update banner..."
python3 "$REPO_DIR/scripts/mark_update_complete.py" "$NEW_SHA"
echo ""

echo "============================================="
echo "  Deployed! https://reportservices.vtabsquare.com"
echo "============================================="
echo ""
