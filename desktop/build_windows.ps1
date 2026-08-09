[CmdletBinding()]
param(
    [string]$OutputDirectory = (Join-Path $PSScriptRoot "..\dist"),
    [string]$Password = $env:USGI_BUILD_PASSWORD,
    [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$desktopRoot = Join-Path $repoRoot "desktop"
$venvRoot = Join-Path $repoRoot "work\desktop-venv"
$python = Join-Path $venvRoot "Scripts\python.exe"
$artifactName = "US_Generation_Intelligence_v3.0.1"

if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
    python -m venv $venvRoot
}

if (-not $SkipInstall) {
    & $python -m pip install --upgrade pip
    & $python -m pip install -r (Join-Path $desktopRoot "requirements.txt")
}

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$passwordHash = ""
if (-not [string]::IsNullOrWhiteSpace($Password)) {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Password)
    $digest = [Security.Cryptography.SHA256]::Create()
    try {
        $passwordHash = (($digest.ComputeHash($bytes) | ForEach-Object { $_.ToString("x2") }) -join "")
    }
    finally {
        $digest.Dispose()
    }
}

$generatedConfig = Join-Path $desktopRoot "build_config.py"
Set-Content -LiteralPath $generatedConfig -Value "PASSWORD_HASH = '$passwordHash'" -Encoding utf8

$pyinstaller = Join-Path $venvRoot "Scripts\pyinstaller.exe"
$buildRoot = Join-Path $repoRoot "work\pyinstaller-build"
$specRoot = Join-Path $repoRoot "work\pyinstaller-spec"
$dataArguments = @(
    "--add-data", "$repoRoot\index.html;app",
    "--add-data", "$repoRoot\assets;app\assets",
    "--add-data", "$repoRoot\data;app\data",
    "--add-data", "$repoRoot\vendor;app\vendor"
)

try {
    & $pyinstaller --noconsole --onefile --clean --collect-all webview `
        --name $artifactName `
        --distpath $OutputDirectory `
        --workpath $buildRoot `
        --specpath $specRoot `
        $dataArguments `
        (Join-Path $desktopRoot "main.py")
}
finally {
    if (Test-Path -LiteralPath $generatedConfig -PathType Leaf) {
        Remove-Item -LiteralPath $generatedConfig -Force
    }
}

$built = Join-Path $OutputDirectory "$artifactName.exe"
if (-not (Test-Path -LiteralPath $built -PathType Leaf)) {
    throw "PyInstaller did not produce $built"
}

Get-FileHash -LiteralPath $built -Algorithm SHA256
Write-Host "Built: $built"
