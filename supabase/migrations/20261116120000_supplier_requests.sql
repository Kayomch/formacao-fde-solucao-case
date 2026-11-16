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
