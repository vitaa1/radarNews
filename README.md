# radarNews

O **radarNews** é um monitor pessoal e gratuito de conteúdo **já publicado oficialmente** sobre Brawl Stars. Ele detecta novidades da Supercell e do canal oficial do Brawl Stars na nuvem, avisa pelo Telegram e usa o Ollama no seu computador para criar uma pauta em português para os artigos que contêm texto verificável. A pauta transforma o anúncio em um ponto de partida para um vídeo útil e diferenciado, sem inventar fatos para disputar atenção.

O projeto não procura vazamentos, arquivos escondidos, servidores privados, rumores, Reddit ou perfis não oficiais. As fontes monitoradas são:

- [blog oficial do Brawl Stars](https://supercell.com/en/games/brawlstars/blog/page/1/);
- [anúncios oficiais de Brawl Stars da Supercell](https://supercell.com/en/news/announcement/brawlstars/page/1/);
- [feed público do canal oficial do Brawl Stars no YouTube](https://www.youtube.com/@BrawlStars), identificado a partir dos links publicados pela própria Supercell.

Instagram, X, TikTok e Facebook não são coletados diretamente: essas plataformas não oferecem neste fluxo um feed público estável e sem credenciais. Fazer scraping das páginas aumentaria o risco de bloqueios, falsos positivos e quebras frequentes.

## Como funciona

1. Um Cloudflare Worker roda automaticamente a cada 15 minutos.
2. Ele consulta as páginas oficiais e o feed público do YouTube e grava os links no banco gratuito D1.
3. Uma publicação nova gera um alerta simples no Telegram.
4. Para artigos da Supercell, o processador Python, enquanto seu computador estiver ligado, reserva uma pauta pendente, recebe até oito ângulos editoriais recentes e abre apenas a URL oficial recebida. Vídeos do YouTube geram somente alerta, pois o sistema não inventa uma pauta sem transcrição oficial verificável.
5. O Ollama combina a fonte com o perfil local do canal e, quando existirem, resultados anteriores informados pelo criador. Ele produz resumo, público-alvo, ângulo diferenciado, gancho de abertura, três estilos de título, conceito de thumbnail, estratégia de retenção, experimento de crescimento e roteiro curto em português.
6. O Python devolve a pauta ao Worker, que a salva e a envia ao Telegram. Se o Telegram falhar, o Worker tenta novamente no próximo ciclo. Falhas de processamento usam espera progressiva e, após cinco tentativas, vão para uma fila de falhas.

Na primeira consulta de **cada fonte**, as publicações atuais viram uma linha de base e não geram alertas antigos. Só o que aparecer depois será tratado como novidade.

## O que você precisa

- Windows 10 ou 11 com PowerShell;
- uma conta gratuita na [Cloudflare](https://dash.cloudflare.com/sign-up);
- [Node.js 22 ou posterior](https://nodejs.org/);
- [Python 3.11 ou posterior](https://www.python.org/downloads/) — durante a instalação no Windows, marque **Add Python to PATH**;
- [Ollama](https://ollama.com/download);
- uma conta no Telegram.

Não é preciso instalar pacotes Python: o processador usa apenas a biblioteca padrão.

## Instalação passo a passo

### 1. Abrir o projeto e instalar o TypeScript

Abra o PowerShell e execute:

```powershell
cd C:\radar-news
npm install
npm run check
```

O último comando valida os tipos e os testes TypeScript. A validação completa, incluindo Python, migrações e empacotamento do Worker, aparece na seção [Validar tudo depois de uma alteração](#validar-tudo-depois-de-uma-alteração).

### 2. Criar o bot do Telegram

1. No Telegram, abra a conversa verificada com `@BotFather`.
2. Envie `/newbot` e siga as instruções.
3. Guarde o token recebido. Ele funciona como uma senha.
4. Abra uma conversa com o bot recém-criado e envie `/start`.
5. No PowerShell, teste o token sem gravá-lo no histórico. Digite somente o comando abaixo e pressione `Enter`:

```powershell
.\scripts\testar-telegram.ps1
```

Quando aparecer `Cole o NOVO token completo do BotFather:`, cole o token e pressione `Enter`. Não escreva o token na mesma linha do comando. A entrada fica oculta.

Se o seu terminal colar apenas um caractere no campo oculto, copie o token no BotFather e execute a variante abaixo. Ela extrai o token da área de transferência e a limpa imediatamente:

```powershell
.\scripts\testar-telegram.ps1 -FromClipboard
```

Se o token estiver apenas no celular, envie `/start` ao bot e use o modo de digitacao visivel para conferir cada caractere. O texto digitado nao entra no historico e a tela e limpa assim que voce pressiona `Enter`:

```powershell
.\scripts\testar-telegram.ps1 -VisibleInput
```

Esse teste tambem mostra o `TELEGRAM_CHAT_ID`, evitando digitar o token uma segunda vez.

6. Se o teste anterior não tiver mostrado nenhum chat ID, envie `/start` ao bot e execute:

```powershell
.\scripts\obter-chat-id.ps1
```

Esse passo é opcional quando `testar-telegram.ps1` já tiver mostrado o chat correto. Cole o token somente quando o script pedir. O número exibido é o seu `TELEGRAM_CHAT_ID`. Se nada aparecer, envie outra mensagem ao bot, aguarde alguns segundos e execute o script novamente.

Para usar a área de transferência nessa etapa, copie o token novamente e execute `./scripts/obter-chat-id.ps1 -FromClipboard`.

### 3. Entrar na Cloudflare e criar o D1

Ainda em `C:\radar-news`, execute:

```powershell
npx wrangler login
npx wrangler d1 create radar-news
```

O navegador pedirá autorização da sua conta. Depois, o segundo comando mostrará um identificador parecido com:

```text
database_id = "12345678-abcd-1234-abcd-1234567890ab"
```

Abra [wrangler.jsonc](./wrangler.jsonc) no Bloco de Notas e substitua o valor existente de `database_id` pelo identificador devolvido para a **sua** conta, preservando as aspas e a vírgula. O identificador presente no arquivo pertence à implantação original e não funciona em outra conta Cloudflare.

Agora crie as tabelas no banco remoto:

```powershell
npm run db:migrate:remote
```

Ao atualizar uma instalação existente, execute esse mesmo comando antes de publicar a nova versão do Worker. As migrações são incrementais e preservam os itens já coletados.

Confirme com `y` se o Wrangler pedir permissão para aplicar a migração.

### 4. Criar os segredos sem colocá-los no código

Gere uma chave aleatória e guarde o resultado temporariamente:

```powershell
$sharedSecret = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$sharedSecret
```

Cadastre os três segredos. Cada comando abre um campo próprio; cole apenas o valor solicitado e pressione Enter:

```powershell
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put SHARED_SECRET
```

**Não substitua os nomes em letras maiúsculas nos comandos.** Por exemplo, execute literalmente `npx wrangler secret put TELEGRAM_BOT_TOKEN`; somente depois que aparecer `Enter a secret value` informe o token. O mesmo vale para os outros dois comandos.

Use o token do `@BotFather`, o número obtido no passo 2 e a chave `$sharedSecret`, respectivamente. Esses valores ficam na Cloudflare e não entram nos arquivos do projeto. Ao executar `npx wrangler secret list`, devem aparecer exatamente os nomes `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` e `SHARED_SECRET`, nunca os próprios valores.

### 5. Publicar o Worker

```powershell
npm run deploy
```

No final, copie a URL parecida com:

```text
https://radar-news.seu-subdominio.workers.dev
```

O agendamento `*/15 * * * *` já está em [wrangler.jsonc](./wrangler.jsonc). A Cloudflare pode levar alguns minutos para ativar ou atualizar um agendamento.

### 6. Criar a linha de base e testar a nuvem

Troque a URL do exemplo pela URL publicada:

```powershell
$workerUrl = "https://radar-news.seu-subdominio.workers.dev"
Invoke-RestMethod "$workerUrl/health"

$headers = @{ Authorization = "Bearer $sharedSecret" }
Invoke-RestMethod -Method Post -Uri "$workerUrl/api/run" -Headers $headers
```

A primeira resposta deve conter `baselineStored` e `baselineCreated` dentro de cada fonte nova. É correto não receber alertas nessa primeira execução: isso evita várias mensagens antigas.

Para conferir a fila e os totais:

```powershell
Invoke-RestMethod -Uri "$workerUrl/api/status" -Headers $headers
```

### 7. Preparar o Ollama e o Python local

Depois de instalar o Ollama, abra um novo PowerShell e baixe o modelo uma única vez:

```powershell
ollama pull gemma3:4b
```

Copie o modelo de configuração local:

```powershell
Copy-Item local\.env.example local\.env
notepad local\.env
```

No arquivo aberto, preencha:

```dotenv
WORKER_URL=https://radar-news.seu-subdominio.workers.dev
SHARED_SECRET=cole_a_mesma_chave_gerada_no_passo_4
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_MODEL=gemma3:4b
LOCAL_POLL_SECONDS=60
LOCAL_BATCH_SIZE=3
```

Salve e feche. O arquivo `local/.env` está ignorado pelo Git e não deve ser compartilhado.

Personalize também o perfil editorial. Em uma instalação nova, copie o exemplo:

```powershell
Copy-Item local\perfil-canal.example.json local\perfil-canal.json
notepad local\perfil-canal.json
```

O perfil define posicionamento, público, tom de voz, diferenciais e práticas que devem ser evitadas. Ele fica somente no computador, é opcional e já pode ser alterado a qualquer momento sem novo deploy.

### 8. Executar o processador

Faça um teste único:

```powershell
python local\processador.py --once
```

Se o Windows não reconhecer `python`, tente:

```powershell
py -3 local\processador.py --once
```

Quando não houver novidade, a mensagem `Nenhuma pauta pendente.` significa que está tudo certo. Para manter o processador acompanhando a fila enquanto o computador estiver ligado:

```powershell
python local\processador.py
```

Encerre com `Ctrl+C`. O Worker continua monitorando e enviando alertas simples com o computador desligado; só a geração das pautas espera o processador local voltar.

### 9. O que fazer ao ligar o computador

Você não precisa executar `executar-worker.ps1` para continuar recebendo notícias. O Worker está na Cloudflare, roda automaticamente a cada 15 minutos e envia os alertas ao Telegram mesmo quando o computador está desligado.

Ao ligar o computador, execute apenas o processador se quiser gerar as pautas com Ollama:

```powershell
cd C:\radar-news
python local\processador.py
```

Deixe esse terminal aberto e encerre com `Ctrl+C`. Se `python` não estiver disponível, use `py -3 local\processador.py`. As pautas acumuladas enquanto o computador estava desligado serão processadas quando esse programa voltar a rodar.

O comando abaixo é opcional e serve somente para forçar uma busca imediata, sem esperar o próximo intervalo de 15 minutos:

```powershell
.\scripts\executar-worker.ps1
```

## Teste seguro sem enviar a pauta

Se já existir um item pendente, este comando gera e mostra a pauta no terminal, mas devolve o item à fila sem publicá-la no Telegram:

```powershell
python local\processador.py --once --dry-run
```

O `--dry-run` só encontra algo quando já existe uma pauta pendente. Ele não cria uma notícia artificial, não envia a pauta ao Telegram e devolve o item à fila sem aumentar o contador de falhas.

## Verificação prática do fluxo

Para verificar a operação normal sem alterar manualmente o D1:

```powershell
.\scripts\executar-worker.ps1
python local\processador.py --once
```

O primeiro comando força a coleta e tenta novamente entregas pendentes. O segundo processa no máximo uma pauta disponível. Se não houver publicação nova, `inserted: 0`, nenhum alerta enviado e `Nenhuma pauta pendente.` são resultados normais — significam que a linha de base está atualizada.

Quando houver uma novidade real, o Telegram receberá primeiro o alerta e depois a pauta criada pelo Ollama. Vídeos do YouTube recebem somente o alerta. Não use comandos `INSERT`, `UPDATE` ou `DELETE` no D1 remoto apenas para testar; um teste sintético exige criação e limpeza controladas para não contaminar a fila e as métricas.

## Como usar a pauta para criar um vídeo

A mensagem detalhada do Telegram foi organizada para ajudar na decisão editorial, não para substituir sua revisão:

- **público-alvo:** indica para quem aquele assunto tende a ser mais útil;
- **ângulo diferenciado:** propõe um recorte sustentado pela notícia, com valor prático ou contexto em vez de mera repetição;
- **gancho de abertura:** entrega a promessa do vídeo logo nos primeiros 10 a 20 segundos, sem uma introdução genérica;
- **títulos:** apresenta, nesta ordem, uma alternativa pesquisável, uma intrigante e uma equilibrada;
- **conceito de thumbnail:** sugere uma composição simples, um elemento principal e texto curto coerente com a fonte;
- **estratégia de retenção:** distribui a informação nos intervalos de 0–10, 10–25 e 25–45 segundos;
- **experimento de crescimento:** muda somente título, thumbnail ou gancho e define a métrica que será comparada com o histórico do canal;
- **roteiro curto:** traz uma base pronta para narração de aproximadamente 45 segundos;
- **o que verificar:** destaca pontos que ainda exigem conferência humana.

Antes de publicar, escolha o título e a thumbnail que representem corretamente o vídeo e confirme cada afirmação na fonte oficial. Depois da publicação, compare a taxa de cliques por origem de tráfego e a retenção dos primeiros 30 segundos com o histórico do próprio canal. Quedas, picos e melhores momentos mostram onde ajustar o próximo roteiro; não existe um único número universal que sirva como meta para todos os canais.

Essa estratégia segue as orientações oficiais do YouTube sobre [títulos e thumbnails](https://support.google.com/youtube/answer/12340300?hl=pt-BR), [retenção de público](https://support.google.com/youtube/answer/9314415?hl=pt-BR), [desempenho no sistema de recomendações](https://support.google.com/youtube/answer/16559650?hl=pt-BR) e [saúde e crescimento do canal](https://support.google.com/youtube/answer/16766712?hl=pt-BR).

## Ciclo de aprendizado com o desempenho do canal

O radarNews não promete crescimento nem escolhe uma métrica universal. Ele cria um experimento por pauta e pode usar o histórico do próprio canal para propor a próxima hipótese. Os dados são registrados manualmente a partir do YouTube Studio e permanecem em `local/desempenho.db`, que está ignorado pelo Git.

Depois que um vídeo for publicado, execute:

```powershell
python local\desempenho.py registrar
```

Informe a URL pública, o título usado, o formato e as métricas que já estiverem disponíveis. Deixe em branco o que ainda não existir ou não se aplicar ao formato. Uma rotina prática é:

1. registrar título, formato e as primeiras métricas após aproximadamente 48 horas;
2. executar o mesmo comando após sete dias e informar novamente a mesma URL;
3. preencher as métricas novas — os valores antigos não informados são preservados;
4. anotar uma observação curta, como `gancho direto, mas thumbnail pouco legível`;
5. manter `python local\processador.py` em execução normalmente. O diário é relido a cada consulta e passa a orientar as próximas pautas.

Para visualizar o resumo que será fornecido ao Ollama:

```powershell
python local\desempenho.py resumo
```

O resumo inclui quantidade da amostra, médias disponíveis e até oito vídeos recentes. Com menos de cinco vídeos comparáveis, o próprio contexto manda tratar qualquer padrão apenas como hipótese. CTR é mais útil para avaliar título e thumbnail; retenção aos 30 segundos ajuda a avaliar o gancho. Não compare diretamente formatos ou origens de tráfego diferentes como se fossem equivalentes.

Além das métricas locais, o Worker fornece automaticamente os últimos oito ângulos ainda retidos no D1. Assim, uma pauta nova tenta evitar repetir o mesmo recorte do próprio canal quando a notícia permitir uma alternativa honesta. Esse histórico exige apenas o deploy da versão atual e não precisa de migração nova.

## Validar tudo depois de uma alteração

O atalho abaixo valida TypeScript, testes do coletor, compilação e testes Python, migrações locais e o empacotamento do Worker:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\validar.ps1
```

Se o Python estiver instalado mas não estiver no `PATH`, informe o executável com `-PythonPath C:\caminho\python.exe`.

Também é possível executar cada verificação separadamente:

```powershell
npm run check
python -m compileall -q local tests
python -m unittest discover -s tests -p "test_*.py" -v
npm run db:migrate:local
npx wrangler deploy --dry-run
```

## Solução de problemas

### `Não autorizado` ou HTTP 401

O `SHARED_SECRET` de `local/.env` precisa ser exatamente o mesmo cadastrado com `wrangler secret put SHARED_SECRET`. Cadastre novamente se houver dúvida e faça novo deploy.

Para gerar uma chave nova, cadastrar exatamente o mesmo valor no Worker, salvar em `local/.env` e testar a autenticação automaticamente, execute:

```powershell
.\scripts\sincronizar-shared-secret.ps1
```

O script usa a `WORKER_URL` já salva em `local/.env`. Para apontar explicitamente para outra implantação, use `-WorkerUrl https://seu-worker.workers.dev`; a URL não fica mais fixa dentro do script.

### Nenhuma mensagem chega ao Telegram

- confira se enviou `/start` ao bot;
- confira o `TELEGRAM_CHAT_ID`;
- recadastre `TELEGRAM_BOT_TOKEN` e `TELEGRAM_CHAT_ID`;
- execute `npx wrangler tail`, depois chame `/api/run` em outro PowerShell e observe o erro;
- lembre que a primeira execução cria a linha de base e não alerta itens antigos.

Para validar um token novo, descobrir o chat ID, sincronizar os dois valores com a Cloudflare e tentar novamente as entregas pendentes em uma unica operacao, execute:

```powershell
.\scripts\sincronizar-telegram.ps1
```

Por padrão, o token é solicitado de forma oculta. Também é possível usar `-FromClipboard` ou, se a colagem oculta não funcionar no seu terminal, `-VisibleInput`. O script lista as conversas encontradas e só grava o `TELEGRAM_CHAT_ID` depois que você digita o ID exato e confirma explicitamente.

### Item na fila de falhas

Depois de cinco falhas, uma pauta deixa de ser tentada automaticamente. Consulte `failedItems` em `/api/status`, corrija a causa e recoloque um item específico na fila:

```powershell
$headers = @{ Authorization = "Bearer $sharedSecret" }
$itemId = "cole_o_id_de_64_caracteres"
Invoke-RestMethod -Method Post -Uri "$workerUrl/api/items/$itemId/retry" -Headers $headers
```

### `ollama` não é reconhecido

Feche e abra o PowerShell depois de instalar o Ollama. Se necessário, abra o aplicativo Ollama pelo menu Iniciar. Confirme com `ollama --version`.

### O modelo está lento ou falta memória

Feche aplicativos pesados e reduza `LOCAL_BATCH_SIZE` para `1`. O modelo `gemma3:4b` é local; o tempo depende do computador e uma pauta mais completa pode levar alguns minutos. O processador limita o contexto e o tamanho da resposta, aguarda até dez minutos e mantém cada reserva abaixo do prazo de quinze minutos do Worker.

### Uma fonte aparece com erro

O Worker não cria uma linha de base vazia. Isso é intencional: se o HTML oficial mudar ou ficar indisponível, ele registra o erro e tenta de novo no ciclo seguinte, sem transformar publicações antigas em falsos alertas.

## Segurança e limites editoriais

- Nunca coloque tokens em `src/`, no `wrangler.jsonc` ou em commits.
- Não compartilhe `.dev.vars` nem `local/.env`.
- A autenticação do processador usa `Authorization: Bearer`; a chave não vai na URL.
- O Python rejeita redirecionamentos e URLs fora de `https://supercell.com`. Links do YouTube são apenas notificados pelo Worker e nunca são abertos pelo processador local.
- As entregas ao Telegram usam identificadores de referência e registram o `message_id`. Como Telegram e D1 são sistemas separados, uma falha exatamente depois de um envio aceito ainda pode produzir uma repetição; a referência permite identificá-la com segurança.
- Todo texto do Ollama deve ser revisado por uma pessoa antes de virar conteúdo público. O modelo pode errar mesmo com uma fonte oficial.
- O prompt proíbe rumores e vazamentos, pede que ressalvas da própria Supercell sejam preservadas e impede que hipóteses editoriais sejam apresentadas como fatos.
- Título, thumbnail, gancho e roteiro devem fazer a mesma promessa. Clickbait enganoso prejudica a confiança do público e pode afetar a monetização.
- `local/perfil-canal.json` e `local/desempenho.db` ficam somente no computador e não devem ser removidos se você quiser preservar a personalização e o histórico.
- O projeto foi dimensionado para uso pessoal de baixo volume nas faixas gratuitas, mas os limites dos serviços podem mudar.

## Arquivos principais

- [src/index.ts](./src/index.ts): rotas, cron, D1, reservas e Telegram;
- [src/source-parser.ts](./src/source-parser.ts): reconhecimento dos links oficiais;
- [migrations](./migrations): estrutura e evoluções incrementais do D1;
- [local/processador.py](./local/processador.py): leitura segura, Ollama e devolução da pauta;
- [local/desempenho.py](./local/desempenho.py): diário SQLite local e resumo de métricas do canal;
- [local/perfil-canal.example.json](./local/perfil-canal.example.json): modelo de posicionamento editorial do canal;
- [scripts/executar-worker.ps1](./scripts/executar-worker.ps1): força uma coleta imediata usando a configuração de `local/.env`;
- [local/.env.example](./local/.env.example): modelo de configuração sem credenciais;
- [tests](./tests): testes TypeScript e Python.

## Rotas do Worker

| Método | Rota | Uso |
|---|---|---|
| `GET` | `/health` | saúde pública, sem dados privados |
| `POST` | `/api/run` | força uma coleta manual |
| `GET` | `/api/status` | mostra totais, saúde operacional, entregas e fila de falhas |
| `POST` | `/api/items/claim` | reserva pautas para o processador |
| `POST` | `/api/items/:id/complete` | salva e entrega uma pauta |
| `POST` | `/api/items/:id/release` | devolve uma pauta com falha à fila |
| `POST` | `/api/items/:id/retry` | recoloca manualmente um item da fila de falhas |

Todas as rotas `/api/*` exigem o `SHARED_SECRET`.
