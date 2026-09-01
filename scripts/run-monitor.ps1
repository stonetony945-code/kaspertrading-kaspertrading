# Keeps the monitor alive, for the Windows scheduled task.
#
# The monitor is a long-running process, not a one-shot capture, so this is a
# supervisor rather than a launcher: it restarts the monitor whenever it exits.
# It will exit -- TradingView gets closed, the machine sleeps and CDP drops, the
# chart reloads. Without a restart loop the monitoring simply stops, silently,
# and nobody notices until a signal has already been missed.
#
#   .\run-monitor.ps1 -Symbol GBPUSD -Interval 5
#
# Stop it with: Stop-ScheduledTask -TaskName 'KasperTrading-Monitor'

param(
    [string]$Symbol = 'GBPUSD',
    [int]$Interval = 5
)

$ErrorActionPreference = 'Continue'

# node writes UTF-8; without this PowerShell decodes it in the console codepage
# and accented output lands in the log as mojibake.
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }

$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root 'snapshots'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Log($msg) {
    # One log per day rather than per start, so a night of restarts stays
    # readable as a single timeline.
    $file = Join-Path $logDir ("monitor-" + (Get-Date -Format 'yyyy-MM-dd') + ".log")
    Add-Content -Path $file -Value ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg) -Encoding utf8
}

$nodeDir = 'C:\Program Files\nodejs'
if (Test-Path (Join-Path $nodeDir 'node.exe')) { $env:Path = "$env:Path;$nodeDir" }

Log "Superviseur demarre - $Symbol, releve toutes les $Interval min"

$failures = 0
while ($true) {
    # TradingView may have been closed since the last iteration; launch-tv.ps1
    # is a no-op when CDP is already listening.
    try {
        & (Join-Path $PSScriptRoot 'launch-tv.ps1') *>&1 | ForEach-Object { Log "launch-tv: $_" }
    } catch {
        Log "launch-tv a echoue : $($_.Exception.Message)"
    }

    Log "Lancement du moniteur"
    $started = Get-Date
    try {
        & node (Join-Path $root 'scripts\monitor.js') '--symbols' $Symbol '--interval' $Interval 2>&1 |
            ForEach-Object { Log $_ }
        Log "Le moniteur s'est termine (code $LASTEXITCODE)"
    } catch {
        Log "Le moniteur a plante : $($_.Exception.Message)"
    }

    # A run that lasted is not a failure: it worked and then something external
    # ended it -- a sleep, a chart reload. Only quick successive deaths mean a
    # fault worth backing off from, so the counter resets on a healthy run.
    # Without this, ten ordinary restarts spread over days would stop the
    # supervisor for good.
    $ranFor = (Get-Date) - $started
    if ($ranFor.TotalMinutes -ge 5) {
        if ($failures -gt 0) { Log ("Run sain de {0:N0} min - compteur d'echecs remis a zero" -f $ranFor.TotalMinutes) }
        $failures = 0
    } else {
        $failures++
    }

    # Back off after repeated quick failures so a permanent fault does not spin
    # the CPU restarting a process that cannot run.
    $wait = if ($failures -eq 0) { 15 } else { [Math]::Min(60 * $failures, 600) }
    Log "Redemarrage dans $wait s (echecs consecutifs : $failures)"
    Start-Sleep -Seconds $wait
    if ($failures -ge 10) { Log "10 echecs rapides consecutifs - arret du superviseur"; break }
}
