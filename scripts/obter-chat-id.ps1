[CmdletBinding()]
param(
    [switch]$FromClipboard
)

$ErrorActionPreference = "Stop"

Write-Host "Antes de continuar, abra o bot no Telegram e envie /start." -ForegroundColor Cyan
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
else {
    $secureToken = Read-Host -Prompt "Cole o token completo do BotFather" -AsSecureString
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

    $uri = "https://api.telegram.org/bot$telegramToken/getUpdates"
    $response = Invoke-RestMethod -Method Get -Uri $uri
    $chatIds = @(
        $response.result |
            Where-Object { $_.message -and $_.message.chat } |
            ForEach-Object { $_.message.chat.id } |
            Select-Object -Unique
    )

    if ($chatIds.Count -eq 0) {
        Write-Host "Nenhum chat encontrado. Envie /start ao bot, aguarde alguns segundos e execute este script novamente." -ForegroundColor Yellow
        exit 1
    }

    Write-Host "TELEGRAM_CHAT_ID encontrado:" -ForegroundColor Green
    $chatIds | ForEach-Object { Write-Host $_ }
}
catch {
    $statusCode = $null
    if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
        $statusCode = [int]$_.Exception.Response.StatusCode
    }
    if ($statusCode -eq 404) {
        Write-Host "Falha 404: token invalido. Gere outro com /token no @BotFather." -ForegroundColor Red
    }
    else {
        Write-Host ("Falha ao consultar o Telegram: {0}" -f $_.Exception.Message) -ForegroundColor Red
    }
    exit 1
}
finally {
    $telegramToken = $null
    $secureToken = $null
    $clipboardText = $null
    $tokenMatch = $null
    $uri = $null
}
