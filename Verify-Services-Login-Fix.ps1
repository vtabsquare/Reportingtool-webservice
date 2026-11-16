param(
  [string]$BaseUrl = "https://reportservices.vtabsquare.com"
)

$ErrorActionPreference = "Stop"
$base = $BaseUrl.TrimEnd("/")

function Invoke-Check([string]$Name, [scriptblock]$Action) {
  try {
    $result = & $Action
    Write-Host "[PASS] $Name - $result" -ForegroundColor Green
    return $true
  } catch {
    Write-Host "[FAIL] $Name - $($_.Exception.Message)" -ForegroundColor Red
    return $false
  }
}

$healthOk = Invoke-Check "VTAB API health" {
  $response = Invoke-WebRequest -Uri "$base/api/v1/health" -UseBasicParsing -TimeoutSec 20
  if ($response.StatusCode -ne 200) { throw "HTTP $($response.StatusCode)" }
  "HTTP 200"
}

$routeOk = Invoke-Check "Same-origin cloud login route" {
  $payload = @{ email = "route-check@vtab.invalid"; password = "not-a-real-password" } | ConvertTo-Json
  try {
    Invoke-WebRequest -Uri "$base/api/v1/auth/supabase-login" -Method Post -ContentType "application/json" -Body $payload -UseBasicParsing -TimeoutSec 35 | Out-Null
    throw "The invalid test credentials were unexpectedly accepted."
  } catch {
    $response = $_.Exception.Response
    if (-not $response) { throw }
    $status = [int]$response.StatusCode
    $body = $_.ErrorDetails.Message
    if ($status -eq 401 -and $body -match "Secure authoring sign-in required") {
      throw "Old backend is still active; deploy server.py and restart the API container."
    }
    if ($status -eq 501 -or $body -match "Unsupported method") {
      throw "The request reached the static server; fix the /api/v1 reverse-proxy route."
    }
    if ($status -notin @(401, 503)) { throw "Unexpected HTTP $status - $body" }
    "HTTP $status (route is deployed)"
  }
}

$cloudOk = Invoke-Check "Supabase Auth health through VTAB" {
  try {
    $response = Invoke-WebRequest -Uri "$base/api/v1/auth/cloud-status" -UseBasicParsing -TimeoutSec 20
    if ($response.StatusCode -ne 200) { throw "HTTP $($response.StatusCode)" }
    "available"
  } catch {
    $response = $_.Exception.Response
    if ($response -and [int]$response.StatusCode -eq 503) {
      throw "Supabase Auth is unavailable. Resume or restart the Supabase project."
    }
    throw
  }
}

if (-not ($healthOk -and $routeOk -and $cloudOk)) { exit 1 }
Write-Host "Services login path is ready." -ForegroundColor Cyan
