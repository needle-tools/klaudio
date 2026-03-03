# claude-sounds installer for Windows PowerShell
# Usage: irm https://raw.githubusercontent.com/user/claude-sounds/main/install.ps1 | iex
#
# Runs the interactive claude-sounds setup via npx.
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
Write-Host "  🔊 Installing Claude Sounds..." -ForegroundColor Cyan
Write-Host ""

npx claude-sounds @args
