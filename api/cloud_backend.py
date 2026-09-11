from __future__ import annotations
import os
import uvicorn

if __name__ == '__main__':
    port = int(os.environ.get('PORT', '8820'))
    # Cloud mode: no desktop mode, allow external origins via CORS env var
    os.environ.setdefault('VTAB_ENFORCE_API_AUTH', '1')
    os.environ.pop('VTAB_DESKTOP_MODE', None)
    from app.server import app
    from app.refresh_worker import start_refresh_worker
    worker = start_refresh_worker()
    try:
        uvicorn.run(app, host='0.0.0.0', port=port, log_level='info')
    finally:
        worker.stop()
