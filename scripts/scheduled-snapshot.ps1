# Unattended snapshot for one trading session, driven by the Windows scheduler.
#
# Runs with no one watching, so it brings its own preconditions: node is not on
# the PATH the scheduler hands us, TradingView may be closed, and a freshly
# launched chart needs time before its API answers. Output is logged rather than
# printed, since there is no terminal.
#
#   .\scheduled-snapshot.ps1 -Session londres
#
# Sessions are captured at their opens (UTC): asie 00:00, londres 07:00,
# newyork 12:00. Each has catch-up triggers, so this must stay idempotent --
# see the guard below.

param(
    [string]$Session = ''
)

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
$tag = if ($Session) { "-$Session" } else { '' }
$log = Join-Path $logDir ("run-" + (Get-Date -Format 'yyyy-MM-ddTHH-mm-ss') + "$tag.log")

function Log($msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg
    Add-Content -Path $log -Value $line -Encoding utf8
}

Log "Capture programmee - session '$Session'"

# Markets are shut at the weekend; a capture then only records Friday's close
# again and would become the baseline the next --compare diffs against.
$dow = [DateTime]::UtcNow.DayOfWeek
if ($dow -eq 'Saturday' -or $dow -eq 'Sunday') {
    Log "Week-end ($dow) - aucune capture"
    exit 0
}

# Each session carries catch-up triggers so a missed open is retried within
# minutes rather than the hours Windows may take on its own. They must still
# produce one capture per session: without this guard each extra run would
# become the baseline the next --compare diffs against, hiding the move the
# capture exists to record.
$today = [DateTime]::UtcNow.ToString('yyyy-MM-dd')
$pattern = if ($Session) { "$today*__$Session.json" } else { "$today*.json" }
$already = @(Get-ChildItem -Path $logDir -Filter $pattern -ErrorAction SilentlyContinue)
if ($already.Count -gt 0) {
    Log "Session '$Session' deja capturee aujourd'hui ($($already[0].Name)) - rien a faire"
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
$snapshotArgs = @((Join-Path $root 'scripts\snapshot.js'), '--compare')
if ($Session) { $snapshotArgs += @('--session', $Session) }

$ok = $false
for ($i = 1; $i -le 4; $i++) {
    Start-Sleep -Seconds (10 * $i)
    Log "Tentative $i de capture"
    try {
        $out = & node @snapshotArgs 2>&1
        $out | ForEach-Object { Log $_ }
        if ($LASTEXITCODE -eq 0) { $ok = $true; break }
        Log "snapshot.js a rendu le code $LASTEXITCODE"
    } catch {
        Log "Erreur : $($_.Exception.Message)"
    }
}

if ($ok) { Log "Capture reussie (session '$Session')" } else { Log "ECHEC apres 4 tentatives" }
