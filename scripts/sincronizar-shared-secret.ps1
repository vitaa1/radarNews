[CmdletBinding()]
param(
    [string]$WorkerUrl
)

$ErrorActionPreference = "Stop"

$envPath = Join-Path $PSScriptRoot "..\local\.env"
$examplePath = Join-Path $PSScriptRoot "..\local\.env.example"
$temporaryEnvPath = "$envPath.pending"
if (Test-Path -LiteralPath $envPath) {
    $envLines = @(Get-Content -LiteralPath $envPath)
}
else {
    $envLines = @(Get-Content -LiteralPath $examplePath)
}

$existingWorkerLine = $envLines | Where-Object { $_ -match '^WORKER_URL=' } | Select-Object -First 1
$existingSecretLine = $envLines | Where-Object { $_ -match '^SHARED_SECRET=' } | Select-Object -First 1
$existingWorkerUrl = if ($existingWorkerLine) { (($existingWorkerLine -split '=', 2)[1].Trim()).TrimEnd("/") } else { "" }
$oldSharedSecret = if ($existingSecretLine) { ($existingSecretLine -split '=', 2)[1].Trim() } else { "" }
if (-not $WorkerUrl -and $existingWorkerLine) {
    $WorkerUrl = ($existingWorkerLine -split '=', 2)[1].Trim()
}
if (-not $WorkerUrl -or $WorkerUrl -match 'SEUSUBDOMINIO|seu-subdominio') {
    $WorkerUrl = (Read-Host -Prompt "URL HTTPS publicada do Worker").Trim()
}
$WorkerUrl = $WorkerUrl.TrimEnd("/")
$parsedWorkerUrl = $null
if (-not [uri]::TryCreate($WorkerUrl, [UriKind]::Absolute, [ref]$parsedWorkerUrl) -or
    $parsedWorkerUrl.Scheme -ne "https" -or $parsedWorkerUrl.UserInfo -or
    $parsedWorkerUrl.Query -or $parsedWorkerUrl.Fragment -or
    $parsedWorkerUrl.AbsolutePath -ne "/") {
    throw "Informe uma WORKER_URL HTTPS sem caminho, credenciais, consulta ou fragmento."
}

$sharedSecret = [guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N")
$hasWorkerUrl = $false
$hasSharedSecret = $false
$newEnvLines = @($envLines | ForEach-Object {
    if ($_ -match '^WORKER_URL=') {
        $hasWorkerUrl = $true
        "WORKER_URL=$WorkerUrl"
    }
    elseif ($_ -match '^SHARED_SECRET=') {
        $hasSharedSecret = $true
        "SHARED_SECRET=$sharedSecret"
    }
    else {
        $_
    }
})
if (-not $hasWorkerUrl) { $newEnvLines += "WORKER_URL=$WorkerUrl" }
if (-not $hasSharedSecret) { $newEnvLines += "SHARED_SECRET=$sharedSecret" }

Write-Host "Preparando a nova configuracao local..." -ForegroundColor Cyan
$newEnvLines | Set-Content -LiteralPath $temporaryEnvPath -Encoding utf8

try {
    Write-Host "Enviando a nova chave ao segredo SHARED_SECRET do Worker..."
    $sharedSecret | & npx.cmd wrangler secret put SHARED_SECRET
    if ($LASTEXITCODE -ne 0) {
        throw "O Wrangler nao conseguiu atualizar SHARED_SECRET."
    }

    try {
        Move-Item -LiteralPath $temporaryEnvPath -Destination $envPath -Force
    }
    catch {
        if ($existingWorkerUrl -eq $WorkerUrl -and
            $oldSharedSecret.Length -ge 24 -and $oldSharedSecret -notmatch '^cole_') {
            Write-Host "Falha ao salvar localmente; restaurando a chave anterior no Worker..." -ForegroundColor Yellow
            $oldSharedSecret | & npx.cmd wrangler secret put SHARED_SECRET
        }
        throw
    }

    Write-Host "A mesma chave foi salva em local\.env (arquivo ignorado pelo Git)."
    Write-Host "Aguardando a atualizacao do Worker..."
    Start-Sleep -Seconds 3

    $headers = @{ Authorization = "Bearer $sharedSecret" }
    $status = Invoke-RestMethod -Method Get -Uri "$WorkerUrl/api/status" -Headers $headers
    if (-not $status.ok) {
        throw "O Worker respondeu sem confirmar o estado."
    }
    Write-Host "Autenticacao confirmada: SHARED_SECRET esta sincronizado." -ForegroundColor Green
    $status
}
catch {
    if (Test-Path -LiteralPath $temporaryEnvPath) {
        Remove-Item -LiteralPath $temporaryEnvPath -Force
    }
    throw
}
finally {
    $sharedSecret = $null
    $oldSharedSecret = $null
    $headers = $null
    if ($newEnvLines) { [Array]::Clear($newEnvLines, 0, $newEnvLines.Count) }
}
