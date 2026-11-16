import { describe, expect, it } from 'vitest';
import { SupabaseRest, SupabaseRestError } from '../../src/connectors/supabase-rest.js';
import { FakePostgrest } from '../support/fake-postgrest.js';

const SECRET = 'sb_secret_teste_nao_real';

describe('#59/AC-1 cliente PostgREST', () => {
  it('pagina o select pelo cabeçalho Range até a última página', async () => {
    const fake = new FakePostgrest({ t: Array.from({ length: 5 }, (_, i) => ({ id: i })) });
    const rest = new SupabaseRest({ url: 'https://x.supabase.co/', secretKey: SECRET, fetch: fake.fetch, pageSize: 2 });
    const rows = await rest.select('t');
    expect(rows).toHaveLength(5);
    expect(fake.requests.map((r) => r.headers.Range)).toEqual(['0-1', '2-3', '4-5']);
    expect(fake.requests[0]?.url).toBe('https://x.supabase.co/rest/v1/t?select=*');
  });

  it('chave sb_ vai só no apikey; a legada também no Authorization', async () => {
    const fake = new FakePostgrest();
    await new SupabaseRest({ url: 'https://x', secretKey: SECRET, fetch: fake.fetch }).select('t');
    await new SupabaseRest({ url: 'https://x', secretKey: 'eyJlegado', fetch: fake.fetch }).select('t');
    expect(fake.requests[0]?.headers.apikey).toBe(SECRET);
    expect(fake.requests[0]?.headers.Authorization).toBeUndefined();
    expect(fake.requests[1]?.headers.Authorization).toBe('Bearer eyJlegado');
  });

  it('regra 1: insert com on_conflict ignora a duplicada e devolve só o que entrou', async () => {
    const fake = new FakePostgrest({ t: [{ k: 'a' }] });
    const rest = new SupabaseRest({ url: 'https://x', secretKey: SECRET, fetch: fake.fetch });
    const inserted = await rest.insert('t', [{ k: 'a' }, { k: 'b' }], { onConflict: 'k' });
    expect(inserted).toEqual([{ k: 'b' }]);
    expect(fake.requests[0]?.url).toContain('on_conflict=k');
    expect(fake.requests[0]?.headers.Prefer).toContain('resolution=ignore-duplicates');
  });

  it('upsert atualiza a linha existente pela restrição', async () => {
    const fake = new FakePostgrest({ t: [{ k: 'a', v: 1 }] });
    const rest = new SupabaseRest({ url: 'https://x', secretKey: SECRET, fetch: fake.fetch });
    await rest.upsert('t', [{ k: 'a', v: 2 }], 'k');
    expect(fake.rows('t')).toEqual([{ k: 'a', v: 2 }]);
  });

  it('o erro diz operação, tabela e status, e nunca a chave', async () => {
    const rest = new SupabaseRest({
      url: 'https://x',
      secretKey: SECRET,
      fetch: async () => new Response('{"message":"permission denied"}', { status: 401 }),
    });
    const error = await rest.select('t').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SupabaseRestError);
    expect(String((error as Error).message)).toContain('select em t falhou (HTTP 401)');
    expect(String((error as Error).message)).not.toContain(SECRET);
  });

  it('#156 DAT-1 a mensagem do erro de um 23514 traz operação, tabela, status e code, e nunca o e-mail nem o texto da linha', async () => {
    const body = JSON.stringify({
      code: '23514',
      message: 'new row for relation "outbox_supplier_emails" violates check constraint',
      details: 'Failing row contains (1, fiscal.f01@fornecedores.test, Assunto reservado, Corpo do rascunho).',
    });
    const rest = new SupabaseRest({ url: 'https://x', secretKey: SECRET, fetch: async () => new Response(body, { status: 400 }) });
    const error = await rest.insert('outbox_supplier_emails', [{ a: 1 }]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SupabaseRestError);
    const message = (error as Error).message;
    expect(message).toBe('supabase-rest: insert em outbox_supplier_emails falhou (HTTP 400 23514)');
    expect(message).not.toContain('fiscal.f01@fornecedores.test');
    expect(message).not.toContain('Corpo do rascunho');
    expect((error as SupabaseRestError).detail).toContain('Failing row contains');
  });

  it('update e delete sem filtro são recusados', async () => {
    const rest = new SupabaseRest({ url: 'https://x', secretKey: SECRET, fetch: new FakePostgrest().fetch });
    await expect(rest.delete('t', {})).rejects.toBeInstanceOf(SupabaseRestError);
    await expect(rest.update('t', {}, { v: 1 })).rejects.toBeInstanceOf(SupabaseRestError);
  });
});

describe('#59 REL-1 tempo máximo da requisição', () => {
  it('um fetch que nunca responde vira erro de rede, sem a chave na mensagem', async () => {
    const never = (_input: string, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    const rest = new SupabaseRest({ url: 'https://x', secretKey: SECRET, fetch: never, timeoutMs: 20 });
    const error = await rest.select('t').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SupabaseRestError);
    expect(error).toMatchObject({ operation: 'network', table: 't', status: 0 });
    expect(error).toMatchObject({ detail: 'sem resposta em 20 ms' }); // #156 o detalhe é campo; a mensagem não o carrega
    expect(String(error)).not.toContain(SECRET);
  });

  it('a falha de rede vira o mesmo tipo de erro', async () => {
    const rest = new SupabaseRest({ url: 'https://x', secretKey: SECRET, fetch: () => Promise.reject(new TypeError('boom')) });
    await expect(rest.select('t')).rejects.toMatchObject({ operation: 'network', detail: 'falha de rede' });
  });
});

describe('#59 validação na borda', () => {
  it('resposta que não é lista vira erro de parse', async () => {
    const rest = new SupabaseRest({ url: 'https://x', secretKey: SECRET, fetch: async () => new Response('{"a":1}') });
    await expect(rest.select('t')).rejects.toMatchObject({ operation: 'parse' });
  });

  it('#156 o erro de uma resposta que não é ok guarda o code e a message lidos do corpo, e null quando o corpo não é JSON', async () => {
    const answer = (text: string) => new SupabaseRest({ url: 'https://x', secretKey: SECRET, fetch: async () => new Response(text, { status: 409 }) });
    const body = JSON.stringify({ code: '23505', message: 'duplicate key "idx"', details: 'x'.repeat(600) });
    const error = await answer(body).insert('t', [{ a: 1 }]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SupabaseRestError);
    expect(error).toMatchObject({ status: 409, code: '23505', serverMessage: 'duplicate key "idx"' });
    const plain = await answer('<html>').insert('t', [{ a: 1 }]).catch((e: unknown) => e);
    expect(plain).toMatchObject({ status: 409, code: null, serverMessage: null });
  });
});
