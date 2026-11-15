// Testes online da emissão da devolução (#156, T1 a T6) contra o Supabase real. Pulam sem as credenciais
// e enquanto a migração 20261116110000_return_note_emission não foi aplicada (#156: a esteira a aplica no merge).
// #156 Local: set -a; . ./.dev.vars; set +a; npm --prefix api test. Nenhum valor de chave é impresso.
import { afterAll, describe, expect, it } from 'vitest';
import { erpReturnNoteOutbox } from '../../src/connectors/erp-return-note.js';
import { SupabaseRest, SupabaseRestError } from '../../src/connectors/supabase-rest.js';
import { Money, Quantity } from '../../src/domain/index.js';
import { mockReturnNoteEmitter } from '../../src/returns/mock-return-note-emitter.js';
import { supabaseReturnNoteQueue } from '../../src/returns/return-notes.js';
import { supabaseReturnNoteEmissions } from '../../src/returns/supabase-return-note-emissions.js';
import { invoice } from '../returns/return-note-fixtures.js';

function env(name: string): string | undefined {
  const value: unknown = Reflect.get(process.env, name);
  return typeof value === 'string' && value !== '' ? value : undefined;
}

const URL_ = env('BARTE_ACADEMY_SUPABASE_URL');
const KEY = env('BARTE_ACADEMY_SUPABASE_SECRET_KEY');
const PUBLISHABLE = env('BARTE_ACADEMY_SUPABASE_PUBLISHABLE_KEY');
const ONLINE = Boolean(URL_ && KEY);

/** #156 A migração está aplicada quando a coluna da nota e a tabela de reservas existem. */
async function migrationApplied(): Promise<boolean> {
  if (!ONLINE) return false;
  const rest = new SupabaseRest({ url: URL_ ?? '', secretKey: KEY ?? '' });
  try {
    await rest.select('outbox_return_notes', { select: 'note_document', limit: 0 });
    await rest.select('return_note_numbers', { select: 'number', limit: 0 });
    return true;
  } catch (error) {
    if (error instanceof SupabaseRestError && [400, 404].includes(error.status)) return false;
    throw error;
  }
}
const APPLIED = await migrationApplied();

/** #156 O corpo de erro do PostgREST, lido inteiro: `code` e `message` são os campos que o teste confere. */
function isPostgrestError(value: unknown): value is { code: string; message: string } {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'code') === 'string' && typeof Reflect.get(value, 'message') === 'string';
}

/** #156 PATCH direto ao PostgREST, com a URL e os cabeçalhos do SupabaseRest, para ler a resposta sem o corte do SupabaseRestError. */
async function rawPatch(id: number, body: Record<string, unknown>): Promise<{ status: number; code: string; message: string }> {
  const key = KEY ?? '';
  const headers: Record<string, string> = { apikey: key, 'Content-Type': 'application/json' };
  if (!key.startsWith('sb_')) headers.Authorization = `Bearer ${key}`;
  const query = new URLSearchParams({ id: `eq.${id}`, status: 'eq.pendente' }).toString();
  const response = await fetch(`${(URL_ ?? '').replace(/\/+$/, '')}/rest/v1/outbox_return_notes?${query}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const parsed: unknown = await response.json();
  if (!isPostgrestError(parsed)) return { status: response.status, code: '', message: '' };
  return { status: response.status, code: parsed.code, message: parsed.message };
}

const BY = 'fiscal@exemplo.test';
const NOW = new Date('2026-11-16T13:00:00Z');
const ORIGIN = `${'9'.repeat(30)}${String(Date.now()).slice(-14)}`;

describe.skipIf(!APPLIED)('#156 online: a emissão da devolução no Supabase real', () => {
  const rest = new SupabaseRest({ url: URL_ ?? '', secretKey: KEY ?? '' });
  const outbox = erpReturnNoteOutbox(rest);
  const emissions = supabaseReturnNoteEmissions(rest);
  const queue = supabaseReturnNoteQueue(rest);
  const emitter = mockReturnNoteEmitter(rest);
  const written: number[] = [];

  afterAll(async () => {
    for (const id of written) await rest.delete('outbox_return_notes', { id: `eq.${id}` });
  });

  async function entry(amount: number): Promise<number> {
    const row = await outbox.publish({
      invoiceAccessKey: ORIGIN,
      lines: [{ supplierCode: 'F08-001', quantity: Quantity.of(amount, 'UN') }],
      reason: `teste-156-${Date.now()}-${amount}`,
    });
    written.push(row.id);
    return row.id;
  }

  const request = (entryId: number, amount: number) => ({
    entryId,
    lines: [{ supplierCode: 'F08-001', quantity: Quantity.of(amount, 'UN') }],
    value: Money.ofCents(849 * amount),
    invoice: invoice(ORIGIN),
    issuedOn: '2026-11-16',
  });

  const reservations = async (id: number): Promise<number> =>
    (await rest.select('return_note_numbers', { filters: { return_note_id: `eq.${id}` } })).length;

  /** #156 O PATCH completo de uma emissão, com o que o teste quiser trocar. */
  const emissionPatch = (doc: Readonly<Record<string, unknown>> & { nota_id: string; chave?: string; serie: number; numero: number }, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    status: 'emitida',
    nfe_number: String(doc.numero),
    emitted_by: BY,
    emitted_at: NOW.toISOString(),
    note_document: doc,
    note_id: doc.nota_id,
    note_access_key: doc.chave ?? null,
    note_series: doc.serie,
    note_number: doc.numero,
    ...over,
  });
  const patch = (id: number, body: Record<string, unknown>) => rest.update('outbox_return_notes', { id: `eq.${id}`, status: 'eq.pendente' }, body);
  const columnOf = async (id: number, column: string): Promise<unknown> => {
    const [row] = await rest.select('outbox_return_notes', { select: column, filters: { id: `eq.${id}` } });
    return typeof row === 'object' && row !== null ? Reflect.get(row, column) : undefined;
  };
  const statusOf = (id: number): Promise<unknown> => columnOf(id, 'status');

  it('#156/AC-4 T1: a reserva é idempotente por entrada, também em paralelo, e a nota usa o número da reserva', async () => {
    const a = await entry(10);
    const b = await entry(5);
    const [x, y] = await Promise.all([emitter.emit(request(a, 10)), emitter.emit(request(a, 10))]);
    expect(x.numero).toBe(y.numero);
    expect(await reservations(a)).toBe(1);
    const other = await emitter.emit(request(b, 5));
    expect(other.numero).not.toBe(x.numero);
    expect(await emitter.emit(request(a, 10))).toMatchObject({ numero: x.numero });
    await emissions.markEmitted(a, x, BY, NOW);
    expect(await columnOf(a, 'note_number')).toBe(x.numero);
  });

  it('#156/AC-4 T2: a emissão condicional grava uma vez, e a emissão à mão depois dela é conflito', async () => {
    const id = await entry(11);
    const cancelled = await entry(12);
    const doc = await emitter.emit(request(id, 11));
    expect(await emissions.markEmitted(id, doc, BY, NOW)).toBe(true);
    expect(await emissions.markEmitted(id, { ...doc, nota_id: 'ND-9999' }, BY, NOW)).toBe(false);
    expect(await queue.emit(id, '12345', BY, NOW)).toEqual({ kind: 'conflict' });
    await queue.cancel(cancelled, 'duplicada', BY, NOW);
    expect(await emissions.markEmitted(cancelled, await emitter.emit(request(cancelled, 12)), BY, NOW)).toBe(false);
    expect(await reservations(id)).toBe(1);
  });

  it('#156/AC-4 T3: o note_access_key e o note_id são únicos no banco', async () => {
    const first = await entry(13);
    const second = await entry(14);
    const doc = await emitter.emit(request(first, 13));
    await emissions.markEmitted(first, doc, BY, NOW);
    const sameKey = { ...doc, nota_id: 'ND-9998', numero: 9998 };
    await expect(patch(second, emissionPatch(sameKey))).rejects.toBeInstanceOf(SupabaseRestError);
    const sameId = { ...doc, chave: '1'.repeat(44) };
    await expect(patch(second, emissionPatch(sameId))).rejects.toBeInstanceOf(SupabaseRestError);
    expect(await statusOf(second)).toBe('pendente');
  });

  it('#156/AC-4 T4: as restrições da emitida recusam a nota incoerente, e aceitam a emissão à mão', async () => {
    const id = await entry(15);
    const doc = await emitter.emit(request(id, 15));
    const { chave: _dropped, ...withoutKey } = doc;
    const noteCheck = 'outbox_return_notes_note_check';
    // #156 Cada recusa nomeia a restrição do banco no `message` do PostgREST, lido inteiro (o detail do SupabaseRestError corta em 300); o sem emitted_by é da checagem da #140.
    const bad: [Record<string, unknown>, string][] = [
      [{ status: 'pendente', note_document: doc, note_id: doc.nota_id, note_access_key: doc.chave ?? null, note_series: doc.serie, note_number: doc.numero }, noteCheck],
      [emissionPatch(doc, { emitted_by: null }), 'outbox_return_notes_emitida_check'],
      [{ status: 'emitida', nfe_number: String(doc.numero), emitted_by: BY, emitted_at: NOW.toISOString(), note_id: doc.nota_id }, noteCheck],
      [emissionPatch(doc, { nfe_number: String(doc.numero + 1) }), noteCheck],
      [emissionPatch(doc, { note_access_key: '2'.repeat(44) }), noteCheck],
      [emissionPatch(withoutKey), noteCheck],
      [emissionPatch({ ...doc, nota_referenciada: '3'.repeat(44) }), noteCheck],
    ];
    for (const [body, constraint] of bad) {
      const refusal = await rawPatch(id, body);
      expect(refusal.status).toBe(400);
      expect(refusal.code).toBe('23514');
      expect(refusal.message).toContain(constraint);
    }
    expect(await statusOf(id)).toBe('pendente');
    const manual = await entry(16);
    expect(await queue.emit(manual, '777', BY, NOW)).toMatchObject({ kind: 'ok' });
  });

  it.skipIf(!PUBLISHABLE)('#156/AC-4 T5: a chave pública não lê return_note_numbers', async () => {
    const pub = PUBLISHABLE ?? '';
    const headers: Record<string, string> = { apikey: pub };
    if (!pub.startsWith('sb_')) headers.Authorization = `Bearer ${pub}`;
    const response = await fetch(`${(URL_ ?? '').replace(/\/+$/, '')}/rest/v1/return_note_numbers?select=*`, { headers });
    const parsed: unknown = response.ok ? await response.json() : [];
    expect([200, 401, 403]).toContain(response.status);
    expect(parsed).toEqual([]);
  });

  it('#156/AC-4 T6: a reserva não muda nem se apaga, e reservar funciona com o UPDATE e o DELETE revogados', async () => {
    const id = await entry(17);
    await emitter.emit(request(id, 17));
    await expect(
      rest.update('return_note_numbers', { return_note_id: `eq.${id}` }, { reserved_at: NOW.toISOString() }),
    ).rejects.toBeInstanceOf(SupabaseRestError);
    await expect(rest.delete('return_note_numbers', { return_note_id: `eq.${id}` })).rejects.toBeInstanceOf(SupabaseRestError);
    expect(await reservations(id)).toBe(1);
  });
});
