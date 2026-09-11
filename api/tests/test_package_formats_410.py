import json, zipfile
from pathlib import Path

from app.demo import blank_project
from app.package_service import export_package, inspect_package


def test_vtabapp_contains_definition_without_data():
    p=blank_project('Portable Sales')
    out,name=export_package(p,'.vtabapp')
    try:
        assert name.endswith('.vtabapp')
        m=inspect_package(out,'.vtabapp')
        assert m['kind']=='application-definition'
        assert m['tables']==[]
        assert m['security']['credentialsIncluded'] is False
        with zipfile.ZipFile(out) as z:
            assert 'application/project.json' in z.namelist()
            assert not any(n.startswith('data/') for n in z.namelist())
    finally: out.unlink(missing_ok=True)


def test_package_extension_contract_is_exact():
    p=blank_project('Contract')
    for ext,kind in [('.vtabapp','application-definition'),('.vtabpkg','complete-application'),('.vtabdata','data-only')]:
        out,_=export_package(p,ext)
        try:
            assert inspect_package(out,ext)['kind']==kind
        finally: out.unlink(missing_ok=True)
