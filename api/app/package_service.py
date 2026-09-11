from __future__ import annotations

import copy
import hashlib
import json
import os
import tempfile
import time
import uuid
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any

from .storage import DATA, Store
from .local_engine import CATALOG, import_path, ensure_analytics_ready, _load_catalog
from .version import PRODUCT_VERSION

PACKAGE_VERSION = '1.0'
FORMATS = {
    '.vtabapp': 'application-definition',
    '.vtabpkg': 'complete-application',
    '.vtabdata': 'data-only',
}
_SECRET_MARKERS = ('password','secret','token','apikey','api_key','accesskey','privatekey','clientsecret','credential')


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(8 * 1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def _scrub_secrets(value: Any, key: str = '') -> Any:
    """Remove credentials from portable package metadata.

    Connection credentials should be remapped on the destination installation and
    must never travel in a VTAB package.
    """
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            kl = str(k).lower()
            if any(m in kl for m in _SECRET_MARKERS):
                out[k] = None if v is not None else v
                if v not in (None, '', False):
                    out[f'{k}Required'] = True
            else:
                out[k] = _scrub_secrets(v, str(k))
        return out
    if isinstance(value, list):
        return [_scrub_secrets(v, key) for v in value]
    return value


def _catalog() -> dict:
    try:
        return _load_catalog()
    except Exception:
        return {'tables': {}}


def _project_tables(project: dict) -> list[str]:
    names: list[str] = []
    def add(v):
        if isinstance(v, str) and v and v not in names:
            names.append(v)
    for info in (project.get('model', {}).get('tables', {}) or {}).values():
        add((info or {}).get('physical'))
    for q in project.get('transform', {}).get('queries', []) or []:
        add((q or {}).get('source'))
        for step in (q or {}).get('steps', []) or []:
            for k in ('otherTable','table','sourceTable','lookupTable'):
                add((step or {}).get(k))
    return names


def _table_entries(project: dict | None, data_only: bool = False) -> list[dict]:
    cat = _catalog().get('tables', {}) or {}
    requested = _project_tables(project or {})
    result = []
    for name in requested:
        entry = cat.get(name) or {}
        p = Path(entry.get('path', ''))
        if p.exists() and p.suffix.lower() == '.parquet':
            result.append({
                'name': name,
                'kind': entry.get('kind', 'managed'),
                'rows': entry.get('rows'),
                'path': p,
                'bytes': p.stat().st_size,
            })
    return result


def _manifest(kind: str, extension: str, project: dict | None, tables: list[dict], files: list[dict]) -> dict:
    return {
        'schema': 'vtab-portable-package',
        'packageVersion': PACKAGE_VERSION,
        'productVersion': PRODUCT_VERSION,
        'format': extension,
        'kind': kind,
        'createdAtEpoch': int(time.time()),
        'project': None if project is None else {
            'id': project.get('id'),
            'name': project.get('name'),
            'reportName': (project.get('report') or {}).get('name'),
        },
        'tables': [
            {'name': t['name'], 'kind': t['kind'], 'rows': t.get('rows'), 'bytes': t['bytes'], 'file': f"data/{t['name']}.parquet"}
            for t in tables
        ],
        'files': files,
        'security': {
            'credentialsIncluded': False,
            'checksums': 'SHA-256',
            'pathTraversalProtection': True,
        },
    }


def export_package(project: dict, extension: str) -> tuple[Path, str]:
    extension = extension.lower()
    if extension not in FORMATS:
        raise ValueError('Unsupported VTAB package format.')
    kind = FORMATS[extension]
    include_project = extension in ('.vtabapp', '.vtabpkg')
    include_data = extension in ('.vtabpkg', '.vtabdata')
    safe_project = _scrub_secrets(copy.deepcopy(project)) if include_project else None
    tables = _table_entries(project, data_only=(extension == '.vtabdata')) if include_data else []

    base_name = ((project.get('report') or {}).get('name') or project.get('name') or 'VTAB_Application').strip()
    safe_name = ''.join(c if c.isalnum() or c in ('-','_',' ') else '_' for c in base_name).strip().replace(' ', '_') or 'VTAB_Application'
    filename = safe_name + extension
    fd, tmp_name = tempfile.mkstemp(prefix='vtab_export_', suffix=extension)
    os.close(fd)
    out = Path(tmp_name)

    files_meta: list[dict] = []
    payloads: list[tuple[str, bytes | Path]] = []
    if safe_project is not None:
        data = json.dumps(safe_project, indent=2, ensure_ascii=False).encode('utf-8')
        payloads.append(('application/project.json', data))
        files_meta.append({'path': 'application/project.json', 'sha256': _sha256_bytes(data), 'bytes': len(data)})
    for t in tables:
        arc = f"data/{t['name']}.parquet"
        payloads.append((arc, t['path']))
        files_meta.append({'path': arc, 'sha256': _sha256_file(t['path']), 'bytes': t['bytes']})

    manifest = _manifest(kind, extension, safe_project, tables, files_meta)
    manifest_bytes = json.dumps(manifest, indent=2, ensure_ascii=False).encode('utf-8')
    with zipfile.ZipFile(out, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        z.writestr('manifest.json', manifest_bytes)
        for arc, source in payloads:
            if isinstance(source, Path):
                z.write(source, arcname=arc)
            else:
                z.writestr(arc, source)
    return out, filename


def _validate_member(name: str):
    p = PurePosixPath(name)
    if p.is_absolute() or '..' in p.parts or '\\' in name:
        raise ValueError(f'Unsafe package path: {name}')
    allowed_roots = {'manifest.json', 'application', 'data'}
    root = p.parts[0] if p.parts else ''
    if root not in allowed_roots:
        raise ValueError(f'Unexpected package entry: {name}')


def inspect_package(path: Path, expected_extension: str | None = None) -> dict:
    max_uncompressed = int(os.environ.get('VTAB_MAX_PACKAGE_UNCOMPRESSED_MB', '10240')) * 1024 * 1024
    if not zipfile.is_zipfile(path):
        raise ValueError('File is not a valid VTAB portable package.')
    with zipfile.ZipFile(path, 'r') as z:
        infos = z.infolist()
        total = sum(i.file_size for i in infos)
        if total > max_uncompressed:
            raise ValueError('Package exceeds VTAB_MAX_PACKAGE_UNCOMPRESSED_MB.')
        for i in infos:
            _validate_member(i.filename)
        if 'manifest.json' not in z.namelist():
            raise ValueError('VTAB package manifest.json is missing.')
        manifest = json.loads(z.read('manifest.json').decode('utf-8'))
        if manifest.get('schema') != 'vtab-portable-package':
            raise ValueError('Unsupported package schema.')
        fmt = manifest.get('format')
        if fmt not in FORMATS:
            raise ValueError('Unsupported package format in manifest.')
        if expected_extension and expected_extension.lower() != fmt:
            raise ValueError(f'Package extension does not match manifest ({fmt}).')
        names = set(z.namelist())
        for f in manifest.get('files', []) or []:
            fp = f.get('path')
            if fp not in names:
                raise ValueError(f'Package payload missing: {fp}')
            raw = z.read(fp)
            if _sha256_bytes(raw) != f.get('sha256'):
                raise ValueError(f'Checksum validation failed: {fp}')
        return manifest


def import_package(path: Path, store: Store) -> dict:
    ext = path.suffix.lower()
    if ext not in FORMATS:
        raise ValueError('Use .vtabapp, .vtabpkg or .vtabdata.')
    manifest = inspect_package(path, ext)
    imported_tables = []
    project = None
    if manifest.get('tables'):
        ensure_analytics_ready()
    with zipfile.ZipFile(path, 'r') as z, tempfile.TemporaryDirectory(prefix='vtab_pkg_') as td:
        temp_root = Path(td)
        for t in manifest.get('tables', []) or []:
            name = str(t.get('name') or '').strip()
            arc = str(t.get('file') or '')
            if not name or not arc.startswith('data/'):
                raise ValueError('Invalid table metadata in VTAB package.')
            target = temp_root / (name + '.parquet')
            target.write_bytes(z.read(arc))
            rows = import_path(target, name, target.stat().st_size)
            imported_tables.append({'name': name, 'rows': rows})
        if ext in ('.vtabapp', '.vtabpkg'):
            if 'application/project.json' not in z.namelist():
                raise ValueError('Application package is missing application/project.json.')
            project = json.loads(z.read('application/project.json').decode('utf-8'))
            # Import as an independent saved authoring snapshot. The currently
            # open project remains untouched and the UI opens this report in a
            # separate application tab.
            project['id'] = 'current'
            report = project.get('report') or {}
            report['id'] = str(uuid.uuid4())
            report['name'] = report.get('name') or project.get('name') or 'Imported Application'
            project['report'] = report
            project['name'] = report['name']
            store.save_report(report, project)
            store.log('package.import', {'format': ext, 'project': project.get('name'), 'reportId': report['id'], 'tables': [t['name'] for t in imported_tables]})
        else:
            store.log('package.data.import', {'format': ext, 'tables': [t['name'] for t in imported_tables]})
    return {
        'ok': True,
        'format': ext,
        'kind': manifest.get('kind'),
        'project': project,
        'openReportId': (project or {}).get('report', {}).get('id'),
        'tables': imported_tables,
        'manifest': manifest,
    }
