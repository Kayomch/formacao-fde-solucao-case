// Testes online do pedido ao fornecedor (#156, T1 a T8) contra o Supabase real. Pulam sem as credenciais e enquanto a
// migração 20261116120000_supplier_requests não foi aplicada (#156: a esteira a aplica no merge).
// #156 Local: set -a; . ./.dev.vars; set +a; npm --prefix api test. Nenhum valor de chave é impresso.
import { afterAll, describe, expect, it } from 'vitest';
import { SupabaseRest, SupabaseRestError } from '../../src/connectors/supabase-rest.js';
import type { SupplierRequest, SupplierRequestDiscarded, SupplierRequestDraft } from '../../src/domain/index.js';
import { supabaseSupplierContacts } from '../../src/returns/supabase-supplier-contacts.js';
import { supabaseSupplierRequests } from '../../src/returns/supabase-supplier-requests.js';
import { invoice } from '../returns/return-note-fixtures.js';
import { invoiceRow } from '../returns/return-note-db.js';
import { CONTACT, DUE_ON, NOW } from '../returns/supplier-request-fixtures.js';

function env(name: string): string | undefined {
  const value: unknown = Reflect.get(process.env, name);
  return typeof value === 'string' && value !== '' ? value : undefined;
}

const URL_ = env('BARTE_ACADEMY_SUPABASE_URL');
const KEY = env('BARTE_ACADEMY_SUPABASE_SECRET_KEY');
const PUBLISHABLE = env('BARTE_ACADEMY_SUPABASE_PUBLISHABLE_KEY');
const ONLINE = Boolean(URL_ && KEY);

/** #156 A migração está aplicada quando as três tabelas novas respondem. */
async function migrationApplied(): Promise<boolean> {
  if (!ONLINE) return false;
  const rest = new SupabaseRest({ url: URL_ ?? '', secretKey: KEY ?? '' });
  try {
    for (const table of ['supplier_contacts', 'outbox_supplier_emails', 'outbox_supplier_email_history']) {
      await rest.select(table, { select: '*', limit: 0 });
    }
    return true;
  } catch (error) {
    if (error instanceof SupabaseRestError && [400, 404].includes(error.status)) return false;
    throw error;
  }
}
const APPLIED = await migrationApplied();

const BY = 'cron:supplier-request';
const ORIGIN = `${'8'.repeat(30)}${String(Date.now()).slice(-14)}`;
const MISSING = `${'7'.repeat(30)}${String(Date.now()).slice(-14)}`;

const draft = (key: string, over: Partial<SupplierRequestDraft> = {}): SupplierRequestDraft => ({
  requestType: 'return_note',
  invoiceAccessKey: key,
  supplierId: 'F08',
  to: CONTACT,
  asks: [{ kind: 'deliver_missing_or_accept_return', supplierCode: 'F08-001' }],
  dueOn: DUE_ON,
  channel: 'mock',
  model: 'claude-teste',
  draftedAt: NOW.toISOString(),
  status: 'draft',
  subject: 'Devolução da nota 9999',
  body: 'Corpo do e-mail',
  ...over,
});

const discarded = (key: string): SupplierRequestDiscarded => {
  const { subject: _s, body: _b, status: _t, ...base } = draft(key);
  return { ...base, status: 'discarded', reason: 'invalid_shape' };
};

describe.skipIf(!APPLIED)('#156 online: o pedido ao fornecedor no Supabase real', () => {
  const rest = new SupabaseRest({ url: URL_ ?? '', secretKey: KEY ?? '' });
  const requests = supabaseSupplierRequests(rest);
  const TABLE = 'outbox_supplier_emails';

  afterAll(async () => {
    await rest.delete('invoices', { access_key: `eq.${ORIGIN}` });
  });

  const reset = async (): Promise<void> => {
    await rest.delete('invoices', { access_key: `eq.${ORIGIN}` });
    await rest.insert('invoices', [invoiceRow(invoice(ORIGIN))]);
  };
  const rowsOf = async (key: string): Promise<Record<string, unknown>[]> =>
    (await rest.select(TABLE, { filters: { invoice_access_key: `eq.${key}` }, order: 'id' })).flatMap((r) => (typeof r === 'object' && r !== null ? [{ ...r }] : []));
  const statusOf = (r: SupplierRequest): string => r.status;

  it('#156/AC-8 T1: um pedido aberto por nota e tipo; o descartado não conta', async () => {
    await reset();
    expect(await requests.save(draft(ORIGIN))).toBe('inserted');
    expect(await requests.save(draft(ORIGIN))).toBe('refused');
    const [first] = await rowsOf(ORIGIN);
    await rest.update(TABLE, { id: `eq.${String(first?.id)}`, version: 'eq.1' }, { status: 'send_failed', reason: 'rede', version: 2, changed_by: 'teste' });
    expect(await requests.save(draft(ORIGIN))).toBe('refused');
    await rest.update(TABLE, { id: `eq.${String(first?.id)}`, version: 'eq.2' }, { status: 'sent', sent_by: 'teste', sent_at: NOW.toISOString(), version: 3, changed_by: 'teste' });
    expect(await requests.save(draft(ORIGIN))).toBe('refused');
    expect(statusOf(discarded(ORIGIN))).toBe('discarded');
    expect(await requests.save(discarded(ORIGIN))).toBe('inserted');
  });

  it('#156/AC-8 T1: dois save em paralelo dão um inserted e um refused; depois do descarte, um novo entra', async () => {
    await reset();
    const outcomes = await Promise.all([requests.save(draft(ORIGIN)), requests.save(draft(ORIGIN))]);
    expect([...outcomes].sort()).toEqual(['inserted', 'refused']);
    const [open] = await rowsOf(ORIGIN);
    await rest.update(TABLE, { id: `eq.${String(open?.id)}`, version: 'eq.1' }, { status: 'discarded', reason: 'descartado_pela_pessoa', version: 2, changed_by: 'teste' });
    expect(await requests.save(draft(ORIGIN))).toBe('inserted');
  });

  it('#156/AC-8 T2: o 409 da chave estrangeira lança, não é refused', async () => {
    await expect(requests.save(draft(MISSING))).rejects.toBeInstanceOf(SupabaseRestError);
  });

  it('#156 T3: toda escrita grava a versão na história, e a última é a linha', async () => {
    await reset();
    await requests.save(draft(ORIGIN));
    const [row] = await rowsOf(ORIGIN);
    const id = `eq.${String(row?.id)}`;
    await rest.update(TABLE, { id, version: 'eq.1' }, { body: 'editado', version: 2, changed_by: 'pessoa@exemplo.test' });
    await rest.update(TABLE, { id, version: 'eq.2' }, { body: 'editado de novo', version: 3, changed_by: 'pessoa@exemplo.test' });
    const history = await rest.select('outbox_supplier_email_history', { filters: { supplier_email_id: id }, order: 'version' });
    expect(history).toHaveLength(3);
    expect(history.map((h) => (typeof h === 'object' && h !== null ? Reflect.get(h, 'version') : null))).toEqual([1, 2, 3]);
    expect(history.map((h) => (typeof h === 'object' && h !== null ? Reflect.get(h, 'changed_by') : null))).toEqual([BY, 'pessoa@exemplo.test', 'pessoa@exemplo.test']);
    const [now] = await rowsOf(ORIGIN);
    const last = history.at(-1);
    expect(typeof last === 'object' && last !== null ? Reflect.get(last, 'state') : null).toMatchObject({ id: now?.id, body: 'editado de novo', version: 3 });
  });

  it('#156 T4: a versão velha atinge zero linhas e o PATCH sem o filtro com a versão errada é recusado', async () => {
    await reset();
    await requests.save(draft(ORIGIN));
    const [row] = await rowsOf(ORIGIN);
    const id = `eq.${String(row?.id)}`;
    await rest.update(TABLE, { id, version: 'eq.1' }, { body: 'dois', version: 2, changed_by: 'teste' });
    expect(await rest.update(TABLE, { id, version: 'eq.1' }, { body: 'tres', version: 2, changed_by: 'teste' })).toEqual([]);
    await expect(rest.update(TABLE, { id }, { body: 'cinco', version: 5, changed_by: 'teste' })).rejects.toMatchObject({ status: 400 });
  });

  it('#156 T5: o gatilho e as checagens recusam o que o domínio não promete', async () => {
    await reset();
    await requests.save(draft(ORIGIN));
    const [row] = await rowsOf(ORIGIN);
    const id = `eq.${String(row?.id)}`;
    const patch = (body: Record<string, unknown>, version = 1) => rest.update(TABLE, { id, version: `eq.${version}` }, { version: version + 1, changed_by: 'teste', ...body });
    await expect(patch({ due_on: '2026-12-31' })).rejects.toMatchObject({ status: 400 });
    await expect(patch({ asks: [{ kind: 'offset_title', supplier_code: null }] })).rejects.toMatchObject({ status: 400 });
    await expect(patch({ body: null })).rejects.toMatchObject({ status: 400 });
    await expect(patch({ status: 'discarded' })).rejects.toMatchObject({ status: 400 });
    await expect(patch({ status: 'sent' })).rejects.toMatchObject({ status: 400 });
    await patch({ status: 'send_failed', reason: 'rede' });
    await expect(patch({ body: 'novo texto' }, 2)).rejects.toMatchObject({ status: 400 });
    await expect(patch({ status: 'draft' }, 2)).rejects.toMatchObject({ status: 400 });
    await patch({ status: 'sent', sent_by: 'pessoa@exemplo.test', sent_at: NOW.toISOString() }, 2);
    await expect(patch({ status: 'draft' }, 3)).rejects.toMatchObject({ status: 400 });
  });

  it('#156 T6: a história e o contato não se escrevem, e a chave pública não lê as três tabelas', async () => {
    await reset();
    await requests.save(draft(ORIGIN));
    await expect(rest.update('outbox_supplier_email_history', { version: 'eq.1' }, { changed_by: 'x' })).rejects.toBeInstanceOf(SupabaseRestError);
    await expect(rest.delete('outbox_supplier_email_history', { version: 'eq.1' })).rejects.toBeInstanceOf(SupabaseRestError);
    await expect(rest.insert('supplier_contacts', [{ supplier_id: 'F90', email: 'fiscal.f90@fornecedores.test' }])).rejects.toBeInstanceOf(SupabaseRestError);
    await expect(rest.update('supplier_contacts', { supplier_id: 'eq.F01' }, { email: 'x@y.test' })).rejects.toBeInstanceOf(SupabaseRestError);
    await expect(rest.delete('supplier_contacts', { supplier_id: 'eq.F01' })).rejects.toBeInstanceOf(SupabaseRestError);
    if (!PUBLISHABLE) return console.log('  T6 pulado: sem chave pública');
    for (const table of ['supplier_contacts', 'outbox_supplier_emails', 'outbox_supplier_email_history']) {
      const response = await fetch(`${(URL_ ?? '').replace(/\/+$/, '')}/rest/v1/${table}?select=*`, {
        headers: { apikey: PUBLISHABLE },
        signal: AbortSignal.timeout(15_000),
      });
      const body: unknown = response.ok ? await response.json() : [];
      expect(Array.isArray(body) ? body : []).toHaveLength(0);
    }
  });

  it('#156 T7: apagar a nota leva o pedido e a história junto', async () => {
    await reset();
    await requests.save(draft(ORIGIN));
    const [row] = await rowsOf(ORIGIN);
    await rest.delete('invoices', { access_key: `eq.${ORIGIN}` });
    expect(await rowsOf(ORIGIN)).toEqual([]);
    expect(await rest.select('outbox_supplier_email_history', { filters: { supplier_email_id: `eq.${String(row?.id)}` } })).toEqual([]);
  });

  it('#156/AC-1 T8: emailOf devolve o e-mail de F01 a F12 e null fora do kit', async () => {
    const contacts = supabaseSupplierContacts(rest);
    for (let n = 1; n <= 12; n += 1) {
      const id = `F${String(n).padStart(2, '0')}`;
      expect(await contacts.emailOf(id)).toBe(`fiscal.${id.toLowerCase()}@fornecedores.test`);
    }
    expect(await contacts.emailOf('F99')).toBeNull();
  });
});
