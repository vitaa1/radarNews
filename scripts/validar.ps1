[CmdletBinding()]
param(
    [string]$PythonPath
)

$ErrorActionPreference = "Stop"
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$wranglerLogDirectory = Join-Path $projectRoot ".wrangler\logs"
New-Item -ItemType Directory -Path $wranglerLogDirectory -Force | Out-Null
$env:WRANGLER_LOG_PATH = $wranglerLogDirectory

Write-Host "1/7 - Validando TypeScript e testes do coletor..."
npm run check
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "Validando limpeza dos temporarios com servicos simulados..."
powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $projectRoot "tests\temporary-config.tests.ps1")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$pythonArgs = @()
if ($PythonPath) {
    if (-not (Test-Path -LiteralPath $PythonPath -PathType Leaf)) {
        throw "O executavel informado em -PythonPath nao foi encontrado."
    }
    $pythonExecutable = (Resolve-Path -LiteralPath $PythonPath).Path
}
else {
    $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
    if (-not $pythonCommand) {
        $pythonCommand = Get-Command py -ErrorAction SilentlyContinue
        $pythonArgs = @("-3")
    }
    if (-not $pythonCommand) {
        throw "Python não encontrado. Instale Python 3.11 ou posterior, use -PythonPath e marque 'Add Python to PATH'."
    }
    $pythonExecutable = $pythonCommand.Source
}
$pythonVersionText = (& $pythonExecutable @pythonArgs -c "import sys; print('.'.join(map(str, sys.version_info[:3])))").Trim()
if ($LASTEXITCODE -ne 0) {
    throw "O comando Python foi encontrado, mas nao pode ser executado."
}
$pythonVersion = $null
if (-not [version]::TryParse($pythonVersionText, [ref]$pythonVersion) -or
    $pythonVersion -lt [version]"3.11") {
    throw "Python 3.11 ou posterior e obrigatorio; encontrado: $pythonVersionText."
}
Write-Host ("Python {0} encontrado." -f $pythonVersion)

Write-Host "2/7 - Validando lint e formatacao do Python..."
& $pythonExecutable @pythonArgs -m ruff check local tests
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& $pythonExecutable @pythonArgs -m ruff format --check local tests
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "3/7 - Compilando Python..."
& $pythonExecutable @pythonArgs -m compileall -q local tests
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "4/7 - Executando testes do Python com cobertura..."
& $pythonExecutable @pythonArgs -m coverage run -m unittest discover -s tests -p "test_*.py" -v
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& $pythonExecutable @pythonArgs -m coverage report
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "5/7 - Validando as migracoes no D1 local..."
npm run db:migrate:local
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "6/7 - Validando o pacote do Cloudflare Worker..."
npx wrangler deploy --dry-run --outdir .wrangler/dry-run
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "7/7 - Executando integracao e E2E com servicos simulados..."
$previousTestPython = $env:RADAR_TEST_PYTHON
$previousTestPythonArgs = $env:RADAR_TEST_PYTHON_ARGS
try {
    $env:RADAR_TEST_PYTHON = $pythonExecutable
    $env:RADAR_TEST_PYTHON_ARGS = ConvertTo-Json -InputObject $pythonArgs -Compress
    npm run test:e2e
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
finally {
    $env:RADAR_TEST_PYTHON = $previousTestPython
    $env:RADAR_TEST_PYTHON_ARGS = $previousTestPythonArgs
}

Write-Host "Tudo certo: qualidade, testes e pacote do Worker foram validados." -ForegroundColor Green
