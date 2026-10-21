# Services Colleague Fix Merge — Update Only

Copy this package over the root of the latest Reporting Tool Services project and preserve the folder structure. Back up the project first. This package does not contain dependencies, build output, credentials, or environment files.

## Safely merged

- Rendered PDF/PPTX exports use lightweight project metadata, accept PNG/JPEG/WebP images, resolve cloud projects, enforce a 100 MB application limit, and include the matching Nginx 100 MB gateway configuration.
- Published and designer slicers preserve selections, maintain independent filters, avoid self-filtering their own option lists, and no longer unmount unnecessarily during refresh.
- Existing personal-workspace provisioning and report-level/workspace-level access changes were preserved.
- Workspace switching uses request sequencing and a dedicated loading view so a slower previous request cannot replace the selected workspace.
- Viewer users are blocked from semantic-model metadata and management in both frontend and backend; authoring roles retain access.
- The global offline boundary preserves the mounted React application, verifies recovery every five seconds, and restores the exact in-memory view after reconnection.

## Deployment note

Application code alone cannot change the live Nginx gateway. After copying `deploy/nginx-reportservices.conf`, validate and reload the production Nginx configuration using your normal server deployment process. Until that configuration is deployed, production can still return HTTP 413 before FastAPI receives the request.

## Verification completed

- Python syntax compilation: passed.
- Focused Admin governance tests: 4/4 passed.
- Focused Services merge/access/export/slicer tests: 15/15 passed.
- Admin production build: passed.
- Services workspace-only production build: passed.

Two PDF-layout test modules require the optional `pypdf` test dependency and were not used in the focused verification. The broader legacy Services suite also contains long-running external integration tests, so its interrupted result is not represented as a pass.

