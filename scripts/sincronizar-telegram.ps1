[CmdletBinding()]
param(
    [switch]$FromClipboard,
    [switch]$VisibleInput
)

$ErrorActionPreference = "Stop"

Write-Host "Antes de continuar:" -ForegroundColor Cyan
Write-Host "1. Gere um token NOVO no BotFather com /revoke e depois /token."
Write-Host "2. Envie /start ao seu bot pelo celular."
Write-Host "3. Informe abaixo o token completo, incluindo os dois-pontos."
if ($FromClipboard -and $VisibleInput) {
    throw "Use apenas uma opcao: -FromClipboard ou -VisibleInput."
}
if ($FromClipboard) {
    $clipboardText = Get-Clipboard -Raw
    $tokenMatch = [regex]::Match($clipboardText, '(?<!\d)\d+:[A-Za-z0-9_-]{20,}')
    try { Set-Clipboard -Value " " -ErrorAction Stop } catch {
        Write-Host "Aviso: nao foi possivel limpar a area de transferencia." -ForegroundColor Yellow
    }
    if (-not $tokenMatch.Success) {
        throw "Nenhum token completo foi encontrado na area de transferencia."
    }
    $telegramToken = $tokenMatch.Value
}
elseif ($VisibleInput) {
    Write-Host "ATENCAO: o token ficara visivel somente durante a digitacao." -ForegroundColor Yellow
    $telegramToken = (Read-Host -Prompt "Token novo").Trim()
    Clear-Host
}
else {
    $secureToken = Read-Host -Prompt "Cole o token novo completo" -AsSecureString
    $telegramToken = [System.Net.NetworkCredential]::new("", $secureToken).Password.Trim()
}
Write-Host "Validando o token diretamente no Telegram..." -ForegroundColor Cyan

try {
    if ($telegramToken -notmatch '^\d+:[A-Za-z0-9_-]+$') {
        throw "Formato incorreto. Digite numeros, dois-pontos e o segredo, sem espacos ou aspas."
    }

    try {
        $bot = Invoke-RestMethod -Method Get -Uri "https://api.telegram.org/bot$telegramToken/getMe"
    }
    catch {
        throw "O Telegram rejeitou o token. Confira cada caractere ou gere outro no BotFather."
    }
    if (-not $bot.ok) {
        throw "O Telegram nao confirmou o token."
    }
    Write-Host ("Token confirmado para o bot @{0}." -f $bot.result.username) -ForegroundColor Green

    try {
        $updates = Invoke-RestMethod -Method Get -Uri "https://api.telegram.org/bot$telegramToken/getUpdates"
    }
    catch {
        throw "Nao foi possivel consultar as conversas do bot no Telegram."
    }
    $chats = @{}
    foreach ($update in $updates.result) {
        if (-not $update.message -or -not $update.message.chat) { continue }
        $chat = $update.message.chat
        $displayName = @($chat.first_name, $chat.last_name, $chat.title, $chat.username) |
            Where-Object { $_ } | Select-Object -First 1
        $chats[$chat.id.ToString()] = [pscustomobject]@{
            Id = $chat.id.ToString()
            Type = $chat.type
            Name = if ($displayName) { $displayName } else { "sem nome" }
        }
    }
    if ($chats.Count -eq 0) {
        throw "Nenhum chat encontrado. Envie /start ao bot no celular e execute este script novamente."
    }
    Write-Host "Conversas encontradas:" -ForegroundColor Cyan
    $chats.Values | Sort-Object Id | ForEach-Object {
        Write-Host ("- ID {0} | tipo {1} | nome {2}" -f $_.Id, $_.Type, $_.Name)
    }
    $chatId = (Read-Host -Prompt "Digite exatamente o ID que deve receber as mensagens").Trim()
    if (-not $chats.ContainsKey($chatId)) {
        throw "O ID informado nao pertence as conversas encontradas."
    }
    $confirmation = (Read-Host -Prompt "Digite CONFIRMAR para usar o chat $chatId").Trim()
    if ($confirmation -cne "CONFIRMAR") {
        throw "Operacao cancelada: o chat nao foi confirmado."
    }
    Write-Host ("Chat confirmado: {0}." -f $chatId) -ForegroundColor Green

    Write-Host "Atualizando TELEGRAM_BOT_TOKEN na Cloudflare..."
    $telegramToken | & npx.cmd wrangler secret put TELEGRAM_BOT_TOKEN
    if ($LASTEXITCODE -ne 0) {
        throw "O Wrangler nao conseguiu atualizar TELEGRAM_BOT_TOKEN."
    }

    Write-Host "Atualizando TELEGRAM_CHAT_ID na Cloudflare..."
    $chatId | & npx.cmd wrangler secret put TELEGRAM_CHAT_ID
    if ($LASTEXITCODE -ne 0) {
        throw "O Wrangler nao conseguiu atualizar TELEGRAM_CHAT_ID."
    }

    Write-Host "Telegram sincronizado com o Worker." -ForegroundColor Green
    Write-Host "Aguardando a atualizacao e executando a fila pendente..."
    Start-Sleep -Seconds 3
    & (Join-Path $PSScriptRoot "executar-worker.ps1")
}
finally {
    $telegramToken = $null
    $secureToken = $null
    $clipboardText = $null
    $tokenMatch = $null
    $chatId = $null
    $confirmation = $null
    $bot = $null
    $updates = $null
    $chats = $null
}
