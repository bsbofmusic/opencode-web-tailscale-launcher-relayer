param(
    [Parameter(Mandatory = $false)]
    [string]$TargetHost = $env:OPENCODE_WEB_HOST,

    [Parameter(Mandatory = $false)]
    [int]$TargetPort = $(if ($env:OPENCODE_WEB_PORT) { [int]$env:OPENCODE_WEB_PORT } else { 3000 })
)

$ErrorActionPreference = 'Stop'

$gatewayPort = 3101
$opencodeCmd = if ($env:OPENCODE_CLI) { $env:OPENCODE_CLI } else { Join-Path $env:APPDATA 'npm\opencode.cmd' }
$corsOrigin = if ($env:OPENCODE_WEB_CORS) { $env:OPENCODE_WEB_CORS } else { 'https://opencode.cosymart.top' }
$gatewayScript = Join-Path $PSScriptRoot 'session-gateway.js'

if ([string]::IsNullOrWhiteSpace($TargetHost)) {
    throw 'TargetHost is required. Pass -TargetHost or set OPENCODE_WEB_HOST for this session.'
}

if (-not (Test-Path $opencodeCmd)) {
    throw "global opencode CLI not found at $opencodeCmd"
}

if (-not (Test-Path $gatewayScript)) {
    throw "session gateway script not found at $gatewayScript"
}

$nodeCmd = (Get-Command node.exe -ErrorAction Stop).Source

$existing = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -match 'node|opencode|cmd' -and
    $_.CommandLine -like "*opencode*web*--hostname $TargetHost*--port $TargetPort*"
}

$gatewayExisting = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -match 'node' -and
    $_.CommandLine -like "*$gatewayScript*"
}

if ($existing) {
    Write-Output 'OpenCode tailscale service is already running.'
} else {
    $env:BROWSER = 'none'
    $env:NO_PROXY = "localhost,127.0.0.1,$TargetHost"
    $env:OPENCODE_CLIENT = 'cli'
    $env:OPENCODE_PID = ''
    $env:OPENCODE_SERVER_PASSWORD = ''
    $env:OPENCODE_SERVER_USERNAME = ''
    $env:OPENCODE_GATEWAY_HOST = $TargetHost
    $env:OPENCODE_GATEWAY_PORT = "$gatewayPort"
    Remove-Item Env:XDG_STATE_HOME -ErrorAction SilentlyContinue

    if (-not $gatewayExisting) {
        Start-Process -WindowStyle Hidden -FilePath $nodeCmd -ArgumentList @($gatewayScript)
        Start-Sleep -Milliseconds 400
    }

    & $opencodeCmd web --hostname $TargetHost --port $TargetPort --cors $corsOrigin
}

if (-not $gatewayExisting) {
    Start-Process -WindowStyle Hidden -FilePath $nodeCmd -ArgumentList @($gatewayScript)
}
