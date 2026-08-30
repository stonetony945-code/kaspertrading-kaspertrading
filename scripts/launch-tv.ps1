# Lance TradingView Desktop (version Microsoft Store / MSIX) avec le Chrome DevTools Protocol
# active sur le port 9222, requis par le serveur MCP tradingview.
#
# Le chemin d'installation contient le numero de version et change a chaque mise a jour
# du Store, il est donc resolu dynamiquement via le package Appx.

$ErrorActionPreference = 'Stop'
$port = 9222

# Deja en ecoute ? Rien a faire.
if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
    Write-Host "CDP deja actif sur le port $port." -ForegroundColor Green
    exit 0
}

# TradingView tourne sans le flag : il faut le fermer, sinon le nouveau lancement
# rejoint l'instance existante et ignore --remote-debugging-port.
$running = Get-Process -Name 'TradingView' -ErrorAction SilentlyContinue
if ($running) {
    Write-Host "TradingView tourne sans CDP - fermeture pour relancer avec le flag..." -ForegroundColor Yellow
    $running | Stop-Process -Force
    Start-Sleep -Seconds 3
}

$pkg = Get-AppxPackage -Name 'TradingView.Desktop' -ErrorAction SilentlyContinue
if (-not $pkg) {
    Write-Error "Package TradingView.Desktop introuvable. Installez TradingView Desktop depuis le Microsoft Store."
}

$exe = Join-Path $pkg.InstallLocation 'TradingView.exe'
if (-not (Test-Path $exe)) {
    Write-Error "Executable introuvable : $exe"
}

Write-Host "Lancement : $exe" -ForegroundColor Cyan
Start-Process -FilePath $exe -ArgumentList "--remote-debugging-port=$port"

# Attente de l'endpoint CDP (max 30 s)
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    try {
        $v = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/version" -TimeoutSec 2 -ErrorAction Stop
        Write-Host "CDP pret : $($v.Browser) / TVDesktop $($pkg.Version)" -ForegroundColor Green
        exit 0
    } catch { }
}

Write-Error "Le port $port n'a pas repondu apres 30 s."
