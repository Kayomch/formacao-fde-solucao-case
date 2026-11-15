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
  -- #156 com as colunas iguais ao documento e o nfe_number igual ao número da nota.
  add constraint outbox_return_notes_note_check check (
    (note_document is null and note_id is null and note_access_key is null
      and note_series is null and note_number is null)
    or (
      status = 'emitida' -- ADR-002 (#156)
      and note_document is not null and note_id is not null and note_access_key is not null
      and note_series is not null and note_number is not null
      and jsonb_typeof(note_document) = 'object'
      and note_document ->> 'nota_id' is not distinct from note_id -- ADR-001 (#156)
      and note_document ->> 'chave' is not distinct from note_access_key -- ADR-001 (#156)
      and note_document ->> 'serie' is not distinct from note_series::text -- ADR-001 (#156)
      and note_document ->> 'numero' is not distinct from note_number::text -- ADR-001 (#156)
      and note_document ->> 'nota_referenciada' is not distinct from invoice_access_key -- ADR-001 (#156)
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
-- #156 Append-only: a reserva não muda. O INSERT ... ON CONFLICT DO NOTHING não pede UPDATE.
revoke update on public.return_note_numbers from anon, authenticated, service_role;
