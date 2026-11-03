param([int]$Port = 18766)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$bridgeExe = Join-Path $projectRoot 'artifacts/win-x64/RoomBridge.exe'
if (!(Test-Path -LiteralPath $bridgeExe)) { throw 'Publish first: dotnet publish src/RoomBridge -c Release -r win-x64 -o artifacts/win-x64' }
$oldUrl = $env:BRIDGE_TEST_URL
$process = $null
Push-Location $projectRoot
try {
    $process = Start-Process -FilePath $bridgeExe -ArgumentList @('--urls', "http://127.0.0.1:$Port", '--Bridge:AllowInsecureLoopback', 'true', '--Bridge:HandshakeSeconds', '1', '--Bridge:IdleSeconds', '2', '--Bridge:AllowedOrigins', 'https://game.example.com;https://admin.example.com', '--Logging:LogLevel:Default', 'Warning') -WorkingDirectory (Split-Path -Parent $bridgeExe) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $projectRoot 'artifacts/native.stdout.log') -RedirectStandardError (Join-Path $projectRoot 'artifacts/native.stderr.log')
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        if ($process.HasExited) { throw 'Native server exited during startup; inspect artifacts/native.stderr.log' }
        try { $ready = (Invoke-WebRequest "http://127.0.0.1:$Port/health" -UseBasicParsing -TimeoutSec 1).StatusCode -eq 200 } catch { $ready = $false; $lastStartupError = $_.Exception.Message }
        if (!$ready) { Start-Sleep -Milliseconds 100 }
    } while (!$ready -and [DateTime]::UtcNow -lt $deadline)
    if (!$ready) { throw "Native server startup timed out: $lastStartupError" }
    $env:BRIDGE_TEST_URL = "ws://127.0.0.1:$Port"
    & dotnet run --project tests/RoomBridge.Tests -c Release
    if ($LASTEXITCODE -ne 0) { throw 'Native integration tests failed' }
    & node sdk/smoke.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Browser SDK interoperability test failed' }
    & node sdk/errors.test.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Browser SDK error contract tests failed' }
    Write-Host 'Native AOT and Web Crypto verification passed.'
} finally {
    if ($process -and !$process.HasExited) { Stop-Process -Id $process.Id; $process.WaitForExit() }
    $env:BRIDGE_TEST_URL = $oldUrl
    Pop-Location
}
