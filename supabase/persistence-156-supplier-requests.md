# Desenho de persistência: pedido ao fornecedor (#156, entrega 2)

Issue: barte-ai-services/formacao-fde-solucao-case#156, "Sai 2", AC-1, AC-6 e AC-8, escopo E1/E2/E3
receber parcial com `request_type` `return_note`. Banco: PostgreSQL 17 no Supabase hospedado
(`supabase/config.toml`, `[db] major_version = 17`), alcançado pelo Worker só pelo PostgREST.
Registro: `supabase/persistence-modes.yaml`. Decisões: `docs/adr/ADR-005-supplier-request-persistence.md`.
Migração a criar: `supabase/migrations/20261116120000_supplier_requests.sql` (depois de
`20261116110000`, a última da base).

Este desenho não escreve migração, adaptador nem teste: é o que a camada OLTP escreve e o que a
revisão cobra dela. As entregas 3 a 5 (enviar, descartar, reenviar, anexo PDF) gravam nas mesmas
tabelas; a linha e a história já nascem para essas transições.

## Entradas

| Entrada | Valor | Fonte |
|---|---|---|
| Agregados e raízes | O pedido ao fornecedor (`SupplierRequest`, raiz, em `outbox_supplier_emails`), com `Ask` como valor; o contato do fornecedor (consulta, em `supplier_contacts`). `Invoice`, `Proposal`, a entrada da fila de devolução e a sugestão do Claude só são lidos. | `api/src/domain/supplier-request.ts` (PR #5), `api/src/returns/supplier-request-ports.ts` (PR #6) |
| Regra do pedido aberto | `isOpenRequest`: aberto é todo status menos `discarded`; `send_failed` é aberto, porque o reenvio é o mesmo pedido. O brief dizia `draft` e `sent`; vale o domínio (ADR-005, b). | domínio, commit b5fd790 |
| Consultas da entrega 2 | Q-C1 `emailOf`: `supplier_contacts?supplier_id=eq.X`. Q-S1 `listFor`: `outbox_supplier_emails?invoice_access_key=in.(...)`, qualquer tipo e status. Q-S2 `save`: `insert` simples, sem `on_conflict`. Q-V1 `valuesOf`: `outbox_return_notes?invoice_access_key=in.(...)&status=neq.cancelada`. Q-G1 `listOk`: `claude_suggestions?task=eq.supplier-request&status=eq.ok`. `listDecided` é o da entrega 1 (`proposals_state_id_idx`). | casos de uso `pending-supplier-requests.ts` e `draft-supplier-requests.ts` |
| Consultas das entregas 3 e 4 | Q-S3 o pedido por `id`. Q-S4 o PATCH condicional `id=eq.X&status=eq.draft&version=eq.N` (enviar, descartar, editar) ou `status=eq.send_failed` (reenviar). Q-S5 o pedido de uma nota, `invoice_access_key=eq.K&order=id.desc`; o de uma proposta passa pela `invoice_access_key` dela (`proposals` por `id`). Q-H1 a história de um pedido em ordem de versão. | brief |
| Inquilino | nenhum | `strategies.tenancy: none` |
| Números assumidos | 12 fornecedores no kit (F01..F12). Pedidos: no máximo um aberto por nota de origem e tipo; o caso trabalha com 80 notas. Edições por rascunho (AC-7) e reenvios: não informado, sem teto. Taxa: uma rodada do Cron e cliques de uma pessoa. | `data/kit/fornecedores.json`, #156 |

## Nomes das colunas

Os campos da Sai 2 viram colunas em inglês (ADR-001, "o que o repositório inventa"), sem literal do
modelo em português, então nenhuma linha leva `-- ADR-002`.

| Campo da Sai 2 | Coluna | Por quê |
|---|---|---|
| `to` | `to_address text` | `TO` é palavra reservada no PostgreSQL, "not allowed as column or table names" sem aspas ([PostgreSQL: SQL Key Words, Table C.1](https://www.postgresql.org/docs/17/sql-keywords-appendix.html)); a coluna entre aspas obrigaria toda consulta e todo `select=` a citá-la. |
| `asks[]` | `asks jsonb` | lista de objetos `{"kind", "supplier_code"}` (`supplier_code` nulo no pedido sobre a nota toda); o adaptador mapeia `supplierCode`. |
| `attachments[]` | `attachments jsonb`, padrão `[]` | vazio no rascunho: a nota de devolução só é emitida no "Emitir e enviar" (AC-3). A forma do item é da entrega 5 (fica em aberto). |
| `status` com o motivo | `status text`, `reason text` | `reason` é o código fechado do descarte (`DiscardReason`) ou a classe curta da falha de envio; nunca texto do Claude. |
| quem fez a última escrita | `changed_by text`, `changed_at timestamptz` | o "quem e quando" de cada versão, copiado pelo gatilho para a história. No rascunho do Cron, `changed_by = 'cron:supplier-request'`; numa ação da pessoa, a identidade que o token dá, como `emitted_by` na entrega 1. |
| os demais | `invoice_access_key`, `supplier_id`, `request_type`, `subject`, `body`, `due_on`, `channel`, `model`, `drafted_at`, `sent_by`, `sent_at`, `provider_message_id` | os nomes da Sai 2 |

## Tabelas

| Tabela | Modo | Por quê: fato ou entidade editada | História: forma e lugar | Versão | Inquilino |
|---|---|---|---|---|---|
| `supplier_contacts` (nova) | append-only, `growth: fixed` | Cadastro de consulta que só as migrações gravam; o Worker só lê. | nenhuma; `INSERT`, `UPDATE`, `DELETE` e `TRUNCATE` revogados dos papéis da API | n/a | nenhum |
| `outbox_supplier_emails` (nova) | upsert-with-history | Entidade que a pessoa edita (o texto do rascunho, AC-7) e que faz várias transições (`draft` → `sent`, `send_failed`, `discarded`; `send_failed` → `sent`). | Tabela-filha `outbox_supplier_email_history (supplier_email_id, version, changed_at, changed_by, state jsonb)`, gravada por gatilho no mesmo comando (ADR-005, a) | `version`, guardada pelo gatilho | nenhum |
| `outbox_supplier_email_history` (nova) | append-only | Cada linha é o fato "a versão N do pedido ficou assim, por quem, quando". | nenhuma; `UPDATE`, `DELETE` e `TRUNCATE` revogados | n/a | nenhum |
| `outbox_return_notes` (existe) | upsert-with-history (entrega 1) | só ganha um índice | sem mudança | sem mudança | nenhum |

### `supplier_contacts`: tabela própria, semente na migração

- **Tabela própria**, como a pessoa prefere: `kit_fornecedores` copia `data/kit/fornecedores.json`
  e é carregada pelo `scripts/load_kit.py` a partir do `contrato.json`; uma coluna nova ali mudaria o
  contrato do kit.
- **A semente é a própria migração**, como `exceptions` (#128, `20261115220000_exceptions_reference.sql`),
  que "não depende de `kit_excecoes` já estar carregada". Não há `supabase/seed.sql`, e o seed da CLI
  roda "the first time you run `supabase start` and every time you run `supabase db reset`"
  ([Supabase: Seeding your database](https://supabase.com/docs/guides/local-development/seeding-your-database));
  a página não diz que o `db push --remote` do `supabase-base-do-kit.yml` o rode. O `load_kit.py`
  carrega só as `kit_*` do contrato. O reset do #56 (`api/src/ops/reconferir.ts`) não toca a tabela:
  ela não é do domínio da conferência.
- **Sem chave estrangeira para `kit_fornecedores`**: o workflow aplica as migrações antes de rodar o
  `load_kit.py`, então num projeto novo a semente entraria com `kit_fornecedores` vazia e a chave a
  recusaria. A checagem `^F[0-9]{2}$` e o teste offline (os ids da semente são os de
  `fornecedores.json`) fazem o papel da chave.
- **E-mails `fiscal.fNN@fornecedores.test`**, sem nome de empresa nem de pessoa: `.test` é o domínio
  "recommended for use in testing" ([RFC 2606, seção 2](https://www.rfc-editor.org/rfc/rfc2606.html)),
  então o Resend da entrega 4 nunca entrega a alguém de verdade.
- **Append-only com `growth: fixed`**: trocar um e-mail é uma migração. Uma tela que edite o contato
  muda o modo para upsert-with-history, num ADR que supera o ADR-005 (d).

### `outbox_supplier_emails`: por que a história é uma tabela-filha gravada por gatilho

A forma da entrega 1 (`in-row-transition`, ADR-003 a) não serve: ela vale "só enquanto a máquina de
estados tiver uma transição a partir do único estado gravável", e aqui há edição do rascunho,
três saídas do `draft` e o reenvio do `send_failed`. O ADR-003 já previu o passo seguinte: "a
história passa a uma tabela-filha `(return_note_id, version, at, by, state jsonb)`, e gravar as duas
juntas pede uma RPC; isso é um novo ADR". O ADR-005 (a) é esse ADR, e troca a RPC por um gatilho:

- **Mesma transação, sem mudar a unidade de trabalho.** Um gatilho `after insert or update ... for
  each row` roda dentro do comando que o dispara; o PostgreSQL mostra esse uso no exemplo 41.4, uma
  auditoria que grava `NEW.*` em outra tabela a cada `INSERT` e `UPDATE` ([PostgreSQL: Trigger
  Functions](https://www.postgresql.org/docs/17/plpgsql-trigger.html)). O `POST` e o `PATCH` do
  PostgREST continuam sendo uma requisição e uma transação ([PostgREST: Transactions](https://docs.postgrest.org/en/stable/references/transactions.html)),
  então `strategies.unit_of_work` fica como está.
- **Nenhum adaptador grava a história**, então nenhum a esquece. O adaptador só diz `changed_by` em
  toda escrita.
- **A versão é guardada pelo banco.** O gatilho `before` exige `version = 1` no `INSERT` e
  `new.version = old.version + 1` no `UPDATE`; erguer um erro num gatilho "abort[s] the entire
  operation" (mesma página). O adaptador filtra `version=eq.N` e grava `version: N+1`: zero linhas é
  versão velha; um PATCH sem o filtro, com outra versão, é recusado pelo gatilho.
- **Tabela-filha, não coluna `jsonb` na linha**: a doc aceita a coluna "when the history is short",
  e as edições do AC-7 não têm teto; e a filha é append-only com a recusa por grant, que um PATCH na
  entidade não reescreve.

O gatilho `before` também guarda o que o domínio promete e uma escrita direta no banco quebraria:

| De | Para | Aceito |
|---|---|---|
| (insert) | `draft`, `discarded` | sim, na versão 1 |
| `draft` | `draft` (edição do texto), `sent`, `send_failed`, `discarded` | sim |
| `send_failed` | `send_failed` (falhou de novo), `sent` | sim |
| `send_failed` | `discarded` | não nesta entrega (o wireframe só oferece "Tentar enviar de novo"); fica em aberto |
| `sent`, `discarded` | qualquer | não: terminais. "Refazer" grava uma linha nova (o índice parcial deixa) |

E recusa mudar `invoice_access_key`, `supplier_id`, `request_type`, `to_address`, `asks`, `due_on`,
`model` e `drafted_at` (o AC-7: a lista do que pedimos não se edita), e mudar `subject` ou `body`
fora do `draft`. Os números dentro do corpo editado são do domínio (entrega 3): o banco não os lê.

### `due_on`: sem padrão

`due_on date not null`, sem `default`. O prazo é o que o `input` da sugestão deu ao Claude
(`dueOnOfInput`, commit d6b8782), em dias úteis de Brasília; um padrão do banco calcularia outra data
(o dia do `INSERT`, outro fuso, sem a regra de dias úteis) e esconderia um adaptador que esqueceu a
coluna, gravando um prazo diferente do que o e-mail cita. Sem padrão, esse esquecimento é um
`not null` recusado.

## A migração `20261116120000_supplier_requests.sql`

Colunas, restrições, gatilhos e grants exatos. Os comentários seguem o padrão (`-- #156 ...`).

```sql
-- #156 O pedido ao fornecedor (Sai 2): o contato do fornecedor, a caixa de saída dos e-mails e a sua história.
-- #156 RLS segue ligado e sem política (AC-6 do #59): só o Worker lê e grava. Decisões em ADR-005.

-- #156 O e-mail de contato de cada fornecedor do kit, fora de kit_fornecedores. Esta migração é a fonte e não
-- #156 depende de kit_fornecedores já estar carregada (como exceptions, #128). Só as migrações gravam (ADR-005, d).
create table public.supplier_contacts (
  supplier_id text not null,
  email text not null,
  constraint supplier_contacts_pkey primary key (supplier_id),
  constraint supplier_contacts_supplier_id_check check (supplier_id ~ '^F[0-9]{2}$'),
  constraint supplier_contacts_email_check check (email ~ '^[^@[:space:]]+@[^@[:space:]]+$')
);
alter table public.supplier_contacts enable row level security;

insert into public.supplier_contacts (supplier_id, email) values
  ('F01', 'fiscal.f01@fornecedores.test'),
  ('F02', 'fiscal.f02@fornecedores.test'),
  ('F03', 'fiscal.f03@fornecedores.test'),
  ('F04', 'fiscal.f04@fornecedores.test'),
  ('F05', 'fiscal.f05@fornecedores.test'),
  ('F06', 'fiscal.f06@fornecedores.test'),
  ('F07', 'fiscal.f07@fornecedores.test'),
  ('F08', 'fiscal.f08@fornecedores.test'),
  ('F09', 'fiscal.f09@fornecedores.test'),
  ('F10', 'fiscal.f10@fornecedores.test'),
  ('F11', 'fiscal.f11@fornecedores.test'),
  ('F12', 'fiscal.f12@fornecedores.test');

revoke insert, update, delete, truncate on public.supplier_contacts from anon, authenticated, service_role;

-- #156 O pedido ao fornecedor: nasce draft ou discarded no rascunho; a pessoa edita, envia, descarta e reenvia.
-- #156 Upsert com história: a versão e a história são do gatilho, no mesmo comando (ADR-005, a).
create table public.outbox_supplier_emails (
  id bigint generated always as identity,
  invoice_access_key text not null,
  supplier_id text not null,
  request_type text not null,
  to_address text not null,
  subject text,
  body text,
  asks jsonb not null,
  attachments jsonb not null default '[]'::jsonb,
  due_on date not null,
  status text not null,
  reason text,
  channel text not null,
  model text not null,
  drafted_at timestamptz not null,
  sent_by text,
  sent_at timestamptz,
  provider_message_id text,
  version integer not null default 1,
  changed_by text not null,
  changed_at timestamptz not null default now(),
  constraint outbox_supplier_emails_pkey primary key (id),
  constraint outbox_supplier_emails_invoice_fkey foreign key (invoice_access_key)
    references public.invoices (access_key) on delete cascade,
  -- #156 Só o tipo desta entrega; os outros tipos da história entram ampliando a checagem.
  constraint outbox_supplier_emails_request_type_check check (request_type in ('return_note')),
  constraint outbox_supplier_emails_status_check check (status in ('draft', 'sent', 'discarded', 'send_failed')),
  constraint outbox_supplier_emails_channel_check check (channel in ('mock', 'resend')),
  -- #156 Só o descartado no rascunho fica sem assunto e corpo; o descartado pela pessoa os mantém.
  constraint outbox_supplier_emails_text_check check (status = 'discarded' or (subject is not null and body is not null)),
  constraint outbox_supplier_emails_text_blank_check check (btrim(subject) <> '' and btrim(body) <> ''),
  constraint outbox_supplier_emails_reason_check check ((status in ('discarded', 'send_failed')) = (reason is not null)),
  constraint outbox_supplier_emails_reason_length_check check (char_length(reason) between 1 and 300),
  constraint outbox_supplier_emails_sent_check check ((status = 'sent') = (sent_by is not null and sent_at is not null)),
  constraint outbox_supplier_emails_provider_check check (
    (provider_message_id is null or status = 'sent')
    and (status <> 'sent' or channel <> 'resend' or provider_message_id is not null)
  ),
  constraint outbox_supplier_emails_asks_check check (
    case when jsonb_typeof(asks) = 'array' then jsonb_array_length(asks) > 0 else false end
  ),
  constraint outbox_supplier_emails_attachments_check check (jsonb_typeof(attachments) = 'array'),
  constraint outbox_supplier_emails_to_address_check check (to_address ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  constraint outbox_supplier_emails_version_check check (version >= 1)
);
alter table public.outbox_supplier_emails enable row level security;

-- #156/AC-8 Um pedido aberto por nota de origem e tipo. Aberto é todo status menos discarded, como isOpenRequest
-- #156 do domínio: send_failed é aberto, porque o reenvio é o mesmo pedido (ADR-005, b).
create unique index outbox_supplier_emails_open_request_key
  on public.outbox_supplier_emails (invoice_access_key, request_type)
  where status <> 'discarded';

-- #156 Serve listFor (invoice_access_key=in.(...)), o pedido de uma nota em ordem de id e o cascade da nota.
create index outbox_supplier_emails_invoice_access_key_idx
  on public.outbox_supplier_emails (invoice_access_key, id);

-- #156 A história do pedido: uma linha por escrita, com o estado inteiro depois dela. Só o gatilho grava.
create table public.outbox_supplier_email_history (
  supplier_email_id bigint not null,
  version integer not null,
  changed_at timestamptz not null,
  changed_by text not null,
  state jsonb not null,
  constraint outbox_supplier_email_history_pkey primary key (supplier_email_id, version),
  constraint outbox_supplier_email_history_email_fkey foreign key (supplier_email_id)
    references public.outbox_supplier_emails (id) on delete cascade
);
alter table public.outbox_supplier_email_history enable row level security;
-- #156 Append-only: a história não muda e não se apaga. O cascade do reset do #56 roda como o dono (ADR-003).
revoke update, delete, truncate on public.outbox_supplier_email_history from anon, authenticated, service_role;

-- #156 Antes de gravar: a versão, as transições, os campos imutáveis e o texto só no rascunho (ADR-005, a).
create function public.outbox_supplier_emails_guard() returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.version <> 1 or new.status not in ('draft', 'discarded') then
      raise exception 'outbox_supplier_emails: um pedido nasce draft ou discarded, na versão 1';
    end if;
  else
    if new.version <> old.version + 1 then
      raise exception 'outbox_supplier_emails: versão % recusada, a gravada é %', new.version, old.version;
    end if;
    if not ((old.status = 'draft' and new.status in ('draft', 'sent', 'send_failed', 'discarded'))
         or (old.status = 'send_failed' and new.status in ('send_failed', 'sent'))) then
      raise exception 'outbox_supplier_emails: transição % para % recusada', old.status, new.status;
    end if;
    if (new.invoice_access_key, new.supplier_id, new.request_type, new.to_address, new.asks, new.due_on,
        new.model, new.drafted_at)
       is distinct from
       (old.invoice_access_key, old.supplier_id, old.request_type, old.to_address, old.asks, old.due_on,
        old.model, old.drafted_at) then
      raise exception 'outbox_supplier_emails: nota, fornecedor, tipo, destinatário, pedidos, prazo e modelo não mudam';
    end if;
    if old.status <> 'draft' and (new.subject, new.body) is distinct from (old.subject, old.body) then
      raise exception 'outbox_supplier_emails: o texto só muda no rascunho';
    end if;
  end if;
  new.changed_at := now();
  return new;
end;
$$;

-- #156 Depois de gravar: a versão nova vai para a história, no mesmo comando.
create function public.outbox_supplier_emails_history() returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  insert into public.outbox_supplier_email_history (supplier_email_id, version, changed_at, changed_by, state)
  values (new.id, new.version, new.changed_at, new.changed_by, to_jsonb(new));
  return null;
end;
$$;

create trigger outbox_supplier_emails_guard
  before insert or update on public.outbox_supplier_emails
  for each row execute function public.outbox_supplier_emails_guard();

create trigger outbox_supplier_emails_history
  after insert or update on public.outbox_supplier_emails
  for each row execute function public.outbox_supplier_emails_history();

-- #156 Serve ReturnQueueValues.valuesOf, `invoice_access_key=in.(...)&status=neq.cancelada`.
-- #156 Índice simples, sem concurrently, com trava curta numa tabela pequena (ADR-005, c).
create index outbox_return_notes_invoice_access_key_idx on public.outbox_return_notes (invoice_access_key);
```

Notas para quem escreve:

- **As checagens com coluna nula passam**, como na entrega 1 ([PostgreSQL: Check Constraints](https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-CHECK-CONSTRAINTS)):
  `text_blank_check` e `reason_length_check` só valem quando há texto; `text_check` e
  `reason_check` dizem quando ele é obrigatório.
- **`asks_check` usa `case`** para não chamar `jsonb_array_length` num valor que não é lista.
- **O erro do gatilho** é um `raise exception` sem código, `P0001`, que o PostgREST devolve como
  HTTP 400 ("P0001 | 400 | default code for 'raise'", [PostgREST: Errors](https://docs.postgrest.org/en/stable/references/errors.html));
  uma checagem violada (`23514`) também cai no 400. O adaptador trata os dois como erro, nunca como
  `refused`.
- **`on delete cascade` nas duas chaves**: o reset do #56 apaga `invoices` primeiro e leva os pedidos
  e a história junto, com o `DELETE` revogado da história (o cascade roda como o dono, ADR-003). A
  lista `DOMAIN_TABLES` não muda. O gatilho não dispara no `DELETE`.
- **O `fake-postgrest.ts`** ganha: os padrões de `outbox_supplier_emails` (`id`, `attachments: []`,
  `version: 1`, `changed_at`); o filtro `neq.`; e, para esta tabela, a recusa da segunda linha aberta
  com `(invoice_access_key, request_type)` igual, devolvendo 409 com
  `{"code":"23505","message":"... \"outbox_supplier_emails_open_request_key\""}`. O fake não imita o
  gatilho, a história nem as checagens: seria uma segunda implementação do banco. Ele prova o
  mapeamento do adaptador; o banco real prova o resto (testes online, abaixo).

## Como `save` detecta `refused` pelo PostgREST

`save` é um `POST /outbox_supplier_emails` simples: `rest.insert(table, [row], { ignoreDuplicates: false })`,
sem `on_conflict`, com `Prefer: return=representation`.

- **Nem `on_conflict` nem `ignore-duplicates`.** Sem `on_conflict` o PostgREST usa a chave primária
  ("By default, upsert operates based on the primary key columns", [PostgREST: Tables and Views](https://docs.postgrest.org/en/stable/references/api/tables_views.html)),
  e o conflito que importa é o do índice parcial. Com `on_conflict=invoice_access_key,request_type`,
  o PostgreSQL só infere um índice parcial com o predicado: "`index_predicate`: Used to allow
  inference of partial unique indexes", e "If an attempt at inference is unsuccessful, an error is
  raised" ([PostgreSQL: INSERT](https://www.postgresql.org/docs/17/sql-insert.html)); a página do
  PostgREST não documenta como mandar o predicado. E o `insert` do cliente usa `ignoreDuplicates`
  `true` por padrão: o adaptador tem de passar `false`.
- **A recusa**: o índice parcial impõe a unicidade "among the rows that satisfy the index predicate,
  without constraining those that do not" ([PostgreSQL: Partial Indexes, exemplo 11.3](https://www.postgresql.org/docs/17/indexes-partial.html)),
  e a violação `23505` sai como HTTP 409 ("23505 | 409 | uniqueness violation", [PostgREST: Errors](https://docs.postgrest.org/en/stable/references/errors.html)).
- **O 409 não basta**: `23503`, a chave estrangeira (nota de origem que não existe), também é 409
  ("23503 | 409 | foreign key violation", mesma página). Então `refused` é: status 409, `code`
  `23505` e o nome `outbox_supplier_emails_open_request_key` na mensagem. Qualquer outro erro é
  lançado. O corpo tem `code`, `details`, `hint` e `message`, mas a ordem dos campos varia entre os
  exemplos da página: o adaptador lê o JSON, não a posição. O `SupabaseRestError.detail` corta o
  corpo em 300 caracteres (`MAX_DETAIL`); se o JSON vier cortado, o adaptador lança (falha fechada).
  Melhor: o conector passar a guardar `code` e `message` já lidos no erro, e o adaptador ler esses
  campos. A escolha é de quem escreve o adaptador.
- **Um `discarded` nunca é recusado**: o índice não o inclui. Gravar um descarte ao lado de um pedido
  aberto é permitido pelo AC-8 (o descarte não é aberto); o caso de uso já pula a nota que tem pedido
  (`listFor`), então isso só acontece numa disputa entre duas rodadas.

## Índices

| Índice | Tabela | Colunas | Serve | Sai sem travar escrita por |
|---|---|---|---|---|
| `supplier_contacts_pkey` | `supplier_contacts` | `supplier_id` | Q-C1 | tabela criada na mesma migração: n/a |
| `outbox_supplier_emails_pkey` | `outbox_supplier_emails` | `id` | Q-S3, Q-S4 | tabela criada na mesma migração: n/a |
| `outbox_supplier_emails_open_request_key` | `outbox_supplier_emails` | `(invoice_access_key, request_type) where status <> 'discarded'`, único | AC-8, árbitro de Q-S2 | tabela criada na mesma migração: n/a |
| `outbox_supplier_emails_invoice_access_key_idx` | `outbox_supplier_emails` | `invoice_access_key, id` | Q-S1 (qualquer status: o índice parcial não serve, porque um índice parcial só é usado quando o `WHERE` da consulta implica o predicado, [Partial Indexes](https://www.postgresql.org/docs/17/indexes-partial.html)); Q-S5 em ordem de `id`; o cascade da exclusão da nota (o banco não indexa sozinho o lado que referencia, [Foreign Keys](https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-FK)) | tabela criada na mesma migração: n/a |
| `outbox_supplier_email_history_pkey` | `outbox_supplier_email_history` | `supplier_email_id, version` | Q-H1; unicidade da versão; o cascade da exclusão do pedido | tabela criada na mesma migração: n/a |
| `outbox_return_notes_invoice_access_key_idx` | `outbox_return_notes` | `invoice_access_key` | Q-V1 | não sai: trava curta dentro da migração (ADR-005, c), como o ADR-003 (b) |
| `claude_suggestions_task_input_key_key` (existe) | `claude_suggestions` | `task, input_key` | Q-G1 pela coluna `task`, a igualdade que lidera; `status=eq.ok` é filtro sobre essas linhas | já existe |
| `proposals_state_id_idx` (entrega 1) | `proposals` | `state, id` | `listDecided` | já existe |

## Transações

O banco só é alcançado pelo PostgREST, e cada requisição é uma transação. Cada escrita deste desenho
é um comando, e a história vai no mesmo comando pelo gatilho.

| Caso de uso | Transação | Raiz que muda | Escritas dentro | Na falha | Efeito em outra raiz |
|---|---|---|---|---|---|
| `pendingSupplierRequests` (entrega 2) | nenhuma: só leituras (`listDecided`, Q-S1, Q-V1, Q-C1), cada uma na sua requisição | nenhuma | nenhuma | uma leitura que falha derruba a rodada sem gravar nada | nenhum. As leituras não são uma foto só: uma nota pedida no meio da rodada vira uma pergunta a mais ao Claude, e a `unique (task, input_key)` de `claude_suggestions` a torna idempotente |
| `draftSupplierRequests` (entrega 2) | uma por sugestão: o `POST` de Q-S2 | um pedido novo | a linha `draft` ou `discarded` na versão 1, e a história v1 pelo gatilho | 409/`23505` no índice parcial: nada gravado, `refused`, a rodada segue. Qualquer outro erro: nada gravado dessa sugestão, o erro sobe; os pedidos já gravados na rodada ficam, e a rodada seguinte os pula por Q-S1 | nenhum: o pedido é ele mesmo a caixa de saída |
| editar o texto (entrega 3, AC-7) | o PATCH de Q-S4 com `status=eq.draft&version=eq.N`, `subject`, `body`, `version: N+1`, `changed_by` | o pedido | a linha e a história vN+1 | zero linhas: outro clique mudou o pedido; o caso de uso relê e devolve conflito. Erro do gatilho: nada gravado | nenhum |
| descartar (entrega 3) | o PATCH de Q-S4 para `discarded`, com `reason` (código fechado do descarte pela pessoa) | o pedido | a linha e a história | como acima | nenhum. "Refazer" é um `POST` novo, nunca reabre o descartado |
| enviar e reenviar (entregas 4 e 5) | duas requisições, em ordem: a emissão da entrega 1 (`outbox_return_notes`, idempotente pelo AC-4) e depois o PATCH do pedido para `sent` ou `send_failed`, com `attachments`, `channel`, `sent_by`, `sent_at`, `provider_message_id` | primeiro a entrada da fila, depois o pedido: duas raízes, duas transações | uma em cada | parar entre as duas deixa a nota emitida e o pedido em `draft`; a nova tentativa acha a nota já emitida e só grava o pedido. O envio pelo Resend fica entre o provedor e o PATCH: ver "Fica em aberto" | a entrada da fila é lida, não mudada, pelo pedido |

## Estratégia de inquilino

Não há inquilino (`strategies.tenancy.strategy: none`). O acesso segue o registrado desde o #59: RLS
ligado e nenhuma política nas três tabelas novas; só a chave secreta do Worker lê e grava.

## O que a raia OLTP sem Postgres local prova, e o que não prova

A raia da entrega 1 é o `FakePostgrest` mais a conferência offline do texto da migração. Ela prova o
adaptador: os filtros e o corpo de cada requisição, o mapeamento entre a linha e o domínio, e como o
adaptador lê um 409 com `23505` (que o fake devolve porque foi ensinado a devolver).

Ela **não prova**: que o índice parcial recusa a segunda linha aberta e deixa a nova depois do
descarte; o corpo real do 409 (`code`, nome do índice, cabe nos 300 caracteres); que o gatilho grava
a história, sobe e guarda a versão, recusa transições e campos imutáveis; as checagens; as recusas por
grant; o cascade do reset sem `DELETE` na história; a disputa de duas gravações juntas; e os planos
(IDX-1). O desenho lida com isso em três frentes:

1. **O banco guarda o que importa**, não o adaptador: o índice parcial (AC-8), o gatilho (história e
   versão) e as checagens. O que o fake não imita fica num lugar que o teste online alcança.
2. **Testes online** em `api/test/connectors/supplier-request-online.test.ts` (ADR-004), que pulam sem
   credenciais, como `return-note-emission-online.test.ts`. Cada teste cita o critério.
3. **Testes offline** do texto em `api/test/returns/supplier-request-migration.test.ts`, como
   `return-note-migration.test.ts`, mais um que amarra o domínio ao SQL.

| Teste | Onde | Prova |
|---|---|---|
| T1 o pedido aberto (`#156/AC-8`) | online | Um `draft` para a nota K entra; um segundo `draft` de K volta 409 com `code` `23505` e o nome do índice, e `save` dá `refused`; dois `save` de K em paralelo (`Promise.all`) dão um `inserted` e um `refused`; um `send_failed` de K também barra um novo `draft`; depois de descartar o aberto, um `draft` novo de K entra; um `discarded` entra ao lado de um aberto. |
| T2 o 409 que não é recusa | online | `save` com uma `invoice_access_key` que não está em `invoices` lança (409 com `23503`), não devolve `refused`. |
| T3 história (PER-3) | online | Depois do `POST`, uma linha de história v1 com `state` igual à linha; depois de dois PATCH, três linhas, versões 1 a 3, `changed_by` de cada escrita, e a última `state` igual à linha. |
| T4 versão (PER-4) | online | Um PATCH com `version=eq.1` num pedido na versão 2 atinge zero linhas; um PATCH sem filtro de versão gravando `version: 5` volta 400 (`P0001`). |
| T5 transições e imutáveis | online | São recusados: `sent` → `draft`; `discarded` → `draft`; mudar `asks` ou `due_on` num `draft`; mudar `body` num `send_failed`; inserir em `sent`; `draft` sem `body`; `discarded` sem `reason`; `sent` sem `sent_by`; `resend` enviado sem `provider_message_id`. Aceitos: `draft` → `send_failed` → `sent`; `draft` editado duas vezes. |
| T6 grants e chave pública | online | Com a chave secreta: `PATCH` e `DELETE` em `outbox_supplier_email_history` e `INSERT`, `PATCH` e `DELETE` em `supplier_contacts` são recusados. A chave pública lê zero linhas (ou erro) nas três tabelas novas (acrescentar à lista do AC-6 do #59). |
| T7 cascade | online | O `afterAll` apaga a nota de teste em `invoices` e confere que o pedido e a sua história sumiram, com o `DELETE` revogado da história. |
| T8 a semente | offline e online | Offline: os ids do `insert` da migração são exatamente os de `data/kit/fornecedores.json`, e todo e-mail termina em `.test`. Online: `emailOf` de cada F01..F12 devolve um e-mail, e de um id fora do kit devolve `null`. |
| T9 o domínio e o SQL dizem o mesmo | offline | O predicado do índice é `where status <> 'discarded'`; a lista da `status_check` é a de `SupplierRequestStatus`; e, para cada status, `isOpenRequest(s)` é `s !== 'discarded'`. A migração cita `ADR-005`; o registro traz as três tabelas; o ADR-005 existe com as seções. |
| T10 o adaptador (fake) | fake | `save` de um `draft` e de um `discarded` manda as colunas certas (`subject` e `body` nulos no descarte, `reason` só nele, `changed_by = 'cron:supplier-request'`, sem `version`) e devolve `inserted`; o 409 com `23505` e o nome do índice vira `refused`; o 409 com `23503` e o corpo que não é JSON lançam; `listFor`, `valuesOf` (com `neq.cancelada`), `emailOf` e `listOk` mandam os filtros de Q-S1, Q-V1, Q-C1 e Q-G1. |

Os planos (IDX-1) ficam sem teste, como na entrega 1: não há Postgres local, e com 80 notas o
planejador pode preferir ler a tabela inteira. Cada consulta tem o índice cuja coluna líder é a sua
igualdade, na tabela acima.

## Conferência das regras

| Condição | Cumprida por | Não cumprida, e por quê |
|---|---|---|
| PER-1 | as três tabelas novas estão no registro; `outbox_return_notes` ganhou o índice na sua entrada | As outras tabelas das migrações seguem sem modo declarado (como na entrega 1); `claude_suggestions` é lida aqui e não entra, porque este desenho não grava nela. |
| PER-2 | nenhum adaptador escreve na história; `UPDATE`, `DELETE` e `TRUNCATE` revogados da história e, mais `INSERT`, de `supplier_contacts`; T6 | O cascade da exclusão roda como o dono (reset do #56), como na entrega 1. |
| PER-3 | o gatilho `after insert or update` grava `(supplier_email_id, version, changed_at, changed_by, state)` com o estado inteiro depois, no mesmo comando; T3 | `changed_by` é dito pelo adaptador em cada escrita: um PATCH que não o mande herda o da escrita anterior, e a história atribui a pessoa errada. O banco não sabe se a coluna veio no `SET`; a revisão confere cada adaptador, e T3 confere a atribuição. |
| PER-4 | `version`, guardada pelo gatilho `before`; T4 | n/a |
| PER-5 | o descarte é status `discarded`, com quem e quando na história; "Refazer" grava linha nova | O reset do #56 apaga as tabelas do domínio, e o cascade leva os pedidos; é anterior e não é deste desenho. |
| PER-6 | a história não é projeção: o estado atual é a linha, gravada no mesmo comando; `supplier_contacts` é `growth: fixed` | n/a |
| PER-7 | modos escolhidos pela primeira vez; `outbox_return_notes` não muda de modo | n/a |
| PER-8 | `json-child-table`, a forma da doc para PostgreSQL | O escritor da história é um gatilho, não a unidade de trabalho: ADR-005 (a). |
| TRX-1, TRX-2 | cada escrita é um comando numa requisição, com a história dentro; nenhum adaptador abre transação | n/a |
| TRX-3 | cada transação muda um pedido; o envio muda a entrada da fila e o pedido em duas requisições, em ordem idempotente | n/a |
| TRX-4 | uma requisição termina em commit ou rollback no PostgREST; o erro do gatilho e a checagem desfazem o comando inteiro, história junto | n/a |
| IDX-1 | Q-C1, Q-S1, Q-S3, Q-S4, Q-S5, Q-H1, Q-V1 e Q-G1 têm índice com a igualdade na frente | Nenhum teste lê plano, porque não há Postgres local. Q-G1 filtra `status` depois de `task`; com poucas sugestões por tarefa, não pede índice próprio. |
| IDX-2 | cada índice novo é único, de chave, ou serve uma consulta nomeada | n/a |
| IDX-3 | n/a: banco relacional | n/a |
| IDX-4 | os índices das tabelas novas nascem com elas | `outbox_return_notes_invoice_access_key_idx` é construído dentro da migração, com trava curta, numa tabela que já tem linhas: a CLI roda cada arquivo numa transação e `CONCURRENTLY` não roda numa ([PostgreSQL: CREATE INDEX](https://www.postgresql.org/docs/current/sql-createindex.html#SQL-CREATEINDEX-CONCURRENTLY)). Registrado no ADR-005 (c), como o ADR-003 (b). |
| MT-1 a MT-5 | n/a: sem inquilino | n/a |

## Fica em aberto

Decididos no ADR-005 (`docs/adr/ADR-005-supplier-request-persistence.md`): a história por gatilho
em tabela-filha (a), o pedido aberto com `send_failed` e a recusa pelo 409/`23505` (b), a trava curta
do índice de `outbox_return_notes` (c) e `supplier_contacts` como tabela própria semeada pela
migração (d).

- **`send_failed` → `discarded`**: o gatilho recusa nesta entrega. Se a entrega 4 quiser descartar um
  envio falho, amplia a função do gatilho. Responde: a pessoa dona da história, na entrega 4.
- **Envio pelo Resend sem duplicar** (entrega 4): se o Worker cai depois de o Resend aceitar e antes
  do PATCH para `sent`, o pedido fica em `draft` e a nova tentativa envia de novo. Falta decidir como
  o envio fica idempotente (uma chave por `id` e `version` no provedor, se ele aceitar, ou um status
  de envio em curso). Responde: quem desenha a entrega 4, lendo a documentação do Resend.
- **"Refazer" e a sugestão do Claude** (entrega 3): `claude_suggestions` é `unique (task, input_key)`
  e a chave do pedido é `<chave de acesso>:return_note`, então refazer não ganha sugestão nova com a
  mesma chave; e `pendingSupplierRequests` pula a nota com pedido de qualquer status. A entrega 3
  precisa de outra chave por tentativa. Responde: o dono do caso de uso, na entrega 3.
- **A forma de `attachments`** (entregas 4 e 5): proposta, para não copiar a nota emitida, que já está
  em `outbox_return_notes.note_document`: `[{"kind": "return_note_json" | "return_note_pdf",
  "return_note_id": <id da entrada>, "filename": ...}]`. Onde o PDF mora é da entrega 5.
- **Apagamento de dado pessoal**: `changed_by`, `sent_by` e a história guardam a identidade de quem
  agiu, como `emitted_by` na entrega 1; não há caminho de apagamento declarado (LGPD). Responde: o
  mantenedor, num ADR próprio, para todas as tabelas que guardam quem agiu.
- **Outros tipos de pedido** (backlog): cada um amplia `request_type_check`; o índice parcial já é
  por tipo.
