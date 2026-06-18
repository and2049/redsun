#Requires -Version 5.0
[CmdletBinding()]
param(
    [Alias("v")]
        [string]$Version,
    [switch]$NoModifyPath,
    [switch]$Help
)

$ErrorActionPreference = "Stop"
$App = "redsun"
$Repo = "and2049/redsun"

if ($Help) {
    Write-Host @"
Redsun Installer

Usage: install.ps1 [options]

Options:
    -Version <version>   Install a specific version (e.g., 1.0.205)
    -NoModifyPath        Don't add redsun to user PATH
    -Help                Display this help message

Examples:
    irm https://github.com/$Repo/releases/latest/download/install.ps1 | iex
    & ([scriptblock]::Create((irm https://github.com/$Repo/releases/latest/download/install.ps1))) -Version 1.0.205
"@
    exit 0
}

function Write-Info  { param([string]$msg) Write-Host $msg -ForegroundColor Gray }
function Write-Error { param([string]$msg) Write-Host $msg -ForegroundColor Red }
function Write-Warn  { param([string]$msg) Write-Host $msg -ForegroundColor Yellow }

# --- Detect platform ---

$os = "windows"
$arch = $env:PROCESSOR_ARCHITECTURE
if ($arch -eq "AMD64") { $arch = "x64" }
if ($arch -eq "ARM64") { $arch = "arm64" }

$combo = "$os-$arch"
if ($combo -ne "windows-x64") {
    Write-Error "Unsupported OS/Arch: $os/$arch. Windows x64 is the only supported platform for this installer."
    exit 1
}

# AVX2 baseline detection
$needsBaseline = $false
try {
    $cpuInfo = Get-CimInstance -ClassName Win32_Processor -ErrorAction Stop
    # We can't directly query AVX2 from WMI; use a heuristic via the CPU name.
    # Baseline builds target CPUs without AVX2 (pre-2013 Intel/AMD).
    # There's no clean WMI query for AVX2, so we skip baseline detection on Windows
    # and always ship the AVX2 build. Users on old CPUs can manually pass -Version
    # with a baseline-tagged release if needed.
} catch {}

$target = "$os-$arch"
if ($needsBaseline) { $target = "$target-baseline" }

$archiveExt = ".zip"
$filename = "$App-$target$archiveExt"

# --- Determine version and URL ---

if ($Version) {
    $Version = $Version -replace '^v', ''
    $url = "https://github.com/$Repo/releases/download/v$Version/$filename"
    $specificVersion = $Version
    $tagUrl = "https://github.com/$Repo/releases/tag/v$Version"
    try {
        $resp = Invoke-WebRequest -Uri $tagUrl -Method Head -ErrorAction Stop
    } catch {
        Write-Error "Release v$Version not found"
        Write-Info "Available releases: https://github.com/$Repo/releases"
        exit 1
    }
} else {
    $url = "https://github.com/$Repo/releases/latest/download/$filename"
    try {
        $apiUrl = "https://api.github.com/repos/$Repo/releases/latest"
        $release = Invoke-RestMethod -Uri $apiUrl -ErrorAction Stop
        $specificVersion = $release.tag_name -replace '^v', ''
    } catch {
        Write-Error "Failed to fetch version information"
        exit 1
    }
}

# --- Check existing version ---

$existingCommand = Get-Command $App -ErrorAction SilentlyContinue
if ($existingCommand) {
    try {
        $versionOutput = & $App version 2>$null
        if ($versionOutput) {
            $installedVersion = ($versionOutput -split '\s+')[1]
            if ($installedVersion -eq $specificVersion) {
                Write-Info "Version $specificVersion already installed"
                exit 0
            } else {
                Write-Info "Installed version: $installedVersion"
            }
        }
    } catch {}
}

# --- Install ---

$installDir = Join-Path $env:USERPROFILE ".redsun\bin"
if (-not (Test-Path $installDir)) {
    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
}

Write-Info "Installing redsun version: $specificVersion"

$tmpDir = Join-Path $env:TEMP "redsun_install_$PID"
if (-not (Test-Path $tmpDir)) {
    New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
}

$archivePath = Join-Path $tmpDir $filename

try {
    Invoke-WebRequest -Uri $url -OutFile $archivePath -ErrorAction Stop
} catch {
    Write-Error "Failed to download $filename"
    exit 1
}

Expand-Archive -Path $archivePath -DestinationPath $tmpDir -Force

# The zip contains the binary as "redsun" (no .exe). Rename it.
$extractedBinary = Join-Path $tmpDir "$App"
$destBinary = Join-Path $installDir "$App.exe"
if (-not (Test-Path $extractedBinary)) {
    $extractedBinary = Join-Path $tmpDir "$App.exe"
}
if (-not (Test-Path $extractedBinary)) {
    Write-Error "Could not find $App or $App.exe in extracted archive"
    exit 1
}

Move-Item -Path $extractedBinary -Destination $destBinary -Force
Remove-Item -Path $tmpDir -Recurse -Force

# --- Add to PATH ---

if (-not $NoModifyPath) {
    $userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
    if ($userPath -notlike "*$installDir*") {
        $newPath = if ($userPath) { "$installDir;$userPath" } else { $installDir }
        [Environment]::SetEnvironmentVariable("PATH", $newPath, "User")
        Write-Info "Successfully added redsun to PATH (User environment variable)"
        Write-Info "Restart your terminal for the change to take effect"
    } else {
        Write-Info "redsun is already in your PATH"
    }
}

# GitHub Actions support
if ($env:GITHUB_ACTIONS -eq "true") {
    $githubPath = $env:GITHUB_PATH
    if ($githubPath) {
        Add-Content -Path $githubPath -Value $installDir
        Write-Info "Added $installDir to `$GITHUB_PATH"
    }
}

# --- Banner ---

Write-Host ""
Write-Host "██╗      ██████╗ ███████╗██████╗ ███████╗██╗   ██╗███╗   ██╗"
Write-Host "╚██╗     ██╔══██╗██╔════╝██╔══██╗██╔════╝██║░░░██║████╗░░██║"
Write-Host " ╚██╗    ██████╔╝█████╗░░██║░░██║███████╗██║░░░██║██╔██╗░██║"
Write-Host " ██╔╝    ██╔══██╗██╔══╝░░██║░░██║╚════██║██║░░░██║██║╚██╗██║"
Write-Host "██╔╝     ██║  ██║███████╗██████╔╝███████║╚██████╔╝██║░╚████║"
Write-Host "╚═╝      ╚═╝  ╚═╝╚══════╝╚═════╝ ╚══════╝ ╚═════╝ ╚═╝  ╚═══╝"
Write-Host ""
Write-Host ""
Write-Info "To start using redsun:"
Write-Host ""
Write-Info "cd <project>  # Open a project directory"
Write-Info "redsun        # Run redsun"
Write-Host ""
Write-Info "For more information visit https://github.com/$Repo"
Write-Host ""
Write-Host ""
