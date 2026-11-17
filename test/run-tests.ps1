# Runs the Scritch player test harness in headless Chrome/Edge against a local server.
# Usage: powershell -NoProfile -File test\run-tests.ps1
param([int]$Port = 8321)

$ErrorActionPreference = 'Stop'
$testDir = $PSScriptRoot
$repoRoot = Split-Path -Parent $testDir
$resultsFile = Join-Path $testDir 'results.txt'

# 1. generate test media
$psExe = Join-Path $PSHOME 'powershell.exe'
& $psExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $testDir 'gen-media.ps1')

# 2. find a browser
$chrome = "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
$edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
$browser = $null
if (Test-Path $chrome) { $browser = $chrome }
elseif (Test-Path $edge) { $browser = $edge }
else { throw 'no chrome/edge found' }
Write-Host "using browser: $browser"

# 3. start the local server
$server = Start-Process $psExe -PassThru `
    -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $testDir 'serve.ps1'),'-Port',$Port
$browserProc = $null
try {
    $ready = $false
    for ($i = 0; $i -lt 50; $i++) {
        try {
            $tcp = New-Object System.Net.Sockets.TcpClient
            $tcp.Connect('127.0.0.1', $Port)
            $tcp.Close()
            $ready = $true
            break
        } catch { Start-Sleep -Milliseconds 200 }
    }
    if (-not $ready) { throw "server did not start on port $Port" }

    # 4. run the harness in a headless browser
    if (Test-Path $resultsFile) { Remove-Item $resultsFile }
    $profileDir = Join-Path $testDir ('.browser-profile-' + $Port)
    $browserProc = Start-Process $browser -PassThru -ArgumentList @(
        '--headless=new',
        '--disable-gpu',
        '--mute-audio',
        '--no-first-run',
        '--autoplay-policy=no-user-gesture-required',
        "--user-data-dir=$profileDir",
        "http://127.0.0.1:$Port/test/run.html"
    )

    # 5. wait for the harness to POST its results
    $deadline = (Get-Date).AddSeconds(120)
    while ((Get-Date) -lt $deadline) {
        if (Test-Path $resultsFile) { break }
        Start-Sleep -Milliseconds 500
    }
    if (-not (Test-Path $resultsFile)) { throw 'timed out waiting for test results' }
    Start-Sleep -Milliseconds 500 # let the file write flush
} finally {
    if ($browserProc -and -not $browserProc.HasExited) { Stop-Process -Id $browserProc.Id -Force }
    if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }
    Remove-Item -Recurse -Force (Join-Path $testDir ('.browser-profile-' + $Port)) -ErrorAction SilentlyContinue
}

# 6. report
$results = Get-Content $resultsFile -Raw
Write-Host ''
Write-Host $results
if ($results -match 'DONE (\d+)/(\d+) passed' -and $Matches[1] -eq $Matches[2]) {
    Write-Host 'ALL TESTS PASSED'
    exit 0
} else {
    Write-Host 'SOME TESTS FAILED'
    exit 1
}
