# Instruções do projeto radarNews

## Revisão obrigatória antes de Pull Request

Para qualquer alteração de código, testes, configuração, infraestrutura ou documentação destinada a um Pull Request:

1. conclua a implementação e execute os quality gates relevantes;
2. antes de publicar a branch ou fornecer o link do PR, inicie em paralelo os agentes `code_reviewer` e `security_guard` definidos em `.codex/agents/`;
3. informe a ambos que devem revisar a branch atual contra `main` e aguarde a conclusão dos dois;
4. valide cada achado no código; os pareceres orientam a decisão, mas não substituem evidência;
5. corrija todos os achados críticos válidos e corrija ou documente a justificativa para achados importantes/hardening;
6. execute novamente os quality gates afetados;
7. se qualquer arquivo do diff mudar após os pareceres, execute novamente os dois agentes em paralelo;
8. só prepare ou publique o PR quando não houver achado crítico válido pendente.

Os agentes de revisão são somente leitura. Eles não devem editar arquivos, criar commits, publicar branches, acessar serviços reais nem manipular segredos.

Se os dois agentes não puderem ser executados, não declare que a revisão foi concluída. Interrompa o fluxo antes do PR e informe claramente a limitação ao usuário.

Inclua na descrição de cada PR uma seção `## Revisões automatizadas` com o resultado do `code_reviewer`, do `security_guard` e as correções realizadas a partir dos pareceres.

## Convenções gerais

- Documentação, comentários e mensagens voltadas ao usuário em pt-BR.
- Identificadores de código em inglês quando isso não quebrar contratos existentes.
- Preserve a separação entre Worker TypeScript, processamento Python local e migrações D1.
- Não inclua segredos, configuração pessoal, bancos locais, logs ou artefatos de ferramentas no Git.
- Use branches focadas, commits convencionais e PRs com uma responsabilidade principal.
- Prefira testes determinísticos com mocks/fakes nas fronteiras externas.
- Não reduza quality gates ou cobertura apenas para fazer o CI passar.
