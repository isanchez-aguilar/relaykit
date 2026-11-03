param([switch]$Yes)
$ErrorActionPreference = 'Stop'
# If policy blocks this file before it starts, use the same command from README.
$policy = try { Get-ExecutionPolicy } catch { 'Unknown' }
if ($policy -in @('Restricted', 'AllSigned', 'RemoteSigned')) {
    Write-Host 'If execution policy blocks setup: powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1'
}
$candidates = @()
$onPath = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue
if ($onPath) { $candidates += $onPath.Source }
$candidates += @(
    "$env:SystemDrive\nvm4w\nodejs\node.exe",
    "$env:ProgramFiles\nodejs\node.exe"
)
if ($env:NVM_SYMLINK) { $candidates += Join-Path $env:NVM_SYMLINK 'node.exe' }
if ($env:VOLTA_HOME) { $candidates += Join-Path $env:VOLTA_HOME 'bin\node.exe' }
$candidates += "$env:LOCALAPPDATA\Volta\bin\node.exe"
$patterns = @(
    "$env:LOCALAPPDATA\fnm_multishells\*\node.exe",
    "$env:LOCALAPPDATA\fnm\node-versions\*\installation\node.exe",
    "$env:APPDATA\fnm\node-versions\*\installation\node.exe"
)
if ($env:FNM_DIR) { $patterns += "$env:FNM_DIR\node-versions\*\installation\node.exe" }
if ($env:NVM_HOME) { $patterns += "$env:NVM_HOME\v*\node.exe" }
foreach ($pattern in $patterns) {
    $candidates += @(Get-ChildItem -Path $pattern -File -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName)
}
$node = $null
foreach ($candidate in $candidates) {
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
    try {
        & $candidate -e 'process.exit(parseInt(process.versions.node)>=18?0:1)' 2>$null
        if ($LASTEXITCODE -eq 0) { $node = (Resolve-Path -LiteralPath $candidate).Path; break }
    } catch { continue }
}
if (-not $node) {
    Write-Host 'Node 18+ not found. Install Node from https://nodejs.org/ and run setup again.'
    exit 1
}
$setupArgs = @((Join-Path $PSScriptRoot '..\lib\setup.mjs'))
if ($Yes) { $setupArgs += '--yes' }
& $node @setupArgs
exit $LASTEXITCODE
