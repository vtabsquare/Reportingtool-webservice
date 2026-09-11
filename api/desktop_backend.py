from __future__ import annotations
import os
import multiprocessing
import traceback
import sys
from pathlib import Path
import duckdb
import uvicorn

def _load_env():
    """Load .env file from apps/api directory into os.environ."""
    if getattr(sys, 'frozen', False):
        exe_dir = Path(sys.executable).parent
        # Try right next to the backend executable
        env_path = exe_dir / '.env'
        if not env_path.exists():
            # In an Electron app, check the resources/ folder (one level up)
            env_path = exe_dir.parent / '.env'
        if not env_path.exists():
            # Check the app root (next to the main .exe, two levels up)
            env_path = exe_dir.parent.parent / '.env'
    else:
        env_path = Path(__file__).parent / '.env'
        
    if not env_path.exists():
        return
    try:
        with open(env_path, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                key, _, value = line.partition('=')
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = value
    except Exception as exc:
        print(f'[VTAB] Warning: could not load .env: {exc}')

if __name__ == '__main__':
    multiprocessing.freeze_support()
    data_root=Path(os.environ.get('VTAB_DATA_ROOT') or Path.home()/'.vtab-reporting-studio')
    data_root.mkdir(parents=True,exist_ok=True)
    startup_log=data_root/'backend-startup.log'
    try:
        startup_log.write_text('Starting VTAB local analytics engine...\n',encoding='utf-8')
        _load_env()
        duckdb.__version__
        os.environ.setdefault('VTAB_ENFORCE_API_AUTH','1')
        os.environ.setdefault('VTAB_DESKTOP_MODE','1')
        port=int(os.environ.get('VTAB_API_PORT','8820'))
        from app.server import app
        startup_log.write_text(f'VTAB local analytics engine ready on port {port}.\n',encoding='utf-8')
        # Windowed PyInstaller executables do not have stderr/stdout streams. Disable
        # Uvicorn's terminal-aware logging formatter or startup fails before binding.
        uvicorn.run(app, host='127.0.0.1', port=port, log_level='warning', access_log=False,log_config=None)
    except Exception:
        startup_log.write_text('VTAB backend startup failed:\n'+traceback.format_exc(),encoding='utf-8')
        raise
