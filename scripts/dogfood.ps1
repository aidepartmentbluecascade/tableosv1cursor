# Tabula local dogfood (Windows). Requires Docker, Node 22+, pnpm 9.
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

Write-Host "[dogfood] delegating to scripts/dogfood.mjs …" -ForegroundColor Cyan
node (Join-Path $PSScriptRoot "dogfood.mjs")
exit $LASTEXITCODE
