## Contexto

<!-- Explique o problema ou a oportunidade que motivou este PR. -->

## Alterações

<!-- Liste as mudanças relevantes. -->

## Como validar

<!-- Informe os comandos executados e os cenários verificados. -->

- [ ] TypeScript e testes: `npm run check`
- [ ] Qualidade Python: `python -m ruff check local tests` e `python -m ruff format --check local tests`
- [ ] Testes Python: `python -m coverage run -m unittest discover -s tests -p "test_*.py" -v` e `python -m coverage report`
- [ ] Migrações locais: `npm run db:migrate:local`
- [ ] Bundle do Worker: `npm run validate:worker`

## Checklist

- [ ] O PR possui apenas uma responsabilidade principal.
- [ ] Não inclui segredos, credenciais ou configuração pessoal.
- [ ] Testes foram adicionados ou atualizados quando necessário.
- [ ] A documentação foi atualizada quando o comportamento mudou.
- [ ] Fiz uma auto-revisão do diff antes de solicitar revisão.

## Riscos e decisões

<!-- Registre limitações, trade-offs e pontos que merecem atenção na revisão. -->

## Próximos passos

<!-- Liste trabalhos relacionados que ficaram deliberadamente fora deste PR. -->
