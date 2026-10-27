param(
    [Parameter(Mandatory = $true)]
    [string]$ServicesProject
)

$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath $ServicesProject).Path
$required = @(
    (Join-Path $project 'src\v11\PublishedViewer.tsx'),
    (Join-Path $project 'src\formatting-authority.css')
)

foreach ($target in $required) {
    if (-not (Test-Path -LiteralPath $target)) {
        throw "This does not look like the VTAB Reporting Services project. Missing: $target"
    }
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $project ".vtab-backups\published-visual-parity-$stamp"
New-Item -ItemType Directory -Force -Path (Join-Path $backup 'src\v11') | Out-Null
Copy-Item -LiteralPath $required[0] -Destination (Join-Path $backup 'src\v11\PublishedViewer.tsx')
Copy-Item -LiteralPath $required[1] -Destination (Join-Path $backup 'src\formatting-authority.css')

$package = $PSScriptRoot
Copy-Item -LiteralPath (Join-Path $package 'src\v11\PublishedViewer.tsx') -Destination $required[0] -Force
Copy-Item -LiteralPath (Join-Path $package 'src\formatting-authority.css') -Destination $required[1] -Force

Write-Host "Services visual-parity update installed."
Write-Host "Backup: $backup"
Write-Host "Next: run npm run build:web in the Services project, then deploy the rebuilt Services frontend."
