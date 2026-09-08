# Testes sem servicos reais: os comandos de rede sao substituidos por funcoes.
$ErrorActionPreference = "Stop"
$global:temporaryTestState = @{}
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$testRoot = Join-Path $projectRoot (".wrangler\temporary-tests-" + [guid]::NewGuid().ToString("N"))
$expectedRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot ".wrangler")) + [IO.Path]::DirectorySeparatorChar
if (-not ([IO.Path]::GetFullPath($testRoot)).StartsWith($expectedRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Diretorio de teste fora da area permitida."
}

function Assert-True($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Set-Content {
    [CmdletBinding()]
    param([string]$LiteralPath, [string]$Encoding, [Parameter(ValueFromPipeline = $true)]$Value)
    begin { $lines = New-Object 'System.Collections.Generic.List[string]' }
    process { $lines.Add([string]$Value) }
    end {
        [IO.File]::WriteAllLines($LiteralPath, $lines, [Text.Encoding]::UTF8)
        $global:temporaryTestState.pendingPaths.Add($LiteralPath)
        if ($global:temporaryTestState.scenario -eq "write-failure") { throw "Falha sintetica de escrita parcial" }
    }
}

function npx.cmd {
    [CmdletBinding(PositionalBinding = $false)]
    param([Parameter(ValueFromPipeline = $true)][string]$Value,
          [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    process {
        Assert-True (($Arguments -join " ") -eq "wrangler secret put SHARED_SECRET") "Comando externo inesperado"
        Assert-True ($Value.Length -ge 24) "Segredo ficticio ausente"
        $global:temporaryTestState.secretCalls += 1
        $global:LASTEXITCODE = if ($global:temporaryTestState.scenario -eq "remote-failure") { 1 } else { 0 }
    }
}

function Move-Item {
    param([string]$LiteralPath, [string]$Destination, [switch]$Force)
    if ($global:temporaryTestState.scenario -eq "move-failure") { throw "Falha sintetica de substituicao local" }
    Microsoft.PowerShell.Management\Move-Item -LiteralPath $LiteralPath -Destination $Destination -Force:$Force
}

function Invoke-RestMethod {
    param([string]$Method, [string]$Uri, $Headers)
    Assert-True ($Uri -eq "https://radar.example/api/status") "Destino externo inesperado"
    $global:temporaryTestState.statusCalls += 1
    if ($global:temporaryTestState.scenario -eq "status-failure") { throw "Falha sintetica de verificacao" }
    return @{ ok = $true }
}

function Start-Sleep { param([int]$Seconds) }

try {
    New-Item -ItemType Directory -Path (Join-Path $testRoot "scripts"), (Join-Path $testRoot "local") -Force | Out-Null
    $scriptPath = Join-Path $testRoot "scripts\sincronizar-shared-secret.ps1"
    Copy-Item -LiteralPath (Join-Path $projectRoot "scripts\sincronizar-shared-secret.ps1") -Destination $scriptPath
    $global:temporaryTestState.pendingPaths = New-Object 'System.Collections.Generic.List[string]'
    foreach ($scenario in @("success", "write-failure", "remote-failure", "move-failure", "status-failure")) {
        $global:temporaryTestState.scenario = $scenario
        $envPath = Join-Path $testRoot "local\.env"
        $original = "WORKER_URL=https://radar.example`nSHARED_SECRET=segredo-ficticio-apenas-para-testes-123456`n"
        [IO.File]::WriteAllText($envPath, $original, [Text.Encoding]::UTF8)
        $global:temporaryTestState.secretCalls = 0
        $global:temporaryTestState.statusCalls = 0
        $failed = $false
        try { & $scriptPath | Out-Null } catch {
            $failed = $true
            if ($global:temporaryTestState.scenario -eq "success") { throw }
        }
        Assert-True ($failed -eq ($global:temporaryTestState.scenario -ne "success")) "Resultado inesperado em $scenario"
        $leftovers = @(Get-ChildItem -LiteralPath (Join-Path $testRoot "local") -Force | Where-Object { $_.Name -like ".env.pending*" })
        Assert-True ($leftovers.Count -eq 0) "Temporario abandonado em $scenario"
        if ($global:temporaryTestState.scenario -in @("write-failure", "remote-failure", "move-failure")) {
            Assert-True ([IO.File]::ReadAllText($envPath) -eq $original) "Configuracao anterior alterada em $scenario"
        }
        $expectedCalls = switch ($global:temporaryTestState.scenario) { "write-failure" { 0 }; "move-failure" { 2 }; default { 1 } }
        Assert-True ($global:temporaryTestState.secretCalls -eq $expectedCalls) "Quantidade inesperada de chamadas em $scenario"
        Write-Host "Passou: $scenario"
    }
    Assert-True (@($global:temporaryTestState.pendingPaths | Select-Object -Unique).Count -eq 5) "Temporarios devem ter nomes unicos"
    foreach ($relative in @("local/.env.pending", "local/.env.pending.exemplo")) {
        & git -C $projectRoot check-ignore --quiet -- $relative
        Assert-True ($LASTEXITCODE -eq 0) "Temporario nao ignorado pelo Git"
    }
    & git -C $projectRoot check-ignore --quiet -- local/.env.example
    Assert-True ($LASTEXITCODE -eq 1) "Exemplo de configuracao deve continuar versionavel"
    $global:LASTEXITCODE = 0
}
finally {
    if (Test-Path -LiteralPath $testRoot) {
        $resolvedTestRoot = (Resolve-Path -LiteralPath $testRoot).Path
        if (-not $resolvedTestRoot.StartsWith($expectedRoot, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Limpeza recusada fora da area de testes."
        }
        Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
    }
}
