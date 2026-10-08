# Starts the local laya-serve container (Jev-compatible API) on 127.0.0.1:11500.
# Prerequisite: Docker Desktop is running.

$ErrorActionPreference = "Stop"
$containerName = "laya"
$port = 11500

$existing = docker ps -a --filter "name=^${containerName}$" --format "{{.Names}}"
if ($existing -eq $containerName) {
    Write-Host "Container '$containerName' already exists, restarting it..."
    docker rm -f $containerName | Out-Null
}

docker run -d --name $containerName -p 127.0.0.1:${port}:${port} `
    -e LAYA_PORT=$port `
    -e LAYA_MODELS=english `
    ghcr.io/ouijan/laya-serve

Write-Host "Waiting for health check (http://127.0.0.1:$port/health)..."
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    try {
        $resp = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 3
        Write-Host "Server ready: $resp"
        $ready = $true
        break
    } catch {
        Write-Host "... not ready yet"
    }
}

if (-not $ready) {
    Write-Warning "Server did not respond within 60s. Check logs: docker logs $containerName"
} else {
    Write-Host "laya-serve is running on http://127.0.0.1:$port"
}
