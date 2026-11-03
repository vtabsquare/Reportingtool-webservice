"""VTAB Update Agent — polls the VTAB Reporting Manager and handles update webhooks.



Environment variables (never hardcoded):

    VTAB_MANAGER_URL            Base URL of the VTAB Reporting Manager.

    VTAB_CLIENT_ID              Client ID registered in the Manager.

    VTAB_AGENT_TOKEN            Bootstrap token issued on client registration.

    VTAB_WEBHOOK_SECRET         Optional secret for webhook authentication.

    VTAB_UPDATE_POLL_INTERVAL_SECONDS   Poll interval in seconds (default 300).

    VTAB_SIMULATE_BUILD         Set to '1' in test environments to simulate build without git.

    RENDER_API_KEY              Render API key -- when set together with RENDER_SERVICE_ID,
                                clicking 'Update Now' triggers a Render deploy automatically.

    RENDER_SERVICE_ID           The Render service ID (e.g. srv-xxxxxxxxxxxx) to redeploy.



This module is importable even when the env vars are absent; it logs a warning

and the polling thread simply does not start.

"""

from __future__ import annotations



import json

import logging

import os

import subprocess

import threading

import time

import urllib.error

import urllib.request

from pathlib import Path



logger = logging.getLogger(__name__)



# ---------------------------------------------------------------------------

# In-memory state (all guarded by _STATE_LOCK)

# ---------------------------------------------------------------------------

_STATE_LOCK = threading.Lock()



_update_status: dict = {

    'update_available': False,

    'current_version': None,

    'available_version': None,

    'release_notes': None,

    'component': None,

    'deployment_id': None,

}



_last_apply_result: dict = {}



# The deployment ID stored once a scheduled deployment is found.

_pending_deployment: dict | None = None

_store = None



# ---------------------------------------------------------------------------

# Helpers

# ---------------------------------------------------------------------------



def _manager_url() -> str:

    return (os.environ.get('VTAB_MANAGER_URL') or '').rstrip('/')



def _client_id() -> str:

    return os.environ.get('VTAB_CLIENT_ID') or ''



def _agent_token() -> str:

    return os.environ.get('VTAB_AGENT_TOKEN') or ''



def _poll_interval() -> int:

    try:

        return int(os.environ.get('VTAB_UPDATE_POLL_INTERVAL_SECONDS') or 300)

    except (ValueError, TypeError):

        return 300



def _project_root() -> Path:

    """Return the project root (two levels above this file: api/app -> api -> project)."""

    return Path(__file__).resolve().parent.parent.parent



def _current_version() -> str:

    try:

        from .version import PRODUCT_VERSION

        return PRODUCT_VERSION

    except Exception:

        return os.environ.get('VTAB_PRODUCT_VERSION', '6.1.10')



def _get_store():

    global _store

    if _store is None:

        try:

            from .storage import Store

            _store = Store()

        except Exception as exc:

            logger.warning('Could not initialize Store in update_agent: %s', exc)

    return _store



def _persist_update_event(event_type: str, deployment_id: str | None, version: str, status: str, details: dict | None = None) -> None:

    s = _get_store()

    if s:

        try:

            s.record_update_event(event_type, deployment_id, version, status, details)

        except Exception as exc:

            logger.warning('Failed to record update event in database: %s', exc)



def _persist_state(key: str, value: any) -> None:

    s = _get_store()

    if s:

        try:

            s.set_update_state(key, value)

        except Exception as exc:

            logger.warning('Failed to persist update state in database: %s', exc)



def _load_persisted_state() -> None:

    s = _get_store()

    if s:

        try:

            cached = s.get_update_state('current_offer')

            if cached and isinstance(cached, dict) and cached.get('update_available'):

                with _STATE_LOCK:

                    _update_status.update(cached)

                    global _pending_deployment

                    if cached.get('deployment_id'):

                        _pending_deployment = {

                            'id': cached.get('deployment_id'),

                            'target_version': cached.get('available_version'),

                            'release_notes': cached.get('release_notes'),

                            'component': cached.get('component'),

                        }

                logger.info('Restored pending update offer from database: version=%s', cached.get('available_version'))

        except Exception as exc:

            logger.warning('Failed to load persisted update state: %s', exc)



def _manager_request(method: str, path: str, payload: dict | None = None, timeout: int = 15) -> dict:

    """Make an authenticated request to the VTAB Manager and return parsed JSON."""

    mgr = _manager_url()
    if not mgr:
        return {}
    url = mgr + path

    body = json.dumps(payload).encode('utf-8') if payload is not None else None

    headers = {

        'X-VTAB-Client-ID': _client_id(),

        'X-VTAB-Agent-Token': _agent_token(),

        'Content-Type': 'application/json',

        'Accept': 'application/json',

    }

    req = urllib.request.Request(url, data=body, method=method, headers=headers)

    try:

        with urllib.request.urlopen(req, timeout=timeout) as resp:

            text = resp.read().decode('utf-8')

            return json.loads(text) if text else {}

    except urllib.error.HTTPError as exc:

        detail = exc.read().decode('utf-8', 'ignore')

        logger.warning('Manager HTTP %s %s → %s %s', method, path, exc.code, detail[:200])

        raise

    except Exception as exc:

        logger.warning('Manager request failed (%s %s): %s', method, path, exc)

        raise



def _report_deployment(deployment_id: str, status: str, message: str = '') -> None:

    """POST a status report to the Manager for the given deployment."""

    try:

        _manager_request(

            'POST',

            f'/api/v1/agent/deployments/{deployment_id}/report',

            {'status': status, 'message': message},

        )

    except Exception as exc:

        logger.warning('Failed to report deployment %s status=%s: %s', deployment_id, status, exc)


def _trigger_render_deploy() -> dict:
    """Trigger a Render service redeploy via the Render REST API.

    Requires RENDER_API_KEY. Uses RENDER_SERVICE_ID or defaults to production service ID.
    Returns a dict with keys 'ok' (bool) and optionally 'error' or 'deploy_id'.
    """
    api_key = (
        os.environ.get('RENDER_API_KEY') 
        or os.environ.get('RENDER_TOKEN') 
        or os.environ.get('RENDER_API_TOKEN') 
        or ''
    ).strip()
    service_id = (
        os.environ.get('RENDER_SERVICE_ID') 
        or os.environ.get('VTAB_RENDER_SERVICE_ID') 
        or 'srv-dbkmh4d9fdbs73bos7u0'
    ).strip()

    if not api_key:
        logger.warning('RENDER_API_KEY not set in environment variables.')
        return {'ok': False, 'error': 'RENDER_API_KEY is not set in Render environment variables'}
    if not service_id:
        return {'ok': False, 'error': 'RENDER_SERVICE_ID is not configured'}

    url = f'https://api.render.com/v1/services/{service_id}/deploys'
    payload = json.dumps({'clearCache': 'do_not_clear'}).encode('utf-8')
    req = urllib.request.Request(
        url,
        data=payload,
        method='POST',
        headers={
            'Authorization': f'Bearer {api_key}',
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = json.loads(resp.read().decode('utf-8'))
            deploy_id = body.get('id') or (body.get('deploy') or {}).get('id')
            logger.info('Render deploy triggered: service=%s deploy_id=%s', service_id, deploy_id)
            return {'ok': True, 'deploy_id': deploy_id}
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode('utf-8', 'ignore')
        logger.warning('Render API error %s: %s', exc.code, detail[:300])
        return {'ok': False, 'error': f'HTTP {exc.code}: {detail[:200]}'}
    except Exception as exc:
        logger.warning('Failed to trigger Render deploy: %s', exc)
        return {'ok': False, 'error': str(exc)}


# ---------------------------------------------------------------------------

# Public API

# ---------------------------------------------------------------------------



def get_update_status() -> dict:

    """Return the cached update status dict (never blocks)."""

    with _STATE_LOCK:

        res = dict(_update_status)

        if not res.get('current_version'):

            res['current_version'] = _current_version()

        apply_res = dict(_last_apply_result)
        phase = apply_res.get('phase')
        success = apply_res.get('success')
        res['applying'] = phase in ('preflight', 'git_pull', 'pip_install', 'npm_build', 'validating')
        res['last_apply_status'] = 'succeeded' if phase == 'succeeded' or success else ('failed' if success is False else phase)
        res['last_apply_message'] = apply_res.get('message') or ''
        return res



def get_last_apply_result() -> dict:

    """Return the result of the last `trigger_apply()` call."""

    with _STATE_LOCK:

        return dict(_last_apply_result)



def handle_update_webhook(payload: dict) -> dict:

    """Process an incoming update webhook from VTAB Reporting Manager or deployment pipeline.

    Supported events:

      - 'update_offered' / 'update_available' / 'scheduled'

      - 'update_cancelled' / 'cancelled'

      - 'ping'

    """

    event = payload.get('event') or payload.get('action') or 'update_offered'

    if event == 'ping':

        return {'ok': True, 'pong': True, 'service': 'Reporting Tool Services', 'current_version': _current_version()}



    if event in ('update_offered', 'update_available', 'scheduled'):

        deployment_id = payload.get('deployment_id') or payload.get('id')

        ver = payload.get('version') or payload.get('target_version') or payload.get('release_version')

        notes = payload.get('release_notes') or payload.get('releaseNotes') or ''

        comp = payload.get('component') or 'services'



        with _STATE_LOCK:

            global _pending_deployment

            _pending_deployment = {

                'id': deployment_id,

                'target_version': ver,

                'release_version': ver,

                'release_notes': notes,

                'component': comp,

            }

            _update_status.update({

                'update_available': True,

                'current_version': _current_version(),

                'available_version': ver,

                'release_notes': notes,

                'component': comp,

                'deployment_id': deployment_id,

            })



        _persist_update_event('webhook_offer_received', deployment_id, str(ver or 'unknown'), 'offered', payload)

        _persist_state('current_offer', _update_status)

        logger.info('Update offer received via webhook: version=%s deployment_id=%s', ver, deployment_id)

        return {'ok': True, 'event': 'update_offered', 'deployment_id': deployment_id, 'version': ver, 'status': 'offered'}



    elif event in ('update_cancelled', 'cancelled'):

        deployment_id = payload.get('deployment_id') or payload.get('id')

        with _STATE_LOCK:

            _pending_deployment = None

            _update_status['update_available'] = False

            _update_status['deployment_id'] = None

        _persist_update_event('webhook_offer_cancelled', deployment_id, str(_update_status.get('available_version') or 'unknown'), 'cancelled', payload)

        _persist_state('current_offer', None)

        logger.info('Update offer cancelled via webhook: deployment_id=%s', deployment_id)

        return {'ok': True, 'event': 'update_cancelled', 'deployment_id': deployment_id}



    return {'ok': False, 'error': f'Unrecognized event: {event}'}



# ---------------------------------------------------------------------------

# Polling loop

# ---------------------------------------------------------------------------



def _poll_once() -> None:

    """Single poll tick: check Manager for a scheduled deployment."""

    global _pending_deployment



    try:

        data = _manager_request('GET', '/api/v1/agent/updates/available?component=services')

    except Exception:

        try:

            data = _manager_request('GET', '/api/v1/agent/deployments/next')

        except Exception:

            return



    raw = data.get('update') or data.get('deployment') or data

    deployment = raw if isinstance(raw, dict) and raw.get('id') else None



    with _STATE_LOCK:

        if deployment:

            _pending_deployment = deployment

            ver = deployment.get('target_version') or deployment.get('release_version') or deployment.get('version')

            _update_status.update({

                'update_available': True,

                'current_version': _current_version(),

                'available_version': ver,

                'release_notes': deployment.get('release_notes') or deployment.get('releaseNotes') or '',

                'component': deployment.get('component'),

                'deployment_id': deployment.get('id'),

            })

            _persist_update_event('poll_offer_received', deployment.get('id'), str(ver), 'offered', deployment)

            _persist_state('current_offer', _update_status)

            logger.info('Update available via poll: version=%s deployment_id=%s', ver, deployment.get('id'))

        elif not deployment:

            _pending_deployment = None

            _update_status['update_available'] = False

            _update_status['deployment_id'] = None

            _persist_state('current_offer', None)



def _polling_loop() -> None:

    """Background daemon thread: poll repeatedly at the configured interval."""

    logger.info('VTAB update-agent polling loop started (interval=%ss)', _poll_interval())

    while True:

        try:

            _poll_once()

        except Exception as exc:

            logger.warning('Unexpected error in update-agent poll: %s', exc)

        time.sleep(_poll_interval())



# ---------------------------------------------------------------------------

# Apply flow

# ---------------------------------------------------------------------------



def trigger_apply() -> None:

    """Run the full update flow in the calling thread (call via a daemon Thread)."""

    global _pending_deployment



    with _STATE_LOCK:

        deployment = _pending_deployment

        deployment_id = (deployment or {}).get('id')

        ver = _update_status.get('available_version') or 'unknown'



    def _set_result(phase: str, success: bool, message: str = '') -> None:

        with _STATE_LOCK:

            _last_apply_result.update({

                'phase': phase,

                'success': success,

                'message': message,

                'timestamp': time.time(),

            })



    def _run(cmd: list[str], cwd: Path) -> tuple[int, str]:

        try:

            result = subprocess.run(

                cmd,

                cwd=str(cwd),

                capture_output=True,

                text=True,

                timeout=600,

            )

            return result.returncode, (result.stdout + result.stderr).strip()

        except Exception as exc:

            return 1, str(exc)



    root = _project_root()



    try:

        # --- preflight ---

        _set_result('preflight', True, 'Starting update')

        _persist_update_event('preflight', deployment_id, ver, 'preflight')

        if deployment_id:

            _report_deployment(deployment_id, 'preflight', 'Starting update')



        # Trigger Render deploy if running on Render or configured
        is_render = bool(
            os.environ.get('RENDER')
            or os.environ.get('RENDER_INSTANCE_ID')
            or os.environ.get('RENDER_SERVICE_ID')
            or os.environ.get('RENDER_API_KEY')
        )
        if is_render:
            render_result = _trigger_render_deploy()
            if render_result.get('ok'):
                logger.info('Render deploy triggered automatically (deploy_id=%s)', render_result.get('deploy_id'))
                _set_result('deploying', True, 'Render deploy triggered — building in cloud...')
                _persist_update_event('render_deploy_triggered', deployment_id, ver, 'deploying', render_result)
                if deployment_id:
                    _report_deployment(deployment_id, 'deploying', 'Render deploy triggered — building in cloud')
                with _STATE_LOCK:
                    _pending_deployment = None
                    _update_status['update_available'] = False
                    _update_status['deployment_id'] = None
                    _update_status['current_version'] = ver
                _persist_state('current_offer', None)
                _set_result('succeeded', True, 'Render deploy triggered — your app will reload once the build completes (~2 min)')
                _persist_update_event('apply_succeeded', deployment_id, ver, 'succeeded', {'render_deploy': render_result})
                if deployment_id:
                    _report_deployment(deployment_id, 'succeeded', 'Render deploy triggered successfully')
                return
            else:
                err_msg = render_result.get('error') or 'Render deploy failed'
                logger.warning('Render deploy failed: %s', err_msg)
                _set_result('failed', False, f'Render cloud deploy failed: {err_msg}')
                _persist_update_event('apply_failed', deployment_id, ver, 'failed', {'error': err_msg})
                if deployment_id:
                    _report_deployment(deployment_id, 'failed', err_msg)
                return


        # Check for simulated test mode

        if os.environ.get('VTAB_SIMULATE_BUILD') == '1':

            time.sleep(0.3)

            _set_result('succeeded', True, 'Simulated update completed successfully')

            _persist_update_event('apply_succeeded', deployment_id, ver, 'succeeded', {'simulated': True})

            if deployment_id:

                _report_deployment(deployment_id, 'succeeded', 'Simulated update completed successfully')

            with _STATE_LOCK:

                _pending_deployment = None

                _update_status['update_available'] = False

                _update_status['deployment_id'] = None

                _update_status['current_version'] = ver

            _persist_state('current_offer', None)

            return



        import shutil
        has_git = bool(shutil.which('git')) and (root / '.git').exists()
        if has_git:
            # --- git pull ---
            _set_result('git_pull', True, 'Running git pull')
            _persist_update_event('git_pull', deployment_id, ver, 'deploying')
            rc, out = _run(['git', 'pull', 'origin', 'main'], root)
            if rc != 0:
                msg = f'git pull failed: {out[:500]}'
                _set_result('git_pull', False, msg)
                _persist_update_event('apply_failed', deployment_id, ver, 'failed', {'phase': 'git_pull', 'error': msg})
                if deployment_id:
                    _report_deployment(deployment_id, 'failed', msg)
                return
        else:
            logger.info('Container or cloud runtime detected without git repository. Proceeding with deployment.')

        # --- deploying (pip install) ---
        if deployment_id:
            _report_deployment(deployment_id, 'deploying', 'Installing Python dependencies')
        _set_result('pip_install', True, 'Running pip install')
        _persist_update_event('pip_install', deployment_id, ver, 'deploying')
        req_file = root / 'requirements.txt'
        if req_file.exists() and shutil.which('pip'):
            rc, out = _run(['pip', 'install', '-r', str(req_file)], root)
            if rc != 0:
                msg = f'pip install failed: {out[:500]}'
                _set_result('pip_install', False, msg)
                _persist_update_event('apply_failed', deployment_id, ver, 'failed', {'phase': 'pip_install', 'error': msg})
                if deployment_id:
                    _report_deployment(deployment_id, 'failed', msg)
                return

        # --- frontend rebuild (optional) ---
        pkg_json = root / 'package.json'
        if pkg_json.exists() and shutil.which('npm'):
            _set_result('npm_build', True, 'Rebuilding frontend')
            _persist_update_event('npm_build', deployment_id, ver, 'deploying')
            rc, out = _run(['npm', 'ci'], root)
            if rc != 0:
                msg = f'npm ci failed: {out[:500]}'
                _set_result('npm_build', False, msg)
                _persist_update_event('apply_failed', deployment_id, ver, 'failed', {'phase': 'npm_ci', 'error': msg})
                if deployment_id:
                    _report_deployment(deployment_id, 'failed', msg)
                return
            rc, out = _run(['npm', 'run', 'build'], root)
            if rc != 0:
                msg = f'npm run build failed: {out[:500]}'
                _set_result('npm_build', False, msg)
                _persist_update_event('apply_failed', deployment_id, ver, 'failed', {'phase': 'npm_build', 'error': msg})
                if deployment_id:
                    _report_deployment(deployment_id, 'failed', msg)
                return

        # --- validating / succeeded ---

        if deployment_id:

            _report_deployment(deployment_id, 'validating', 'Validating deployment')

        _persist_update_event('validating', deployment_id, ver, 'validating')

        _set_result('succeeded', True, 'Update applied successfully')

        _persist_update_event('apply_succeeded', deployment_id, ver, 'succeeded')

        if deployment_id:

            _report_deployment(deployment_id, 'succeeded', 'Update applied successfully')



        # Clear the pending deployment after a successful apply.

        with _STATE_LOCK:

            _pending_deployment = None

            _update_status['update_available'] = False

            _update_status['deployment_id'] = None

            _update_status['current_version'] = ver

        _persist_state('current_offer', None)



    except Exception as exc:

        msg = f'Unexpected error during apply: {exc}'

        logger.exception('update_agent.trigger_apply raised an unexpected error')

        _set_result('failed', False, msg)

        _persist_update_event('apply_failed', deployment_id, ver, 'failed', {'error': str(exc)})

        if deployment_id:

            _report_deployment(deployment_id, 'failed', msg)



# ---------------------------------------------------------------------------

# Startup

# ---------------------------------------------------------------------------



def start_update_agent() -> None:

    """Start the background polling thread and load any persisted offer."""

    _load_persisted_state()



    if not (_manager_url() and _client_id() and _agent_token()):

        logger.warning(

            'VTAB update-agent: VTAB_MANAGER_URL, VTAB_CLIENT_ID, or VTAB_AGENT_TOKEN '

            'not set — update polling disabled.'

        )

        return



    t = threading.Thread(target=_polling_loop, daemon=True, name='vtab-update-agent')

    t.start()

    logger.info('VTAB update-agent started (thread=%s)', t.name)

