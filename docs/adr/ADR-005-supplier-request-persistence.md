# ADR-005: A persistência do pedido ao fornecedor

- **Status:** accepted
- **Date:** 2026-11-16

## Context

A #156 grava o pedido ao fornecedor (o e-mail da "Sai 2") numa caixa de saída nova, `outbox_supplier_emails`, e lê o e-mail do fornecedor numa tabela nova, `supplier_contacts`. O desenho está em `supabase/persistence-156-supplier-requests.md` e o registro dos modos em `supabase/persistence-modes.yaml`. O pedido nasce no rascunho do Cron (`draft`, ou `discarded` com o motivo) e, nas entregas seguintes, a pessoa edita o texto do rascunho, envia, descarta e reenvia o envio que falhou. O domínio (`api/src/domain/supplier-request.ts`, `isOpenRequest`) decidiu que `send_failed` é um pedido aberto, e o AC-8 pede que uma nota de origem não tenha dois pedidos abertos do mesmo tipo; o brief da issue falava só em `draft` e `sent`. O Worker fala com o banco só pelo PostgREST, cada requisição é uma transação, não há RPC, e a CLI do Supabase roda cada arquivo de migração numa transação. A forma da história da entrega 1 (ADR-003, a) vale só para uma transição, e o ADR-003 deixou para um novo ADR a história em tabela-filha. O workflow aplica as migrações antes de carregar a base do kit, e a pessoa prefere não alterar `kit_fornecedores`.

## Decision

(a) `outbox_supplier_emails` é upsert com história numa tabela-filha, `outbox_supplier_email_history (supplier_email_id, version, changed_at, changed_by, state jsonb)`, gravada por um gatilho `after insert or update` no mesmo comando da escrita. Um gatilho `before insert or update` guarda a versão (1 no insert, a anterior mais 1 no update), as transições aceitas, os campos imutáveis (nota, fornecedor, tipo, destinatário, pedidos, prazo, modelo, data do rascunho) e o texto que só muda no rascunho. Nenhum adaptador grava a história; todo PATCH filtra `version=eq.N` e diz `changed_by`. A história é append-only, com `UPDATE`, `DELETE` e `TRUNCATE` revogados dos papéis da API.

(b) Aberto é todo status menos `discarded`, como o domínio: `send_failed` é aberto, porque o reenvio é o mesmo pedido. O AC-8 é o índice único parcial `outbox_supplier_emails_open_request_key (invoice_access_key, request_type) where status <> 'discarded'`. `save` é um insert simples, sem `on_conflict` nem `ignore-duplicates`; `refused` é o HTTP 409 com o código `23505` e o nome desse índice, e qualquer outro erro, inclusive o 409 de chave estrangeira (`23503`), é lançado.

(c) O índice `outbox_return_notes_invoice_access_key_idx`, para a leitura do valor da devolução por nota, é construído dentro da migração, com uma trava curta de escrita, sem `CREATE INDEX CONCURRENTLY`, pelo mesmo motivo do ADR-003 (b).

(d) `supplier_contacts` é uma tabela própria, append-only com `growth: fixed`: só as migrações a gravam, e `INSERT`, `UPDATE`, `DELETE` e `TRUNCATE` ficam revogados dos papéis da API. A semente é a própria migração, um e-mail `fiscal.fNN@fornecedores.test` por fornecedor F01 a F12, sem chave estrangeira para `kit_fornecedores`; um teste offline confere os ids com `data/kit/fornecedores.json`.

## Consequences

- A unidade de trabalho registrada segue igual: cada escrita é uma requisição e um comando, com a história dentro dele. Não há RPC.
- A regra das transições mora em dois lugares, o domínio e a função do gatilho. Uma transição nova (por exemplo, descartar um `send_failed`) muda os dois, e a função muda numa migração com `create or replace function`.
- O `FakePostgrest` não imita o gatilho, a história nem as checagens; quem os prova é o teste online, que pula sem credenciais. Uma mudança no gatilho sem o teste online rodado passa no `make check`.
- `changed_by` é dito pelo adaptador: um PATCH que o esqueça atribui a versão a quem fez a escrita anterior. A revisão confere cada adaptador.
- Um pedido descartado nunca reabre: "Refazer" grava uma linha nova, e o índice parcial a deixa entrar.
- O sinal de `refused` depende do corpo do erro do PostgREST; se o conector cortar o corpo antes do código, o adaptador lança em vez de recusar, e a rodada do Cron falha em vez de seguir.
- Trocar um e-mail de fornecedor é uma migração. Uma tela que edite o contato muda o modo da tabela para upsert com história, num ADR que supera a decisão (d).
- A migração trava as escritas em `outbox_return_notes` enquanto lê a tabela. Se ela crescer a ponto de a trava incomodar, o índice vai para um arquivo fora de transação, com o `CONCURRENTLY`.

## Alternatives considered

- Uma RPC que grave o pedido e a história juntos. Rejeitada: abre um segundo caminho de escrita ao lado do PostgREST de tabelas e uma função exposta a mais, para o que o gatilho faz no mesmo comando.
- A história como coluna `jsonb` na própria linha, montada pelo adaptador a cada PATCH. Rejeitada: as edições do rascunho não têm teto, o adaptador poderia esquecer ou reescrever a história, e a história não teria a recusa por grant.
- A história na própria linha, como no ADR-003 (a). Rejeitada: o pedido tem várias transições e edições, e o estado antes de cada uma se perderia.
- O índice parcial com `where status in ('draft', 'sent')`, como o brief. Rejeitado: deixaria um segundo rascunho nascer ao lado de um envio que falhou, e os dois chegariam ao fornecedor.
- `save` com `on_conflict=invoice_access_key,request_type` e `ignore-duplicates`. Rejeitado: o PostgreSQL só infere um índice parcial com o predicado, e o PostgREST não documenta como mandá-lo.
- Uma coluna de e-mail em `kit_fornecedores`, carregada pelo `load_kit.py`. Rejeitada: altera o contrato e os arquivos do kit, que a pessoa prefere intactos.
- A semente num `supabase/seed.sql`. Rejeitada: a documentação do Supabase diz que o seed roda no `supabase start` e no `db reset`, e não diz que o `db push --remote` do workflow o rode.
