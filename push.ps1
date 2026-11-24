$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
python "$scriptDir\scripts\push_service.py" @args
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
