# Run the e2e suite unattended, without the monitor fighting it for the chart.
#
# The e2e tests drive the live chart: they switch symbol and timeframe, open
# panels, start replay. The monitor does the same thing every five minutes. Run
# both at once and each corrupts the other's reading -- which is how a 90-minute
# run on 2026-09-04 produced no output at all and had to be killed.
#
# So: pause the monitor, run the suite under a hard deadline, put the monitor
# back whatever happens. The market must be open, or half the suite is asserting
# against a frozen feed.
#
#   .\run-e2e.ps1                 # deadline 20 min
#   .\run-e2e.ps1 -TimeoutMin 30
#
# Output lands in snapshots/e2e-<date>.log.

param(
    [int]$TimeoutMin = 20
)

$ErrorActionPreference = 'Continue'
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }

$root   = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root 'snapshots'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log    = Join-Path $logDir ("e2e-" + (Get-Date -Format 'yyyy-MM-dd') + ".log")

function Log($msg) {
    Add-Content -Path $log -Value ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg) -Encoding utf8
}

$node = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path $node)) { Log "node introuvable a $node - abandon"; exit 1 }

$TASK = 'KasperTrading-Monitor'
$monitorWasRunning = $false

try {
    $t = Get-ScheduledTask -TaskName $TASK -ErrorAction SilentlyContinue
    if ($t -and $t.State -eq 'Running') {
        $monitorWasRunning = $true
        Log "Mise en pause du moniteur"
        Stop-ScheduledTask -TaskName $TASK
        Start-Sleep -Seconds 3
        Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
            Where-Object { $_.CommandLine -like '*monitor.js*' } |
            ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        Start-Sleep -Seconds 2
    } else {
        Log "Moniteur deja arrete"
    }

    # The suite needs a chart to talk to; this is a no-op when CDP is up.
    try {
        & (Join-Path $PSScriptRoot 'launch-tv.ps1') *>&1 | ForEach-Object { Log "launch-tv: $_" }
    } catch {
        Log "launch-tv a echoue : $($_.Exception.Message)"
    }

    Log "Lancement de la suite e2e (deadline $TimeoutMin min)"
    $out = Join-Path $env:TEMP "e2e-out-$PID.txt"
    $err = Join-Path $env:TEMP "e2e-err-$PID.txt"
    $p = Start-Process -FilePath $node `
        -ArgumentList '--test', 'tests/e2e.test.js' `
        -WorkingDirectory $root -PassThru -NoNewWindow `
        -RedirectStandardOutput $out -RedirectStandardError $err

    # A hard deadline is the point: the last run hung and nobody noticed for an
    # hour and a half. A suite that cannot finish in the window has failed.
    if (-not $p.WaitForExit($TimeoutMin * 60 * 1000)) {
        Log "DEADLINE DEPASSEE apres $TimeoutMin min - suite tuee"
        try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch { }
        Start-Sleep -Seconds 2
    } else {
        Log "Suite terminee (code $($p.ExitCode))"
    }

    foreach ($f in @($out, $err)) {
        if (Test-Path $f) {
            Get-Content $f | ForEach-Object { Add-Content -Path $log -Value $_ -Encoding utf8 }
            Remove-Item $f -Force -ErrorAction SilentlyContinue
        }
    }
}
finally {
    # The monitor goes back up even if the suite threw, timed out, or the script
    # was interrupted. Leaving the market unwatched is the worse failure.
    if ($monitorWasRunning) {
        Log "Redemarrage du moniteur"
        try { Start-ScheduledTask -TaskName $TASK } catch { Log "echec du redemarrage : $($_.Exception.Message)" }
    }
    Log "Termine"
}
