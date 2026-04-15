param(
    [string]$OutputDir = (Join-Path $PSScriptRoot 'dist')
)

$ErrorActionPreference = 'Stop'

$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$source = Join-Path $PSScriptRoot 'oc-launcher.cs'
$icon = Join-Path $PSScriptRoot 'OpenCodeTailnetLauncher.ico'
$target = Join-Path $OutputDir 'OpenCodeTailnetLauncher.exe'
$release = 'v0.0.12'
$zip = Join-Path $OutputDir ("OpenCodeTailnetLauncher-" + $release + "-single.zip")

if (-not (Test-Path $csc)) {
    throw "csc not found at $csc"
}

if (-not (Test-Path $source)) {
    throw "source not found at $source"
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $target } | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Milliseconds 400

Get-ChildItem $OutputDir -Force -ErrorAction SilentlyContinue | Where-Object { -not $_.PSIsContainer } | Remove-Item -Force -ErrorAction SilentlyContinue

& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'generate-oc-launcher-icon.ps1') -OutputPath $icon
if (-not $?) {
    throw 'icon generation failed'
}

& $csc /nologo /target:winexe /out:$target /win32icon:$icon /r:System.dll /r:System.Core.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Management.dll $source

if (-not $?) {
    throw 'csc build failed'
}

Remove-Item $zip -Force -ErrorAction SilentlyContinue
Compress-Archive -Path $target -DestinationPath $zip

Write-Host "Built $target"
