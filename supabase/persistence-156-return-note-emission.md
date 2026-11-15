# Desenho de persistência: emissão da nota de devolução (#156, entrega 1)

Issue: barte-ai-services/formacao-fde-solucao-case#156, "Sai 1", AC-2 e AC-4. Banco: PostgreSQL 17 no
Supabase (`supabase/config.toml`, `[db] major_version = 17`), alcançado pelo Worker só pelo PostgREST.
Registro: `supabase/persistence-modes.yaml`. Migração a criar: `supabase/migrations/20261116110000_return_note_emission.sql`.

Este desenho não escreve migração, adaptador nem teste: é o que a camada OLTP escreve e o que a
revisão cobra dela.

## Entradas

| Entrada | Valor | Fonte |
|---|---|---|
| Agregados e raízes | A entrada da fila de devolução (`ReturnNoteEntry`, raiz, em `outbox_return_notes`), que recebe a nota emitida (`ReturnNoteDocument`, valor, no formato do kit); a reserva do número do emissor mock (fato, em tabela nova). `Invoice` e `Proposal` só são lidos. | `api/src/returns/ports.ts`, `api/src/domain/return-note.ts`, #156 |
| Consultas | Q-P1 propostas decididas (`state in (aprovada, alterada)`); Q-P2 as notas dessas propostas por `access_key`; Q-P3 a caixa inteira em ordem de `id` (`SupabaseOutbox.list`); Q-P4 publicar com `on_conflict=idempotency_key`. Q-E1 a entrada por `id`; Q-E2 a nota de origem por `access_key`; Q-R1 a reserva por `return_note_id`; Q-R2 reservar com `on_conflict=return_note_id` e `ignore-duplicates`; Q-R3 reler a reserva depois de Q-R2; Q-E3 o PATCH condicional `id=eq.X&status=eq.pendente`. A fila da #140 por `status` segue como está. | casos de uso no HEAD 6f42821, `return-notes.ts` (#140) |
| Inquilino | nenhum | brief; `strategies.tenancy: none` |
| Números assumidos | Linhas em `outbox_return_notes`, `proposals` e `invoices`: não informado (o caso trabalha com 80 notas do kit, que o reconferir do #56 recria). Taxa de emissão: não informada; uma pessoa por clique. | |

## Nomes das colunas

O brief pede "`nota_id`, chave, série e sequência". As chaves do documento ficam como estão no
`jsonb`, porque o documento copia o formato do kit e já leva `ADR-001` no domínio. As colunas da
tabela são inventadas pelo repositório numa tabela do domínio, cujas colunas já são em inglês
(`invoices.access_key`, `number`, `series`; `outbox_return_notes.nfe_number`, `emitted_by`), então
seguem o ADR-001 na parte "tudo o que o repositório inventa tem nome em inglês", com o prefixo
`note_` para não confundir com a nota de origem (`invoice_access_key`):

| Chave no documento (ADR-001) | Coluna |
|---|---|
| o documento inteiro | `note_document jsonb` |
| `nota_id` | `note_id text` |
| `chave` | `note_access_key text` |
| `serie` | `note_series smallint` |
| `numero` | `note_number bigint` (e `nfe_number` = `note_number::text`, como o brief pede) |

## Tabelas

| Tabela | Modo | Por quê: fato ou entidade editada | História: forma e lugar | Versão | Inquilino |
|---|---|---|---|---|---|
| `outbox_return_notes` | upsert-with-history | Entrada de fila que nasce `pendente` e faz uma única transição, para `emitida` ou `cancelada`; a transição é gravada na linha (#140). | Na própria linha (`in-row-transition`): o estado antes é sempre `pendente` com as colunas da transição nulas; a transição grava quem, quando e o quê. Ver "Condições não cumpridas na forma da doc". | `status`: só `pendente` aceita escrita | nenhum |
| `return_note_numbers` (nova) | append-only | O fato "o número N ficou com a entrada E". Uma linha por entrada, nunca muda. | nenhuma; recusa de `UPDATE`, `DELETE` e `TRUNCATE` por grant | n/a | nenhum |

### Por que uma tabela de reserva com identidade, e não uma sequência com RPC

Escolhido: `return_note_numbers` com `number bigint generated always as identity` e `return_note_id`
único. O adaptador reserva pelo cliente PostgREST que já existe, sem RPC:

1. Q-R1: `select` em `return_note_numbers` com `return_note_id=eq.<entryId>`; achou, usa o número.
2. Q-R2: senão, `insert` de `{ return_note_id }` com `onConflict: 'return_note_id'` e
   `ignoreDuplicates: true`; voltou linha, usa o número.
3. Q-R3: voltou vazio (outra emissão reservou no meio), relê como no passo 1.

Por quê:

- **Idempotente pela restrição, não pelo código.** O `unique (return_note_id)` é o árbitro: duas
  emissões da mesma entrada, juntas ou uma depois da outra, terminam com uma linha e um número. Uma
  sequência com RPC só seria idempotente se a função também procurasse e travasse a reserva, ou
  seja, se tivesse esta mesma tabela dentro dela.
- **Sem método novo no cliente.** `insert` com `on_conflict` e `ignore-duplicates` é o mesmo caminho
  que a caixa de saída do #59 já usa (`SupabaseOutbox.publish`) e que o `fake-postgrest.ts` já cobre.
  Cada requisição do PostgREST roda numa transação própria ([PostgREST: Transactions](https://docs.postgrest.org/en/stable/references/transactions.html)).
- **A reserva sobrevive à emissão que cai no meio.** Se o Worker cai depois de reservar e antes do
  PATCH, a entrada continua `pendente` e a próxima emissão encontra a mesma reserva no passo 1.
- **Não precisa de `UPDATE`.** `INSERT ... ON CONFLICT DO NOTHING` pede só `INSERT` e `SELECT` nas
  colunas do árbitro; só o `DO UPDATE` pede `UPDATE` ([PostgreSQL: INSERT](https://www.postgresql.org/docs/current/sql-insert.html)).
  Por isso o `UPDATE` pode ser revogado da tabela. A página do PostgREST não diz que
  `resolution=ignore-duplicates` vira `ON CONFLICT DO NOTHING`; o teste online T6 é o que prova
  que a reserva funciona com o `UPDATE` revogado.

O custo, aceito: **a numeração tem buracos.** Um `INSERT ... ON CONFLICT` calcula a linha, com o
`nextval`, antes de detectar o conflito, e o valor do `nextval` não volta ([PostgreSQL: Sequence
Manipulation Functions](https://www.postgresql.org/docs/current/functions-sequence.html)). Uma
disputa na primeira emissão da mesma entrada consome um número que nenhuma nota usa, e uma entrada
cancelada entre a leitura e a reserva fica com um número sem nota. A entrada nunca ganha um segundo
número, que é o requisito; a série é que pula. A sequência com RPC tem o mesmo buraco pelo mesmo
motivo. Numeração sem buraco pediria um contador numa linha travada por `UPDATE ... RETURNING`
dentro de uma função, o que a emissão emulada não pede (a emissão fiscal real está fora da #156).
O passo 1 antes do `insert` mantém o buraco no caso raro da disputa, e não em toda nova tentativa.

A série é uma constante do emissor mock e não é coluna da reserva: com uma série só, o número é
único na tabela. Trocar a série, ou ter duas, é desenho novo (a reserva passa a ser por série).

Rejeitado também: uma chave estrangeira composta `outbox_return_notes (id, note_number)` →
`return_note_numbers (return_note_id, number)`, que provaria no banco que a nota usa o número da
sua reserva. Ela fecha um ciclo entre as duas tabelas, e o reset do #56 (`api/src/ops/reconferir.ts`
apaga `outbox_return_notes`) passaria a depender da ordem das checagens do ciclo. O vínculo fica no
adaptador e no teste T1.

## A migração `20261116110000_return_note_emission.sql`

Colunas, restrições e grants exatos. Os comentários seguem o padrão das migrações (`-- #156 ...`).

```sql
-- #156 A nota de devolução emitida pelo mock fica na entrada da fila (#140), e o número sai de uma reserva por entrada.
-- #156 RLS segue ligado e sem política (AC-6 do #59): só o Worker lê e grava.

alter table public.outbox_return_notes
  add column note_document jsonb,
  add column note_id text,
  add column note_access_key text,
  add column note_series smallint,
  add column note_number bigint;

alter table public.outbox_return_notes
  -- #156 Tudo nulo (pendente, cancelada, ou emitida à mão pela #140) ou tudo junto, só em emitida,
  -- com as colunas iguais ao documento e o nfe_number igual ao número da nota.
  add constraint outbox_return_notes_note_check check (
    (note_document is null and note_id is null and note_access_key is null
      and note_series is null and note_number is null)
    or (
      status = 'emitida' -- ADR-002
      and note_document is not null and note_id is not null and note_access_key is not null
      and note_series is not null and note_number is not null
      and jsonb_typeof(note_document) = 'object'
      and note_document ->> 'nota_id' is not distinct from note_id -- ADR-001
      and note_document ->> 'chave' is not distinct from note_access_key -- ADR-001
      and note_document ->> 'serie' is not distinct from note_series::text -- ADR-001
      and note_document ->> 'numero' is not distinct from note_number::text -- ADR-001
      and note_document ->> 'nota_referenciada' is not distinct from invoice_access_key -- ADR-001
      and nfe_number is not distinct from note_number::text
    )
  ),
  add constraint outbox_return_notes_note_id_format_check check (note_id ~ '^ND-[0-9]{4,}$'),
  add constraint outbox_return_notes_note_access_key_format_check check (note_access_key ~ '^[0-9]{44}$'),
  add constraint outbox_return_notes_note_series_check check (note_series between 1 and 999),
  add constraint outbox_return_notes_note_number_check check (note_number between 1 and 999999999),
  add constraint outbox_return_notes_note_id_key unique (note_id),
  add constraint outbox_return_notes_note_access_key_key unique (note_access_key);

alter table public.outbox_return_notes enable row level security;

-- #156 A reserva do número do emissor mock: uma por entrada da fila, e nunca muda.
create table public.return_note_numbers (
  number bigint generated always as identity,
  return_note_id bigint not null,
  reserved_at timestamptz not null default now(),
  constraint return_note_numbers_pkey primary key (number),
  constraint return_note_numbers_return_note_id_key unique (return_note_id),
  constraint return_note_numbers_return_note_fkey foreign key (return_note_id)
    references public.outbox_return_notes (id) on delete cascade,
  constraint return_note_numbers_number_check check (number between 1 and 999999999)
);
alter table public.return_note_numbers enable row level security;
-- #156 Append-only: a reserva não muda e não se apaga. O INSERT ... ON CONFLICT DO NOTHING não pede
-- #156 UPDATE. O cascade da chave estrangeira roda com o dono da tabela da entrada, então o reset do
-- #156 #56 segue funcionando sem DELETE. A série pode ter buracos, nunca repete (ADR-003, decisão c).
revoke update, delete, truncate on public.return_note_numbers from anon, authenticated, service_role;

-- #156 Serve a leitura das propostas decididas pelo Cron, `state=in.(aprovada,alterada)`, em ordem de id.
-- #156 Índice simples, sem concurrently (ADR-003, decisão b).
create index proposals_state_id_idx on public.proposals (state, id);
```

Notas para quem escreve:

- **Por que `is not distinct from` e não `=`.** Uma checagem passa quando a expressão dá nulo
  ([PostgreSQL: Check Constraints](https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-CHECK-CONSTRAINTS)),
  e `->>` devolve nulo quando a chave não existe no documento ([PostgreSQL: JSON Functions and
  Operators](https://www.postgresql.org/docs/current/functions-json.html)). Com `=`, um documento
  sem `chave` passaria. `->>` devolve o número do JSON como texto (`'{"b":2}' ->> 'b'` dá `2`), por
  isso a comparação é com `note_number::text`.
- **A checagem `emitida` da #140 continua valendo** sem mudança: a emitida à mão tem
  `nfe_number`, `emitted_by` e `emitted_at` e nenhuma coluna `note_*`; a emitida pelo mock tem tudo.
  Juntas, as duas checagens dizem: documento só em `emitida`, e `emitida` sempre com quem e quando.
- **As duas `unique` aceitam vários nulos**, que é o caso de toda linha pendente, cancelada ou
  emitida à mão: por padrão dois nulos não são iguais numa restrição única ([PostgreSQL: Unique
  Constraints](https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-UNIQUE-CONSTRAINTS)).
- **A checagem do formato do `note_id` usa regex**, não `lpad`: o domínio usa `padStart(4)`, que não
  corta número acima de 9999, e `lpad` cortaria.
- **`on delete cascade`** na reserva: o reset do #56 apaga `outbox_return_notes` e leva as reservas
  junto; a identidade segue contando, então um número nunca volta depois de um reset. O cascade
  roda com o dono da tabela que referencia, não com o papel do chamador, então o reset do #56 segue
  funcionando com `DELETE` e `TRUNCATE` revogados da reserva; o teste T6 prova a recusa do `DELETE`.
- **Nenhum outro `grant`.** As tabelas novas do `public` ficam acessíveis aos papéis da API sem
  grant explícito no padrão do projeto (`supabase/config.toml`, comentário de
  `auto_expose_new_tables`); o RLS sem política fecha a chave pública, como no resto do banco.
- **O `fake-postgrest.ts`** ganha os padrões das colunas novas (`note_*` nulos em
  `outbox_return_notes`; `number` de um contador próprio e `reserved_at` em `return_note_numbers`).
  O fake não aplica restrição nenhuma: ele prova o comportamento do adaptador, e o banco real prova
  as restrições (testes online, abaixo).

## Índices

| Índice | Tabela | Colunas | Serve | Sai sem travar escrita por |
|---|---|---|---|---|
| `outbox_return_notes_pkey` (existe) | `outbox_return_notes` | `id` | Q-E1, Q-E3, e a ordem de Q-P3 | já existe |
| `outbox_return_notes_status_idx` (existe) | `outbox_return_notes` | `status, id` | a fila da #140 | já existe |
| `outbox_return_notes_idempotency_key_key` (existe) | `outbox_return_notes` | `idempotency_key` | Q-P4, árbitro do `on_conflict` | já existe |
| `outbox_return_notes_note_id_key` | `outbox_return_notes` | `note_id` | unicidade do `nota_id` (AC-4) | não sai: ver IDX-4 abaixo |
| `outbox_return_notes_note_access_key_key` | `outbox_return_notes` | `note_access_key` | unicidade da chave emitida (AC-4) | não sai: ver IDX-4 abaixo |
| `return_note_numbers_pkey` | `return_note_numbers` | `number` | unicidade do número | tabela criada na mesma migração: n/a |
| `return_note_numbers_return_note_id_key` | `return_note_numbers` | `return_note_id` | Q-R1, Q-R3; árbitro de Q-R2; o cascade da exclusão da entrada (o banco não indexa sozinho o lado que referencia, [PostgreSQL: Foreign Keys](https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-FK)) | tabela criada na mesma migração: n/a |
| `invoices_pkey` (existe) | `invoices` | `access_key` | Q-E2, Q-P2 | já existe |
| `proposals_state_id_idx` | `proposals` | `state, id` | Q-P1: a leitura das decididas, `state=in.(aprovada,alterada)` | não sai: ver IDX-4 abaixo (ADR-003, b) |

## Transações

O banco só é alcançado pelo PostgREST, e cada requisição é uma transação ([PostgREST:
Transactions](https://docs.postgrest.org/en/stable/references/transactions.html)). Não há
unidade de trabalho com várias escritas; cada caso de uso faz no máximo uma escrita por raiz, e a
ordem das requisições é desenhada para que parar entre duas deixe o banco certo.

| Caso de uso | Transação | Raiz que muda | Escritas dentro | Na falha | Efeito em outra raiz |
|---|---|---|---|---|---|
| `publishApprovedReturnNotes` | Uma por publicação: o `insert` de Q-P4. Q-P1, Q-P2 e Q-P3 são leituras, sem transação além da própria requisição. | uma entrada nova de `outbox_return_notes` por decisão | a linha da entrada, `pendente` | A requisição que falha não grava nada; as publicações anteriores da mesma rodada ficam, e a próxima rodada as pula pela `idempotency_key` única (#59). | nenhum: a entrada é o evento da decisão aprovada |
| `emitReturnNote`, reserva | Q-R2, uma requisição | a reserva (`return_note_numbers`) | uma linha de reserva, ou nada se já existe | Nada gravado, ou a reserva gravada e a resposta perdida: a próxima tentativa a encontra em Q-R1. | nenhum |
| `emitReturnNote`, emissão | Q-E3, uma requisição: o PATCH `id=eq.X&status=eq.pendente` com `status`, `nfe_number`, `emitted_by`, `emitted_at` e as cinco `note_*` | a entrada da fila | a transição e o documento, numa linha, num comando | Restrição violada: o comando inteiro é recusado e a entrada segue `pendente` com a reserva, pronta para outra tentativa. Zero linhas (outra emissão, a #140 à mão ou um cancelamento ganhou): o caso de uso relê e devolve `already_emitted` ou `conflict`. | nenhum nesta entrega; o e-mail (entrega 4) lê a entrada emitida |

Entre a reserva e a emissão a entrada pode ser cancelada ou emitida à mão; a reserva fica sem nota,
que é o buraco aceito acima. A chave de acesso inclui o ano e o mês da emissão; uma nova tentativa
em outro mês gera outra chave com o mesmo número, e só a que o PATCH gravar existe.

## Estratégia de inquilino

Não há inquilino (`strategies.tenancy.strategy: none`). O acesso segue o que está registrado desde
o #59: RLS ligado e nenhuma política em toda tabela, inclusive na nova; só a chave secreta do
Worker lê e grava.

## O que os testes de integração provam

Duas camadas, porque aqui não há Postgres local: o `fake-postgrest.ts` prova o adaptador, e o
`api/test/connectors/online.test.ts` (que pula sem credenciais) prova o banco. Cada teste cita o
critério (`#156/AC-4`).

| Teste | Onde | Prova |
|---|---|---|
| T1 reserva idempotente por `entryId` | fake e online | Reservar duas vezes a mesma entrada devolve o mesmo número e deixa uma linha; duas reservas em paralelo (`Promise.all`) da mesma entrada devolvem o mesmo número e deixam uma linha (online: no banco real a disputa é de verdade); duas entradas ganham números diferentes; a nota gravada tem `note_number` igual à reserva da sua entrada. |
| T2 emissão condicional | fake e online | `markEmitted` numa pendente devolve `true` e grava as nove colunas; a segunda chamada devolve `false` e o documento não muda; numa cancelada devolve `false`; a emissão à mão da #140 depois da emissão pelo mock dá `conflict`; emitir de novo pelo caso de uso não reserva outro número (contagem de linhas em `return_note_numbers` igual). |
| T3 `note_access_key` e `note_id` únicos | online | Um PATCH numa segunda entrada pendente com a mesma chave é recusado pelo banco; o mesmo com o mesmo `nota_id`; a segunda entrada segue `pendente`. |
| T4 restrições de `emitida` | online | Cada recusa traz no detalhe do PostgREST o nome da restrição violada. `outbox_return_notes_note_check` recusa: documento numa linha que fica `pendente` (com `nfe_number` e `emitted_*` nulos); só parte das `note_*`; `note_number` diferente de `nfe_number`; `note_access_key` diferente da `chave` do documento; documento sem a chave `chave`; `nota_referenciada` diferente da nota de origem. `outbox_return_notes_emitida_check` (da #140) recusa documento sem `emitted_by`. Aceito: `emitida` à mão, sem documento (#140). |
| T5 a chave pública não lê `return_note_numbers` | online | Zero linhas ou erro, como o AC-6 do #59 já faz para as outras tabelas (acrescentar a tabela à lista do teste). |
| T6 a reserva não muda | online | Com a chave secreta, um PATCH e um DELETE em `return_note_numbers` são recusados (`SupabaseRestError`); e a reserva (Q-R2 com `ignore-duplicates`) funciona com o `UPDATE` revogado. |

Os testes online gravam no banco do caso e apagam o que gravaram no `afterAll`, como o AC-4 do #59
já faz; apagar a entrada leva a reserva pelo cascade.

## Conferência das regras

| Condição | Cumprida por | Não cumprida, e por quê |
|---|---|---|
| PER-1 | as duas tabelas do desenho estão no registro | O registro é novo: as outras tabelas das migrações ainda não têm modo declarado. Cada uma entra pelo próximo desenho que a tocar. |
| PER-2 | nenhum adaptador faz `UPDATE` ou `DELETE` em `return_note_numbers`; `UPDATE`, `DELETE` e `TRUNCATE` revogados de `anon`, `authenticated` e `service_role`; o T6 prova a recusa do `DELETE` | O cascade da chave estrangeira roda com o dono da tabela da entrada, então o reset do #56 (`api/src/ops/reconferir.ts`) apaga `outbox_return_notes` e leva as reservas sem precisar do `DELETE` do chamador. |
| PER-3, PER-8 | `outbox_return_notes`: a única transição grava quem, quando e o quê na própria linha, num comando | Não é uma das formas da doc (tabela-filha ou coluna JSON de versões); o mantenedor aceitou, e o ADR-003 (a) registra a decisão. Vale só enquanto a máquina de estados tiver uma transição a partir do único estado gravável: o estado antes é sempre o mesmo e não se perde nada. Se a entrada ganhar uma segunda transição (reabrir, corrigir a nota emitida), a história passa a ser uma tabela-filha `(return_note_id, version, at, by, state jsonb)`, e gravar as duas juntas pede RPC. |
| PER-4 | `status` como versão: todo PATCH filtra `status=eq.pendente` (#140 e #156) | A recusa é do filtro de cada adaptador, não do banco: um PATCH sem o filtro passaria. Os dois únicos adaptadores que escrevem na tabela filtram; a revisão confere isso em cada adaptador novo. |
| PER-5 | nenhuma exclusão nos casos de uso | O reset do #56 apaga as tabelas do domínio; é anterior e não é deste desenho. |
| PER-6 | `return_note_numbers` não tem projeção: é lida uma linha pela sua chave | n/a |
| PER-7 | modos escolhidos pela primeira vez | n/a |
| TRX-1, TRX-2 | cada escrita é uma requisição, e cada requisição uma transação; nenhum adaptador abre transação | n/a |
| TRX-3 | reserva e emissão mudam raízes diferentes em transações diferentes; a emissão muda só a entrada | n/a |
| TRX-4 | uma requisição termina em commit ou rollback no próprio PostgREST; a falha entre duas requisições deixa o banco certo (tabela "Transações") | n/a |
| IDX-1 | Q-E1, Q-E2, Q-E3, Q-R1, Q-R2, Q-R3 por chave única ou primária; Q-P1 pelo `proposals_state_id_idx` (`state, id`) | Q-P3 lê a caixa inteira em ordem de `id` a cada rodada do Cron: cresce com a história, e índice nenhum a limita, porque devolve quase a tabela toda. Hoje são 80 notas. Limitar a leitura é do caso de uso, já mergeado no HEAD. Nenhum teste lê plano, porque não há Postgres local. |
| IDX-2 | cada índice novo é de restrição única ou serve Q-R1/Q-R3 | n/a |
| IDX-3 | n/a: banco relacional | n/a |
| IDX-4 | as duas `unique` novas são em colunas nulas em toda linha que já existe | Elas e o `proposals_state_id_idx` são construídos dentro da migração, com trava curta de escrita em tabelas pequenas. `CREATE INDEX CONCURRENTLY` não roda dentro de um bloco de transação ([PostgreSQL: CREATE INDEX](https://www.postgresql.org/docs/current/sql-createindex.html#SQL-CREATEINDEX-CONCURRENTLY)) e a CLI do Supabase roda cada arquivo numa transação. O mantenedor aceitou a trava: ADR-003 (b). |
| MT-1 a MT-5 | n/a: sem inquilino | n/a |

## Fica em aberto

Decididos no ADR-003 (docs/adr/ADR-003-persistencia-da-emissao-da-nota-de-devolucao.md): a trava curta das `unique` e do índice de `proposals` (IDX-4), a história na própria linha (PER-3/PER-8) e a série com buracos.

- **IDX-1 de Q-P3:** a leitura completa da caixa a cada rodada é do
  dono do caso de uso `publishApprovedReturnNotes`.
- **PER-1 das outras tabelas:** `invoices`, `proposals`, `divergences`, `approvals`, `titles`,
  `outbox_dock_actions`, `outbox_store_actions`, `outbox_registry_corrections`, `automation_runs`,
  `exceptions`, as `kit_*` e as demais ainda sem modo declarado no registro.
- **Os nomes das colunas** (`note_*` em inglês, as chaves do documento em português pelo ADR-001)
  são escolha deste desenho; quem preferir os nomes do brief (`nota_id`, `chave`, `serie`) com
  `-- ADR-001` precisa ampliar o ADR-001 para colunas de tabela do domínio.
