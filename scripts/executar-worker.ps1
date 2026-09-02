$ErrorActionPreference = "Stop"

$envPath = Join-Path $PSScriptRoot "..\local\.env"
if (-not (Test-Path $envPath)) {
    throw "local\.env nao encontrado. Execute scripts\sincronizar-shared-secret.ps1 primeiro."
}

$settings = @{}
foreach ($rawLine in Get-Content $envPath) {
    $line = $rawLine.Trim().TrimStart([char]0xFEFF)
    if (-not $line -or $line.StartsWith("#") -or -not $line.Contains("=")) {
        continue
    }
    $key, $value = $line.Split("=", 2)
    $settings[$key.Trim()] = $value.Trim()
}

$workerUrl = $settings["WORKER_URL"]
$sharedSecret = $settings["SHARED_SECRET"]
if (-not $workerUrl -or -not $sharedSecret) {
    throw "WORKER_URL ou SHARED_SECRET ausente em local\.env."
}
$workerUrl = $workerUrl.TrimEnd("/")
$parsedWorkerUrl = $null
if (-not [uri]::TryCreate($workerUrl, [UriKind]::Absolute, [ref]$parsedWorkerUrl) -or
    $parsedWorkerUrl.Scheme -ne "https" -or $parsedWorkerUrl.UserInfo -or
    $parsedWorkerUrl.Query -or $parsedWorkerUrl.Fragment -or
    $parsedWorkerUrl.AbsolutePath -ne "/") {
    throw "WORKER_URL deve ser uma URL HTTPS sem caminho, credenciais, consulta ou fragmento."
}

$headers = @{ Authorization = "Bearer $sharedSecret" }
try {
    Write-Host "Executando agora o ciclo do Worker..." -ForegroundColor Cyan
    $result = Invoke-RestMethod -Method Post -Uri "$workerUrl/api/run" -Headers $headers
    $result | ConvertTo-Json -Depth 8
}
finally {
    $sharedSecret = $null
    $headers = $null
    $settings.Clear()
}
