# Unattended snapshot, for the Windows scheduled task.
#
# Runs with no one watching, so it has to bring its own preconditions: node is
# not on the PATH the scheduler hands us, TradingView may be closed, and a
# freshly launched chart needs time before its API answers. Output is logged
# rather than printed, since nobody is at the terminal.

$ErrorActionPreference = 'Stop'

# node writes UTF-8; without this PowerShell decodes it in the console codepage
# and accented output lands in the log as mojibake ("comblés" -> "combl├®s").
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }

$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root 'snapshots'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir ("run-" + (Get-Date -Format 'yyyy-MM-ddTHH-mm-ss') + ".log")

function Log($msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg
    Add-Content -Path $log -Value $line -Encoding utf8
}

Log "Demarrage de la capture programmee"

# The task carries catch-up triggers so a missed 07:00 is retried within
# minutes instead of the hours Windows may take on its own. Three triggers must
# still produce one capture, so stop here when today's post-open capture is
# already on disk -- otherwise each extra run would become the baseline the next
# --compare diffs against, hiding the overnight move.
$today = [DateTime]::UtcNow.ToString('yyyy-MM-dd')
$alreadyDone = @(
    Get-ChildItem -Path $logDir -Filter "$today*.json" -ErrorAction SilentlyContinue |
        Where-Object { ($_.BaseName.Substring(11, 2) -as [int]) -ge 7 }
)
if ($alreadyDone.Count -gt 0) {
    Log "Capture deja presente pour aujourd'hui ($($alreadyDone[0].Name)) - rien a faire"
    exit 0
}

# The scheduler's environment does not inherit the interactive PATH.
$nodeDir = 'C:\Program Files\nodejs'
if (Test-Path (Join-Path $nodeDir 'node.exe')) { $env:Path = "$env:Path;$nodeDir" }

# Bring TradingView up if it is not already serving CDP. launch-tv.ps1 is a
# no-op when the port is already listening, so this is safe either way.
try {
    & (Join-Path $PSScriptRoot 'launch-tv.ps1') *>&1 | ForEach-Object { Log "launch-tv: $_" }
} catch {
    Log "launch-tv a echoue : $($_.Exception.Message)"
}

# A chart that has just loaded rejects API calls for a while, so retry rather
# than recording a spurious failure.
$ok = $false
for ($i = 1; $i -le 4; $i++) {
    Start-Sleep -Seconds (10 * $i)
    Log "Tentative $i de capture"
    try {
        $out = & node (Join-Path $root 'scripts\snapshot.js') '--compare' 2>&1
        $out | ForEach-Object { Log $_ }
        if ($LASTEXITCODE -eq 0) { $ok = $true; break }
        Log "snapshot.js a rendu le code $LASTEXITCODE"
    } catch {
        Log "Erreur : $($_.Exception.Message)"
    }
}

if ($ok) { Log "Capture reussie" } else { Log "ECHEC apres 4 tentatives" }
Log "Journal : $log"
