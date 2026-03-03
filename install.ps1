# clonk installer for Windows PowerShell
# Usage: irm https://raw.githubusercontent.com/user/clonk/main/install.ps1 | iex
#
# Runs the interactive clonk setup via npx.
# Requires Node.js 18+ (which Claude Code already requires).

$ErrorActionPreference = "Stop"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Error: Node.js is required but not found." -ForegroundColor Red
    Write-Host "Claude Code requires Node.js 18+ - install it from https://nodejs.org"
    exit 1
}

$nodeVersion = (node -v) -replace 'v', '' -split '\.' | Select-Object -First 1
if ([int]$nodeVersion -lt 18) {
    Write-Host "Error: Node.js 18+ is required (found $(node -v))" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "  🔊 Installing Clonk..." -ForegroundColor Cyan
Write-Host ""

npx clonk @args
