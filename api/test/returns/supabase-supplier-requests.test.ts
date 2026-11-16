// #156 Os adaptadores das portas do pedido ao fornecedor sobre o PostgREST falso (T10). O fake não imita o gatilho nem as checagens.
import { describe, expect, it } from 'vitest';
import { erpReturnNoteOutbox } from '../../src/connectors/erp-return-note.js';
import { SupabaseRest, SupabaseRestError } from '../../src/connectors/supabase-rest.js';
import { Quantity, type SupplierRequestDiscarded, type SupplierRequestDraft } from '../../src/domain/index.js';
import { supabaseReturnQueueValues } from '../../src/returns/supabase-return-queue-values.js';
import { supabaseSupplierContacts } from '../../src/returns/supabase-supplier-contacts.js';
import { supabaseSupplierRequestSuggestions } from '../../src/returns/supabase-supplier-request-suggestions.js';
import { supabaseSupplierRequests } from '../../src/returns/supabase-supplier-requests.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { approved, giveBack, invoice, ORIGIN_KEY } from './return-note-fixtures.js';
import { worldWith } from './return-note-db.js';
import { CONTACT, DUE_ON, NOW } from './supplier-request-fixtures.js';

const INDEX = 'outbox_supplier_emails_open_request_key';

const draft = (over: Partial<SupplierRequestDraft> = {}): SupplierRequestDraft => ({
  requestType: 'return_note',
  invoiceAccessKey: ORIGIN_KEY,
  supplierId: 'F08',
  to: CONTACT,
  asks: [
    { kind: 'deliver_missing_or_accept_return', supplierCode: 'F08-001' },
    { kind: 'offset_title', supplierCode: null },
  ],
  dueOn: DUE_ON,
  channel: 'mock',
  model: 'claude-teste',
  draftedAt: NOW.toISOString(),
  status: 'draft',
  subject: 'Devolução da nota 9999',
  body: 'Corpo do e-mail',
  ...over,
});

const discarded = (over: Partial<SupplierRequestDiscarded> = {}): SupplierRequestDiscarded => {
  const { subject: _s, body: _b, status: _t, ...base } = draft();
  return { ...base, status: 'discarded', reason: 'invalid_shape', ...over };
};

const restOver = (fake: FakePostgrest): SupabaseRest =>
  new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: fake.fetch });

const restAnswering = (status: number, text: string): SupabaseRest =>
  new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: async () => new Response(text, { status }) });

describe('#156 o repositório dos pedidos ao fornecedor', () => {
  it('#156/AC-1 save de um rascunho manda as colunas do pedido, sem versão, e devolve inserted', async () => {
    const fake = new FakePostgrest();
    expect(await supabaseSupplierRequests(restOver(fake)).save(draft())).toBe('inserted');
    expect(fake.rows('outbox_supplier_emails')).toEqual([
      expect.objectContaining({
        invoice_access_key: ORIGIN_KEY,
        supplier_id: 'F08',
        request_type: 'return_note',
        to_address: CONTACT,
        subject: 'Devolução da nota 9999',
        body: 'Corpo do e-mail',
        asks: [
          { kind: 'deliver_missing_or_accept_return', supplier_code: 'F08-001' },
          { kind: 'offset_title', supplier_code: null },
        ],
        due_on: DUE_ON,
        status: 'draft',
        channel: 'mock',
        model: 'claude-teste',
        drafted_at: NOW.toISOString(),
        changed_by: 'cron:supplier-request',
      }),
    ]);
    const sent = fake.rows('outbox_supplier_emails')[0] ?? {};
    expect(sent).not.toHaveProperty('reason', expect.anything());
    const post = fake.requests.find((r) => r.method === 'POST');
    expect(post?.url).not.toContain('on_conflict');
    expect(post?.headers.Prefer).not.toContain('ignore-duplicates');
  });

  it('#156/AC-6 save de um descartado manda assunto e corpo nulos e o motivo', async () => {
    const fake = new FakePostgrest();
    expect(await supabaseSupplierRequests(restOver(fake)).save(discarded({ reason: 'subject_without_invoice_number' }))).toBe('inserted');
    expect(fake.rows('outbox_supplier_emails')[0]).toMatchObject({
      status: 'discarded',
      reason: 'subject_without_invoice_number',
      subject: null,
      body: null,
      changed_by: 'cron:supplier-request',
    });
    expect(fake.rows('outbox_supplier_emails')[0]).not.toHaveProperty('version', 2);
  });

  it('#156/AC-8 o 409 com 23505 no índice do pedido aberto vira refused, e nada se grava', async () => {
    const fake = new FakePostgrest();
    const requests = supabaseSupplierRequests(restOver(fake));
    expect(await requests.save(draft())).toBe('inserted');
    expect(await requests.save(draft({ subject: 'outro assunto' }))).toBe('refused');
    expect(fake.rows('outbox_supplier_emails')).toHaveLength(1);
  });

  it('#156/AC-8 um descartado entra ao lado de um pedido aberto, e um rascunho entra depois do descarte', async () => {
    const fake = new FakePostgrest();
    const requests = supabaseSupplierRequests(restOver(fake));
    expect(await requests.save(discarded())).toBe('inserted');
    expect(await requests.save(draft())).toBe('inserted');
    expect(await requests.save(discarded())).toBe('inserted');
    expect(fake.rows('outbox_supplier_emails')).toHaveLength(3);
  });

  it('#156/AC-8 o 409 com 23503 lança, nunca é refused', async () => {
    const body = JSON.stringify({ code: '23503', details: null, hint: null, message: `insert violates foreign key constraint "outbox_supplier_emails_invoice_fkey"` });
    await expect(supabaseSupplierRequests(restAnswering(409, body)).save(draft())).rejects.toBeInstanceOf(SupabaseRestError);
  });

  it('#156/AC-8 o 409 com 23505 em outro índice lança', async () => {
    const body = JSON.stringify({ code: '23505', message: 'duplicate key value violates unique constraint "outbox_supplier_emails_pkey"' });
    await expect(supabaseSupplierRequests(restAnswering(409, body)).save(draft())).rejects.toBeInstanceOf(SupabaseRestError);
  });

  it('#156/AC-8 um 409 que não é JSON, ou um JSON cortado, lança', async () => {
    const requests = (text: string) => supabaseSupplierRequests(restAnswering(409, text));
    await expect(requests('<html>conflito</html>').save(draft())).rejects.toBeInstanceOf(SupabaseRestError);
    const truncated = `{"code":"23505","message":"duplicate key value violates unique constraint \\"${INDEX}`;
    await expect(requests(truncated).save(draft())).rejects.toBeInstanceOf(SupabaseRestError);
  });

  it('#156/AC-8 o erro do gatilho (400) e o do servidor (500) lançam', async () => {
    const trigger = JSON.stringify({ code: 'P0001', message: 'outbox_supplier_emails: um pedido nasce draft ou discarded, na versão 1' });
    await expect(supabaseSupplierRequests(restAnswering(400, trigger)).save(draft())).rejects.toBeInstanceOf(SupabaseRestError);
    await expect(supabaseSupplierRequests(restAnswering(500, '{}')).save(draft())).rejects.toBeInstanceOf(SupabaseRestError);
  });

  it('#156/AC-8 um descartado nunca é refused: o 409 do índice, se vier, lança', async () => {
    const body = JSON.stringify({ code: '23505', message: `duplicate key value violates unique constraint "${INDEX}"` });
    await expect(supabaseSupplierRequests(restAnswering(409, body)).save(discarded())).rejects.toBeInstanceOf(SupabaseRestError);
  });

  it('#156/AC-8 listFor lê os pedidos das notas dadas, de qualquer status, pelo filtro in', async () => {
    const fake = new FakePostgrest();
    const requests = supabaseSupplierRequests(restOver(fake));
    await requests.save(discarded());
    await requests.save(draft());
    const other = '35261100000000000000550010000099991000088888';
    expect(await requests.listFor([ORIGIN_KEY, other])).toEqual([
      { invoiceAccessKey: ORIGIN_KEY, requestType: 'return_note', status: 'discarded' },
      { invoiceAccessKey: ORIGIN_KEY, requestType: 'return_note', status: 'draft' },
    ]);
    const get = fake.requests.find((r) => r.method === 'GET');
    expect(decodeURIComponent(get?.url ?? '')).toContain(`invoice_access_key=in.("${ORIGIN_KEY}","${other}")`);
  });

  it('listFor sem notas não consulta o banco, e uma chave fora do formato lança', async () => {
    const fake = new FakePostgrest();
    const requests = supabaseSupplierRequests(restOver(fake));
    expect(await requests.listFor([])).toEqual([]);
    expect(fake.requests).toHaveLength(0);
    await expect(requests.listFor(['1"),status=eq.x'])).rejects.toBeInstanceOf(SupabaseRestError);
  });

  it('listFor lança numa linha com status fora do conjunto', async () => {
    const fake = new FakePostgrest({
      outbox_supplier_emails: [{ invoice_access_key: ORIGIN_KEY, request_type: 'return_note', status: 'pendente' }],
    });
    await expect(supabaseSupplierRequests(restOver(fake)).listFor([ORIGIN_KEY])).rejects.toBeInstanceOf(SupabaseRestError);
  });
});

describe('#156 o contato do fornecedor', () => {
  it('#156/AC-1 emailOf devolve o e-mail do fornecedor, e null quando não há', async () => {
    const fake = new FakePostgrest({ supplier_contacts: [{ supplier_id: 'F08', email: CONTACT }] });
    const contacts = supabaseSupplierContacts(restOver(fake));
    expect(await contacts.emailOf('F08')).toBe(CONTACT);
    expect(await contacts.emailOf('F99')).toBeNull();
    expect(fake.requests[0]?.url).toContain('supplier_id=eq.F08');
  });

  it('emailOf lança numa linha sem e-mail', async () => {
    const fake = new FakePostgrest({ supplier_contacts: [{ supplier_id: 'F08', email: null }] });
    await expect(supabaseSupplierContacts(restOver(fake)).emailOf('F08')).rejects.toBeInstanceOf(SupabaseRestError);
  });
});

describe('#156 o valor da devolução na fila', () => {
  async function queued(amounts: readonly number[]) {
    const { fake, rest } = worldWith([{ proposal: approved('E2', [giveBack('SKU-1', 10)]), invoice: invoice(), proposalId: 1 }]);
    const outbox = erpReturnNoteOutbox(rest);
    const ids: number[] = [];
    for (const [i, amount] of amounts.entries()) {
      const row = await outbox.publish({
        invoiceAccessKey: ORIGIN_KEY,
        lines: [{ supplierCode: 'F08-001', quantity: Quantity.of(amount, 'UN') }],
        reason: `teste ${i}`,
      });
      ids.push(row.id);
    }
    return { fake, rest, ids };
  }

  it('#156/AC-1 valuesOf soma o preço da nota vezes a quantidade, como a fila da #140, e exclui a cancelada', async () => {
    const { fake, rest, ids } = await queued([10, 3]);
    const second = fake.rows('outbox_return_notes').find((r) => r.id === ids[1]);
    if (second) second.status = 'cancelada'; // ADR-002
    const values = await supabaseReturnQueueValues(rest).valuesOf([ORIGIN_KEY]);
    expect(values.get(ORIGIN_KEY)?.cents).toBe(8490);
    const get = fake.requests.filter((r) => r.method === 'GET' && r.url.includes('outbox_return_notes')).at(-1);
    expect(get?.url).toContain('status=neq.cancelada'); // ADR-002
  });

  it('valuesOf deixa de fora a nota sem entrada na fila, e não consulta com a lista vazia', async () => {
    const { fake, rest } = await queued([10]);
    const other = '35261100000000000000550010000099991000088888';
    const values = await supabaseReturnQueueValues(rest).valuesOf([other]);
    expect(values.size).toBe(0);
    const before = fake.requests.length;
    expect((await supabaseReturnQueueValues(rest).valuesOf([])).size).toBe(0);
    expect(fake.requests).toHaveLength(before);
  });

  it('valuesOf lança na linha da fila que a nota de origem não tem', async () => {
    const { fake, rest } = await queued([10]);
    const row = fake.rows('outbox_return_notes')[0];
    if (row) row.payload = { lines: [{ supplierCode: 'F08-999', amount: 1, unit: 'UN' }], reason: 'x' };
    await expect(supabaseReturnQueueValues(rest).valuesOf([ORIGIN_KEY])).rejects.toBeInstanceOf(SupabaseRestError);
  });
});

describe('#156 as sugestões ok do pedido ao fornecedor', () => {
  it('#156/AC-1 listOk devolve a chave, o input, a saída e o modelo das linhas ok da tarefa supplier-request', async () => {
    const fake = new FakePostgrest({
      claude_suggestions: [
        { task: 'supplier-request', input_key: `${ORIGIN_KEY}:return_note`, input: { dueOn: DUE_ON }, output: { subject: 's', body: 'b' }, status: 'ok', model: 'claude-teste' },
        { task: 'supplier-request', input_key: 'k2', input: {}, output: null, status: 'error', model: 'claude-teste' },
        { task: 'dossier', input_key: 'k3', input: {}, output: {}, status: 'ok', model: 'claude-teste' },
      ],
    });
    expect(await supabaseSupplierRequestSuggestions(restOver(fake)).listOk()).toEqual([
      { key: `${ORIGIN_KEY}:return_note`, input: { dueOn: DUE_ON }, output: { subject: 's', body: 'b' }, model: 'claude-teste' },
    ]);
    expect(fake.requests[0]?.url).toContain('task=eq.supplier-request');
    expect(fake.requests[0]?.url).toContain('status=eq.ok');
  });
});
