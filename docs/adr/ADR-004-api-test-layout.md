# ADR-004: Os testes da API ficam em `api/test/<pasta>/`

- **Status:** accepted
- **Date:** 2026-11-15

## Context

A regra de testes colocalizados do plugin de TypeScript (`rules/colocated-tests.md`) pede o teste de uma unidade ao lado dela, e a verificação `check-tests.py` cobra as condições 1 e 2 dessa regra. Todo arquivo de `api/src/<pasta>/` já tem o teste espelhado em `api/test/<pasta>/`, e a entrega do pedido ao fornecedor (#156) segue esse arranjo. Mover os testes para junto do código mudaria o repositório inteiro e deixaria dois arranjos convivendo.

## Decision

Os testes da API ficam em `api/test/<pasta>/`, espelhando `api/src/<pasta>/`, o arranjo que todo arquivo-fonte já segue. A verificação `check-tests.py` (condições 1 e 2 de `rules/colocated-tests.md`) roda com `api/` excluído. O script não tem opção de exclusão (`--help` não lista nenhuma), então quem o roda aplica a exclusão: não passa `api/` como diretório, ou descarta os achados sob `api/`, como o ADR-002 faz com o detector de linguagem dos bastidores. Decidido pela pessoa dona do repositório em 2026-11-15, na #156.

## Consequences

- Quem procura o teste de `api/src/domain/x.ts` o encontra em `api/test/domain/x.test.ts`, em todas as pastas.
- A verificação de testes colocalizados não protege `api/`; um arquivo-fonte sem teste é pego na revisão, não pelo script.
- Um arquivo novo em `api/src/<pasta>/` leva o teste em `api/test/<pasta>/`.

## Alternatives considered

- Colocalizar os testes ao lado do código-fonte, como a regra pede. Rejeitada: obrigaria a mover todos os testes existentes, ou deixaria dois arranjos no mesmo repositório.
