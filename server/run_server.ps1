# Startet den lokalen laya-serve-Container (Jev-kompatible API) auf 127.0.0.1:11500.
# Voraussetzung: Docker Desktop laeuft.

$ErrorActionPreference = "Stop"
$containerName = "laya"
$port = 11500

$existing = docker ps -a --filter "name=^${containerName}$" --format "{{.Names}}"
if ($existing -eq $containerName) {
    Write-Host "Container '$containerName' existiert bereits, starte ihn neu..."
    docker rm -f $containerName | Out-Null
}

docker run -d --name $containerName -p 127.0.0.1:${port}:${port} `
    -e LAYA_PORT=$port `
    -e LAYA_MODELS=english `
    ghcr.io/ouijan/laya-serve

Write-Host "Warte auf Healthcheck (http://127.0.0.1:$port/health)..."
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    try {
        $resp = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 3
        Write-Host "Server bereit: $resp"
        $ready = $true
        break
    } catch {
        Write-Host "... noch nicht bereit"
    }
}

if (-not $ready) {
    Write-Warning "Server hat innerhalb von 60s nicht geantwortet. Logs pruefen: docker logs $containerName"
} else {
    Write-Host "laya-serve laeuft auf http://127.0.0.1:$port"
}
