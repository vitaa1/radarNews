# Integração e E2E do radarNews

Execute `npm run test:e2e` após `npm ci`, com Python 3.11+ no PATH. O CI executa a suíte em Windows e Linux. No Windows, `scripts/validar.ps1 -PythonPath ...` também usa o Python informado nesta etapa; para execução avulsa, `RADAR_TEST_PYTHON` aceita o caminho do executável e `RADAR_TEST_PYTHON_ARGS` uma lista JSON opcional de argumentos, como `["-3"]` para o launcher.

## O que é executado de verdade

- Bundle gerado diretamente de `src/index.ts`, sem reaproveitar artefato de deploy.
- Runtime workerd/Miniflare e banco D1 efêmero com todas as migrações versionadas.
- CLI Python `--once`, em processo separado, com os módulos locais copiados para um diretório temporário.
- Autenticação, reservas, leitura e extração de HTML, prompt, validação editorial, conclusão, backoff e persistência.
- Rejeição de redirecionamento da fonte e de requisição autenticada, concorrência de reservas e repetição da conclusão.

## Fronteiras simuladas

Supercell, YouTube, Ollama e Telegram usam respostas determinísticas. O transporte HTTPS da CLI é redirecionado exclusivamente para um servidor HTTP em `127.0.0.1`, preservando host, URL, headers e os handlers de segurança do código real. Portanto, a suíte não verifica TLS/certificados nem a qualidade ou velocidade de inferência do modelo.

O adaptador existe somente em `tests/e2e/python-entry.py`; nenhum bypass foi adicionado à aplicação. A CLI não lê `local/.env`, perfil ou banco pessoal: recebe uma cópia apenas dos módulos `.py`, configuração fictícia e ambiente filtrado. O Python usa `-I -S -B` para isolar imports, impedir inicialização via `site` e não gerar bytecode. URLs inesperadas são recusadas. Não há fallback para serviços reais. Os tempos de backoff são exercitados alterando a elegibilidade dos itens sintéticos no D1, sem esperar minutos.

Os diretórios `.wrangler/e2e-*`, servidores e runtimes são descartados ao terminar. O Node encerra um subprocesso Python que ultrapasse 20 segundos; cada cenário tem limite de 40 segundos. Logs de erro de Telegram em cenários de falha são esperados e contêm somente dados fictícios.

## Dependências do harness

Miniflare e esbuild agora são dependências diretas e fixadas nas mesmas versões que já estavam no lockfile via Wrangler. A suíte não depende implicitamente da organização das dependências transitivas.

Na verificação de 08/09/2026, `npm audit` reportou o aviso [GHSA-rgj7-g3m4-5g8c](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c) em `sharp`, propagado para Miniflare e Wrangler. As versões instaladas não foram introduzidas por esta suíte; o diff do lockfile apenas declara as dependências diretas. O fluxo E2E não configura Images nem processa imagens. A atualização dessa cadeia permanece um trabalho separado; não se deve aplicar o downgrade sugerido por `npm audit fix --force` sem avaliar compatibilidade.
