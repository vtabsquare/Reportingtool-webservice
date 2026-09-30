# VTAB Reporting Services 5.2.5 — Server Performance Update

## What was corrected

1. A report page now requests all visual data in one batch instead of sending one request per visual.
2. Report authorization, row-level security and snapshot preparation run once per page load.
3. Up to four independent visual queries run together on the server. One failed visual no longer prevents the other visuals from rendering.
4. Downloaded Parquet snapshots can be stored on a persistent server disk, preventing repeated downloads after a restart.
5. Larger API responses are compressed.
6. The report library and every visual show a real loading state, including during a server cold start.
7. Failed page loads display a retry action instead of looking frozen or incorrectly empty.
8. The Services web entry is separated from the Desktop authoring entry.
9. Ready-to-use Render and Nginx settings add persistent caching, HTTPS redirection, compression and browser caching.

## Important finding from the deployed site

The DigitalOcean server itself responded quickly to a small health request. The delay was mainly caused after the first page opened: the browser created many visual requests, and each request repeated cloud report/security/snapshot work. Static JavaScript and CSS were also delivered without compression or long-lived asset caching.

The HTTPS certificate presented for `reportservices.vtabsquare.com` did not match that hostname during the check. Correct the certificate before using the HTTPS configuration below.

## Easiest installation — copy the update files

1. Stop the Reporting Services backend.
2. Make a backup copy of your current project folder.
3. Open the supplied `VTAB-Services-5.2.5-Update-Files` folder.
4. Copy everything inside it into your existing Reporting Services project folder.
5. Choose **Replace the files in the destination** when Windows asks.
6. Do not copy an old `web.env` file from any archive. Keep the environment values already configured on the server.
7. Continue with the section for your hosting provider.

The update contains these changed files:

- `api/app/server.py`
- `api/app/reporting_service.py`
- `api/app/version.py`
- `api/tests/test_services_performance_regressions.py`
- `src/main.tsx`
- `src/services.tsx`
- `src/styles.css`
- `src/v11/PublishedViewer.tsx`
- `src/v11/WorkspaceView.tsx`
- `deploy/nginx-reportservices.conf`
- `render.yaml`
- `api/render.yaml`
- `package.json`
- `package-lock.json`

## DigitalOcean deployment

### 1. Add the server settings

Add these environment variables to the backend service:

```text
VTAB_QUERY_BATCH_WORKERS=4
VTAB_SNAPSHOT_CACHE_DIR=/var/lib/vtab/snapshots
```

Create the snapshot folder and give it to the Linux account that runs the backend. Replace `vtab` in the final command if your service uses a different account:

```bash
sudo mkdir -p /var/lib/vtab/snapshots
sudo chown -R vtab:vtab /var/lib/vtab
```

For a small server, start with four batch workers. Use two if the server has only one CPU or becomes memory constrained.

### 2. Build the web application

Run from the project folder:

```bash
npm install
npm run build:web
```

Copy the generated `dist-web` contents to `/var/www/reportservices/dist-web`.

### 3. Configure Nginx

1. Open `deploy/nginx-reportservices.conf`.
2. Confirm the domain, frontend folder and backend port match your server.
3. Copy it to `/etc/nginx/sites-available/reportservices`.
4. Enable it and validate Nginx:

```bash
sudo ln -s /etc/nginx/sites-available/reportservices /etc/nginx/sites-enabled/reportservices
sudo nginx -t
sudo systemctl reload nginx
```

If the link already exists, do not create it again.

### 4. Correct HTTPS

After DNS for `reportservices.vtabsquare.com` points to the DigitalOcean server, request the correct certificate:

```bash
sudo certbot --nginx -d reportservices.vtabsquare.com
```

Then open `https://reportservices.vtabsquare.com/`. HTTP should automatically redirect to HTTPS without a certificate warning.

### 5. Restart the backend

Restart the existing backend service or container. For systemd, replace the example service name if yours is different:

```bash
sudo systemctl restart vtab-reporting
sudo systemctl status vtab-reporting
```

## Render deployment

1. Replace the existing `render.yaml` with the supplied file.
2. In Render, choose **Blueprint → Sync** and redeploy both services.
3. Keep your existing Supabase and encryption secrets in Render; do not paste secrets into the source files.
4. The supplied Blueprint uses a Starter backend and a 5 GB persistent disk. These are paid Render resources. A free backend sleeps and will always have visible cold-start delay.
5. Confirm the backend has:

```text
VTAB_QUERY_BATCH_WORKERS=4
VTAB_SNAPSHOT_CACHE_DIR=/var/lib/vtab/snapshots
```

## Verification after deployment

1. Open the workspace in a private/incognito browser window.
2. The library should show “Loading your published reports…” while it is fetching data. It must not briefly say there are no reports.
3. Open a report with several visuals. A “Preparing … visuals” message and visual loading placeholders should appear.
4. In browser developer tools, the page should call one endpoint ending in `/query-batch`, not one `/query` request for every visual.
5. Refresh the same report. The second load should be faster because snapshots and query results are warm.
6. Change a slicer or select a chart point. The page visuals should refresh together.
7. Export PDF and PPT and confirm export waits until all visual placeholders disappear.
8. Verify `https://reportservices.vtabsquare.com/api/v1/health` opens without a certificate warning.

## Security action required

An earlier shared source package contained a `web.env` file with a privileged Supabase service key. Rotate that service-role key in Supabase, update the secret only in Render/DigitalOcean environment settings, and never place it in the frontend or a source archive. The 5.2.5 delivery archives intentionally exclude `web.env`, `.env` files, local databases and build caches.

## Expected behavior

Localhost will still be slightly faster because it has almost no network latency. After this update, the deployed version avoids the largest unnecessary repeated work, compresses its responses, reuses snapshots, and always gives users visible progress instead of a stuck screen.
