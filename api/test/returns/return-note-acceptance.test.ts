// #156/AC-2 e #156/AC-4: a devolução aprovada entra na fila pelo Cron e é emitida pelo mock, montado de ponta a ponta.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { returnNoteRoutes } from '../../src/http/return-notes.js';
import { tick } from '../../src/cron/tick.js';
import { returnNoteEmission } from '../../src/returns/return-note-emission.js';
import { supabaseReturnNoteQueue } from '../../src/returns/return-notes.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitTables } from '../support/kit.js';

const ENV = { BARTE_ACADEMY_SUPABASE_URL: 'https://fake.supabase.co', BARTE_ACADEMY_SUPABASE_SECRET_KEY: 'sb_secret_fake' };
const CRON = { cron: '*/15 * * * *' };
const NOW = new Date('2026-11-16T13:00:00Z');
const BY = 'fiscal@exemplo.test';
// #156 No kit, as propostas E3 devolvem a diferença: a 3 (SKU-1012) e a 14 (SKU-1022). A E2 da 2 só segura.
const E3_APPROVED = 3;
const E3_ALTERED = 14;
const E2_HOLD_ONLY = 2;

let logs: string[];

beforeEach(() => {
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function kitWorld(): { fake: FakePostgrest; rest: SupabaseRest } {
  const fake = new FakePostgrest(kitTables());
  vi.stubGlobal('fetch', fake.fetch);
  const rest = new SupabaseRest({ url: ENV.BARTE_ACADEMY_SUPABASE_URL, secretKey: ENV.BARTE_ACADEMY_SUPABASE_SECRET_KEY, fetch: fake.fetch });
  return { fake, rest };
}

/** #156 A pessoa decide pela fila #63: a proposta passa a aprovada ou alterada. */
async function decide(rest: SupabaseRest, id: number, state: 'aprovada' | 'alterada'): Promise<void> {
  await rest.update('proposals', { id: `eq.${id}` }, { state }); // ADR-002
}

/** #156 A rodada que propõe, a decisão da pessoa e a rodada que publica a devolução. */
async function decidedWorld() {
  const world = kitWorld();
  await tick(CRON, ENV);
  await decide(world.rest, E3_APPROVED, 'aprovada');
  await decide(world.rest, E3_ALTERED, 'alterada');
  await decide(world.rest, E2_HOLD_ONLY, 'aprovada');
  await tick(CRON, ENV);
  return world;
}

const emit = (rest: SupabaseRest, id: number) => returnNoteEmission(rest)({ id, by: BY, now: NOW });

describe('o Cron põe a devolução decidida na fila da #140', () => {
  it('#156/AC-2 Dada a E3 aprovada e a E3 alterada com linhas devolver, quando a rodada roda, a fila ganha as duas devoluções e rodar de novo não grava outra', async () => {
    const { fake } = await decidedWorld();
    const keys = () => fake.rows('outbox_return_notes').map((r) => r.status);
    expect(keys()).toEqual(['pendente', 'pendente']);
    await tick(CRON, ENV);
    expect(keys()).toHaveLength(2);
    expect(logs.some((l) => l.includes('devoluções publicadas na fila de notas 0'))).toBe(true);
  });

  it('#156/AC-2 O número de devoluções publicadas na rodada vai para a linha do log', async () => {
    await decidedWorld();
    expect(logs.some((l) => l.includes('devoluções publicadas na fila de notas 2'))).toBe(true);
  });

  it('#156/AC-2 Dada uma decisão sem linha devolver, quando a rodada roda, nada entra na fila por ela', async () => {
    const { fake } = await decidedWorld();
    const invoiceKeys = fake.rows('outbox_return_notes').map((r) => r.invoice_access_key);
    const holdOnly = fake.rows('proposals').find((p) => p.id === E2_HOLD_ONLY)?.invoice_access_key;
    expect(invoiceKeys).toHaveLength(2);
    expect(invoiceKeys).not.toContain(holdOnly);
  });

  it('#156/AC-2 Dada a proposta ainda não decidida, quando a rodada roda, a fila fica vazia', async () => {
    const { fake } = kitWorld();
    await tick(CRON, ENV);
    expect(fake.rows('outbox_return_notes')).toHaveLength(0);
  });

  it('#156/AC-2 Se a fila falha, a rodada loga só o status, não o texto do Supabase, e segue', async () => {
    const { fake, rest } = kitWorld();
    await tick(CRON, ENV);
    await decide(rest, E3_APPROVED, 'aprovada');
    vi.stubGlobal('fetch', (input: string, init?: RequestInit) =>
      input.includes('/rest/v1/outbox_return_notes')
        ? Promise.resolve(new Response('{"message":"detalhe-interno-do-banco"}', { status: 500 }))
        : fake.fetch(input, init),
    );
    logs.length = 0;
    await expect(tick(CRON, ENV)).resolves.not.toBeNull();
    const all = logs.join('\n');
    expect(all).toContain('devoluções indisponíveis (HTTP 500)');
    expect(all).not.toContain('detalhe-interno-do-banco');
    expect(all).toContain('devoluções publicadas na fila de notas 0');
  });
});

describe('a emissão da nota de devolução', () => {
  it('#156/AC-2 Quando a devolução é emitida, sai a nota no formato do kit com só as linhas devolvidas, citando a nota de origem', async () => {
    const { fake, rest } = await decidedWorld();
    const [entry] = fake.rows('outbox_return_notes');
    const result = await emit(rest, Number(entry?.id));
    expect(result.kind).toBe('emitted');
    if (result.kind !== 'emitted') return;
    expect(result.note.natureza).toBe('devolucao');
    expect(result.note.nota_referenciada).toBe(entry?.invoice_access_key);
    expect(result.note.chave).toMatch(/^\d{44}$/);
    expect(result.note.itens.map((i) => i.codigo_fornecedor)).toEqual(
      (entry?.payload as { lines: { supplierCode: string }[] }).lines.map((l) => l.supplierCode),
    );
  });

  it('#156/AC-2 O valor_total da nota é o valueCents que a fila da #140 mostra para a entrada', async () => {
    const { fake, rest } = await decidedWorld();
    const entries = fake.rows('outbox_return_notes');
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      const result = await emit(rest, Number(entry.id));
      const view = (await supabaseReturnNoteQueue(rest).list('emitida', NOW)).find((v) => v.id === entry.id);
      expect(result.kind).toBe('emitted');
      if (result.kind === 'emitted') expect(Math.round(result.note.valor_total * 100)).toBe(view?.valueCents);
    }
  });

  it('#156/AC-4 Emitida a devolução, a entrada da fila fica emitida com o número da nota do mock', async () => {
    const { fake, rest } = await decidedWorld();
    const id = Number(fake.rows('outbox_return_notes')[0]?.id);
    const result = await emit(rest, id);
    const view = (await supabaseReturnNoteQueue(rest).list('emitida', NOW)).find((v) => v.id === id);
    expect(result.kind).toBe('emitted');
    if (result.kind === 'emitted') expect(view?.emitted?.number).toBe(String(result.note.numero));
    expect(view?.status).toBe('emitida');
  });

  it('#156/AC-4 A rota GET da #140 lista a entrada emitida pelo mock com o número da nota', async () => {
    const { fake, rest } = await decidedWorld();
    const id = Number(fake.rows('outbox_return_notes')[0]?.id);
    const result = await emit(rest, id);
        const request = new Request('https://worker.test/api/return-notes?status=emitida', { headers: { 'x-teste': '1' } });
    const env = { ACCESS_AUD: 'aud', ACCESS_TEAM_DOMAIN: 'time.cloudflareaccess.com', ...ENV };
    const response = await returnNoteRoutes(request, { email: BY }, env, { supabase: () => rest, now: () => NOW }, () => rest);
    const body: unknown = await response?.json();
    const notes = typeof body === 'object' && body !== null && 'notes' in body && Array.isArray(body.notes) ? body.notes : [];
    const listed = notes.find((n: unknown) => typeof n === 'object' && n !== null && 'id' in n && n.id === id);
    expect(result.kind).toBe('emitted');
    expect(listed).toMatchObject({ status: 'emitida', emitted: { number: result.kind === 'emitted' ? String(result.note.numero) : '' } });
  });

  it('#156/AC-4 Emitir de novo devolve a mesma nota, sem outra reserva nem outra chave', async () => {
    const { fake, rest } = await decidedWorld();
    const id = Number(fake.rows('outbox_return_notes')[0]?.id);
    const first = await emit(rest, id);
    const second = await emit(rest, id);
    expect(first.kind).toBe('emitted');
    expect(second.kind).toBe('already_emitted');
    if (first.kind === 'emitted' && second.kind === 'already_emitted') expect(second.note).toEqual(first.note);
    expect(fake.rows('return_note_numbers')).toHaveLength(1);
  });

  it('#156/AC-4 A devolução cancelada é recusada como conflito, sem reserva', async () => {
    const { fake, rest } = await decidedWorld();
    const id = Number(fake.rows('outbox_return_notes')[0]?.id);
    await supabaseReturnNoteQueue(rest).cancel(id, 'duplicada', BY, NOW);
    expect((await emit(rest, id)).kind).toBe('conflict');
    expect(fake.rows('return_note_numbers')).toHaveLength(0);
  });

  it('#156/AC-4 Um id que não existe na fila é not_found', async () => {
    const { rest } = await decidedWorld();
    expect((await emit(rest, 9999)).kind).toBe('not_found');
  });
});
