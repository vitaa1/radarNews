[CmdletBinding()]
param(
    [switch]$FromClipboard,
    [switch]$VisibleInput
)

$ErrorActionPreference = "Stop"

Write-Host "Teste seguro da conexao com o Telegram" -ForegroundColor Cyan
if ($FromClipboard -and $VisibleInput) {
    throw "Use apenas uma opcao: -FromClipboard ou -VisibleInput."
}

if ($FromClipboard) {
    Write-Host "Lendo o token da area de transferencia sem exibi-lo."
    $clipboardText = Get-Clipboard -Raw
    $tokenMatch = [regex]::Match($clipboardText, '(?<!\d)\d+:[A-Za-z0-9_-]{20,}')
    try {
        Set-Clipboard -Value " " -ErrorAction Stop
    }
    catch {
        Write-Host "Aviso: nao foi possivel limpar a area de transferencia automaticamente." -ForegroundColor Yellow
    }
    if (-not $tokenMatch.Success) {
        throw "Nenhum token completo foi encontrado na area de transferencia. Copie o token novo no BotFather e tente novamente."
    }
    $telegramToken = $tokenMatch.Value
}
elseif ($VisibleInput) {
    Write-Host "ATENCAO: o token ficara visivel somente durante a digitacao." -ForegroundColor Yellow
    Write-Host "Ele nao sera salvo no historico e a tela sera limpa depois de Enter."
    $telegramToken = (Read-Host -Prompt "Digite o token completo olhando o celular").Trim()
    Clear-Host
    Write-Host "Token recebido. Iniciando verificacao segura..." -ForegroundColor Cyan
}
else {
    Write-Host "O token sera solicitado na proxima linha e nao sera exibido."
    $secureToken = Read-Host -Prompt "Cole o NOVO token completo copiado do BotFather" -AsSecureString
    $telegramToken = [System.Net.NetworkCredential]::new("", $secureToken).Password.Trim()
}

try {
    if ($telegramToken -notmatch '^\d+:[A-Za-z0-9_-]+$') {
        $parts = @($telegramToken -split ':')
        $oneColon = $parts.Count -eq 2
        $numericPrefix = $oneColon -and $parts[0] -match '^\d+$'
        $validSecret = $oneColon -and $parts[1] -match '^[A-Za-z0-9_-]+$'

        Write-Host "Diagnostico seguro (o token nao sera mostrado):" -ForegroundColor Yellow
        Write-Host ("- Contem exatamente um sinal de dois-pontos: {0}" -f $oneColon)
        Write-Host ("- Antes dos dois-pontos ha somente numeros: {0}" -f $numericPrefix)
        Write-Host ("- Depois dos dois-pontos ha um segredo: {0}" -f $validSecret)
        throw "Copie somente o token pelo botao de copiar do BotFather, sem 'bot', URL, aspas ou espacos."
    }

    $uri = "https://api.telegram.org/bot$telegramToken/getMe"
    $response = Invoke-RestMethod -Method Get -Uri $uri

    if (-not $response.ok) {
        throw "O Telegram respondeu, mas nao confirmou o token."
    }

    Write-Host "Conexao confirmada." -ForegroundColor Green
    Write-Host ("Bot: @{0} (id {1})" -f $response.result.username, $response.result.id)

    $updatesUri = "https://api.telegram.org/bot$telegramToken/getUpdates"
    $updates = Invoke-RestMethod -Method Get -Uri $updatesUri
    $chatIds = @(
        $updates.result |
            Where-Object { $_.message -and $_.message.chat } |
            ForEach-Object { $_.message.chat.id } |
            Select-Object -Unique
    )

    if ($chatIds.Count -gt 0) {
        Write-Host "TELEGRAM_CHAT_ID encontrado:" -ForegroundColor Green
        $chatIds | ForEach-Object { Write-Host $_ }
    }
    else {
        Write-Host "Token valido, mas nenhum chat foi encontrado. Envie /start ao bot e execute este teste novamente." -ForegroundColor Yellow
    }
}
catch {
    $statusCode = $null
    if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
        $statusCode = [int]$_.Exception.Response.StatusCode
    }

    if ($statusCode -eq 404) {
        Write-Host "Falha 404: o Telegram nao reconheceu o token. Gere outro com /token no @BotFather e tente novamente." -ForegroundColor Red
    }
    elseif ($statusCode -eq 401) {
        Write-Host "Falha 401: token incorreto ou revogado. Confira cada caractere ou gere outro com /token no @BotFather." -ForegroundColor Red
    }
    elseif ($statusCode) {
        Write-Host ("Falha HTTP {0}: {1}" -f $statusCode, $_.Exception.Message) -ForegroundColor Red
    }
    else {
        Write-Host ("Falha: {0}" -f $_.Exception.Message) -ForegroundColor Red
    }
    exit 1
}
finally {
    $telegramToken = $null
    $secureToken = $null
    $clipboardText = $null
    $tokenMatch = $null
    $uri = $null
    $updatesUri = $null
    $updates = $null
    $chatIds = $null
}
