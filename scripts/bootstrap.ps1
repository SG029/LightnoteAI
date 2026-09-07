#Requires -Version 5.1
<#
    Installs the system-level prerequisites LightEdit needs, via winget.

    This is PowerShell rather than Node because Node is itself one of the
    things it installs - `npm run setup` cannot be the first command a fresh
    machine runs. Everything downstream of Node (npm packages, the Python
    virtualenv, PyTorch) is `npm run setup`'s job, not this script's.

    Only missing tools are installed, so it is safe to re-run.

        powershell -ExecutionPolicy Bypass -File scripts\bootstrap.ps1

    winget elevates for machine-wide installs, so expect UAC prompts.

    Keep this file ASCII-only: Windows PowerShell 5.1 reads a .ps1 as ANSI
    unless it has a BOM, and a stray multi-byte character breaks string
    parsing in ways that echo the script instead of running it.
#>
[CmdletBinding()]
param(
    # Skip MongoDB - for anyone using Atlas or `docker compose up -d` instead.
    [switch]$SkipMongo
)

$ErrorActionPreference = "Stop"

function Write-Step($text) { Write-Host "`n$text" -ForegroundColor Cyan }
function Write-Ok($text)   { Write-Host "    [ok]   $text" -ForegroundColor Green }
function Write-Miss($text) { Write-Host "    [..]   $text" -ForegroundColor Yellow }
function Write-Bad($text)  { Write-Host "    [!!]   $text" -ForegroundColor Red }

# winget updates the machine PATH, but not the PATH of a shell that is already
# running - so rebuild it here, otherwise every check after an install fails.
function Update-SessionPath {
    $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $user    = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = ($machine, $user | Where-Object { $_ }) -join ";"
}

function Test-Tool($name) {
    $null -ne (Get-Command $name -ErrorAction SilentlyContinue)
}

function Install-Package($id, $label) {
    Write-Miss "$label - installing $id"
    winget install --id $id --exact --source winget `
        --accept-package-agreements --accept-source-agreements `
        --disable-interactivity
    if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne -1978335189) {
        # -1978335189 is "no applicable upgrade / already installed".
        throw "winget failed to install $id (exit $LASTEXITCODE)"
    }
    Update-SessionPath
    Write-Ok $label
}

Write-Host "`n  LightEdit prerequisites" -ForegroundColor White
Write-Host "  -----------------------"

if (-not (Test-Tool "winget")) {
    Write-Bad "winget is not available."
    Write-Host "         Install 'App Installer' from the Microsoft Store, then re-run this script."
    Write-Host "         Or install Node, Python, ffmpeg and MongoDB by hand - see the README.`n"
    exit 1
}

Update-SessionPath

# ---- Node --------------------------------------------------
Write-Step "Node 20+"
$nodeOk = $false
if (Test-Tool "node") {
    $major = [int](((node --version) -replace "^v", "") -split "\.")[0]
    if ($major -ge 20) {
        Write-Ok "node $(node --version)"
        $nodeOk = $true
    } else {
        Write-Miss "node $(node --version) is too old"
    }
}
if (-not $nodeOk) { Install-Package "OpenJS.NodeJS.LTS" "node" }

# ---- Python --------------------------------------------------
Write-Step "Python 3.10+"
$pythonOk = $false
if (Test-Tool "python") {
    # A bare "python" on Windows is often the Store alias stub, which prints
    # nothing useful and exits non-zero. Treat that as "not installed".
    $version = (cmd /c "python --version" 2>&1) -join ""
    if ($version -match "Python (\d+)\.(\d+)") {
        $ok = ([int]$Matches[1] -gt 3) -or ([int]$Matches[1] -eq 3 -and [int]$Matches[2] -ge 10)
        if ($ok) {
            Write-Ok $version.Trim().ToLower()
            $pythonOk = $true
        } else {
            Write-Miss "$($version.Trim()) is too old"
        }
    }
}
if (-not $pythonOk) { Install-Package "Python.Python.3.12" "python" }

# ---- ffmpeg --------------------------------------------------
Write-Step "ffmpeg"
if ((Test-Tool "ffmpeg") -and (Test-Tool "ffprobe")) {
    Write-Ok "ffmpeg"
} else {
    Install-Package "Gyan.FFmpeg" "ffmpeg"
}

# ---- MongoDB --------------------------------------------------
Write-Step "MongoDB"
if ($SkipMongo) {
    Write-Ok "skipped (-SkipMongo) - point MONGODB_URI at your own instance"
} else {
    # Anything listening on 27017 counts: a service, a container, or a tunnel.
    $listening = $false
    try {
        $probe = New-Object Net.Sockets.TcpClient
        $listening = $probe.ConnectAsync("127.0.0.1", 27017).Wait(1200)
        $probe.Close()
    } catch { $listening = $false }

    if ($listening) {
        Write-Ok "something is already serving 127.0.0.1:27017"
    } else {
        Install-Package "MongoDB.Server" "mongodb"
        $service = Get-Service -Name "MongoDB" -ErrorAction SilentlyContinue
        if ($service -and $service.Status -ne "Running") {
            Start-Service -Name "MongoDB"
            Write-Ok "started the MongoDB service"
        }
    }
}

# ---- GPU (informational) ----------------------------------------------
Write-Step "GPU"
if (Test-Tool "nvidia-smi") {
    $gpu = (nvidia-smi --query-gpu=name,memory.total --format=csv,noheader | Select-Object -First 1)
    Write-Ok "$gpu"
} else {
    Write-Miss "no NVIDIA GPU detected - the pipeline will run on CPU (minutes per clip)"
}

# ---- Next --------------------------------------------------
Write-Host "`n  Prerequisites are in place." -ForegroundColor Green
Write-Host "  Open a NEW terminal (so it picks up the updated PATH), then:`n"
Write-Host "      npm install"
Write-Host "      npm run setup"
Write-Host "`n  You will also need a free Gemini API key: https://aistudio.google.com/apikey`n"
