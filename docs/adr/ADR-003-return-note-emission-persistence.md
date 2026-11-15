# ADR-003: A persistência da emissão da nota de devolução

- **Status:** accepted
- **Date:** 2026-11-16

## Context

A #156 grava a nota de devolução emitida pelo mock na entrada da fila `outbox_return_notes` (#140) e reserva o número da nota numa tabela nova, `return_note_numbers`. O desenho está em `supabase/persistence-156-return-note-emission.md` e o registro dos modos em `supabase/persistence-modes.yaml`. A revisão do desenho deixou três pontos que dependem de quem mantém o banco: onde mora a história da entrada, como se constroem os índices novos e o que a numeração promete. O Worker fala com o banco só pelo PostgREST, cada requisição é uma transação, e a CLI do Supabase roda cada arquivo de migração numa transação.

## Decision

(a) A história de `outbox_return_notes` fica na própria linha. A entrada faz uma única transição a partir de `pendente`, para `emitida` ou `cancelada`, e a transição grava na linha quem, quando e o quê (`emitted_by`/`emitted_at` e a nota emitida, ou `cancelled_by`/`cancelled_at` e a justificativa). O estado antes é sempre `pendente` com essas colunas nulas, então nada se perde. A tabela-filha de história foi rejeitada.

(b) As duas `unique` novas de `outbox_return_notes` (`note_id` e `note_access_key`) e o índice `proposals_state_id_idx` são construídos dentro da migração, com uma trava curta de escrita, sem `CREATE INDEX CONCURRENTLY`. A CLI roda cada arquivo numa transação, e o `CONCURRENTLY` não roda dentro de uma. As tabelas são pequenas e as colunas novas são nulas em toda linha que já existe.

(c) A série de `return_note_numbers` pode ter buracos, porque o `nextval` roda antes do `ON CONFLICT`, mas uma entrada nunca ganha um segundo número: o `unique (return_note_id)` é o árbitro.

## Consequences

- Gravar a entrada e a sua história é um único `PATCH` condicional (`status=eq.pendente`), sem RPC. Se a máquina de estados ganhar uma segunda transição (reabrir, corrigir a nota emitida), a história passa a uma tabela-filha `(return_note_id, version, at, by, state jsonb)`, e gravar as duas juntas pede uma RPC; isso é um novo ADR.
- A migração trava as escritas em `outbox_return_notes` e em `proposals` enquanto lê cada tabela. Se uma delas crescer a ponto de a trava incomodar, o índice vai para um arquivo fora de transação, com o `CONCURRENTLY`.
- A numeração da nota não é contínua: uma disputa na primeira emissão, ou uma entrada cancelada entre a leitura e a reserva, deixa um número sem nota. Quem audita a série não deve tratar um buraco como perda. Numeração sem buraco pede um contador numa linha travada, e a emissão fiscal real está fora da #156.
- O cascade da exclusão roda com o dono da tabela, então o reset do #56 segue funcionando com `UPDATE`, `DELETE` e `TRUNCATE` revogados da reserva.

## Alternatives considered

- Tabela-filha de história para `outbox_return_notes`. Rejeitada: ela precisa de uma RPC para gravar a entidade e a história juntas, e a fila tem uma única transição.
- `CREATE INDEX CONCURRENTLY` em um segundo arquivo de migração. Rejeitada: a CLI roda o arquivo numa transação, e o índice cairia no push do merge; a trava curta em tabelas pequenas custa menos.
- Contador numa linha travada por `UPDATE ... RETURNING`, para uma série sem buracos. Rejeitada: a emissão emulada não pede e a emissão fiscal real está fora da #156.
