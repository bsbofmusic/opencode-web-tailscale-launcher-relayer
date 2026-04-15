param(
    [string]$HostName = '100.113.143.4',
    [string]$UserName,
    [string]$KeyPath,
    [string]$RemotePath = '/var/www/opencode-tailnet/index.html',
    [switch]$Backup = $true
)

$ErrorActionPreference = 'Stop'

$source = Join-Path $PSScriptRoot 'opencode-tailnet-launcher.html'

if (-not (Test-Path $source)) {
    throw "launcher file not found: $source"
}

if (-not $UserName) {
    throw 'UserName is required, for example -UserName root or -UserName ubuntu'
}

$sshArgs = @('-o', 'StrictHostKeyChecking=accept-new')
if ($KeyPath) {
    if (-not (Test-Path $KeyPath)) {
        throw "SSH key not found: $KeyPath"
    }
    $sshArgs += @('-i', $KeyPath)
}

$target = "$UserName@$HostName"
$tempPath = "$RemotePath.tmp"

Write-Host "Uploading launcher to ${target}:${tempPath}"
& scp @sshArgs $source "${target}:$tempPath"
if (-not $?) {
    throw 'scp upload failed'
}

$remoteCommand = if ($Backup) {
    "if [ -f '$RemotePath' ]; then cp '$RemotePath' '$RemotePath.bak'; fi; mv '$tempPath' '$RemotePath'"
} else {
    "mv '$tempPath' '$RemotePath'"
}

Write-Host "Replacing remote launcher at $RemotePath"
& ssh @sshArgs $target $remoteCommand
if (-not $?) {
    throw 'remote replace failed'
}

Write-Host 'Launcher deployed successfully.'
