import { describe, expect, it } from 'vitest';
import { Money } from '../../src/domain/index.js';
import { pendingSupplierRequests } from '../../src/returns/pending-supplier-requests.js';
import { draftSupplierRequests } from '../../src/returns/draft-supplier-requests.js';
import { approved, decided, giveBack, ORIGIN_KEY, sourceOf } from './return-note-fixtures.js';
import {
  answerWith,
  BlindRequests,
  CONTACT,
  contactsOf,
  DUE_ON,
  existingRow,
  MemoryRequests,
  NOW,
  okAnswer,
  queueOf,
  REQUEST_KEY,
  suggestionsOf,
} from './supplier-request-fixtures.js';
import type { StoredSuggestion, SupplierRequests } from '../../src/returns/supplier-request-ports.js';

const setup = (
  suggestions: readonly StoredSuggestion[],
  over: { requests?: SupplierRequests; contacts?: Record<string, string | null>; classification?: 'E1' | 'E2' | 'E3' | 'E6' } = {},
) => {
  const lines: string[] = [];
  const requests = over.requests ?? new MemoryRequests();
  const deps = {
    source: sourceOf([decided(approved(over.classification ?? 'E1', [giveBack('SKU-1', 10)]))]),
    queue: queueOf({ [ORIGIN_KEY]: Money.ofCents(8490) }),
    requests,
    contacts: contactsOf(over.contacts ?? { F08: CONTACT }),
    suggestions: suggestionsOf(suggestions),
    now: () => NOW,
    log: (l: string) => lines.push(l),
  };
  return { deps, lines, requests };
};

const rows = (r: SupplierRequests) => (r as MemoryRequests).rows;

describe('o Cron redige o pedido ao fornecedor a partir da sugestão do Claude (#156)', () => {
  it.each(['E1', 'E2', 'E3'] as const)('#156/AC-1: a sugestão ok da decisão %s vira um pedido return_note em rascunho', async (classification) => {
    const { deps, requests } = setup([okAnswer()], { classification });
    expect(await draftSupplierRequests(deps)).toEqual({ drafted: 1, discarded: 0, refused: 0, skipped: 0 });
    const [row] = rows(requests);
    expect(row).toMatchObject({
      status: 'draft',
      requestType: 'return_note',
      invoiceAccessKey: ORIGIN_KEY,
      supplierId: 'F08',
      to: CONTACT,
      dueOn: DUE_ON,
      channel: 'mock',
      model: 'claude-teste',
      draftedAt: NOW.toISOString(),
    });
    expect(row?.asks.length).toBeGreaterThan(0);
  });

  it('#156/AC-1: o texto sai com os valores do banco, não os do Claude', async () => {
    const { deps, requests } = setup([okAnswer()]);
    await draftSupplierRequests(deps);
    const row = rows(requests)[0];
    if (row?.status !== 'draft') throw new Error('esperava um rascunho');
    expect(row.subject).toBe('Devolução da nota 9999');
    expect(row.body).toContain('10 UN');
    expect(row.body).toContain(Money.ofCents(8490).toString());
    expect(row.body).not.toContain('{{');
  });

  it('#156/AC-1: campos a mais na saída do Claude (asks, to) não entram no pedido', async () => {
    const out = { ...(okAnswer().output as object), asks: [{ kind: 'offset_title', supplierCode: null }], to: 'outro@fornecedor.teste' };
    const { deps, requests } = setup([answerWith(out)]);
    expect((await draftSupplierRequests(deps)).drafted).toBe(1);
    const row = rows(requests)[0];
    expect(row?.to).toBe(CONTACT);
    expect(row?.asks).toEqual([{ kind: 'deliver_missing_or_accept_return', supplierCode: 'F08-001' }]);
  });

  it('#156/AC-6: número fora de marcador registra o pedido descartado, com o motivo e sem rascunho', async () => {
    const { deps, requests } = setup([answerWith({ subject: 'Nota {{nota.numero}}', body: 'Devolvemos 10 unidades.' })]);
    expect(await draftSupplierRequests(deps)).toEqual({ drafted: 0, discarded: 1, refused: 0, skipped: 0 });
    expect(rows(requests)[0]).toMatchObject({ status: 'discarded', reason: 'number_outside_marker' });
    expect(rows(requests)[0]).not.toHaveProperty('body');
  });

  it('#156/AC-6: marcador fora do catálogo registra o pedido descartado', async () => {
    const { deps, requests } = setup([answerWith({ subject: 'Nota {{nota.numero}}', body: 'Valor {{devolucao.inventado}}.' })]);
    await draftSupplierRequests(deps);
    expect(rows(requests)[0]).toMatchObject({ status: 'discarded', reason: 'unknown_marker' });
  });

  it('#156/AC-6: resposta fora do formato registra o pedido descartado', async () => {
    const { deps, requests } = setup([answerWith('texto solto')]);
    await draftSupplierRequests(deps);
    expect(rows(requests)[0]).toMatchObject({ status: 'discarded', reason: 'invalid_shape' });
  });

  it('#156/AC-8: a nota com pedido aberto não ganha um segundo', async () => {
    const requests = new MemoryRequests([existingRow('draft')]);
    const { deps } = setup([okAnswer()], { requests });
    expect(await draftSupplierRequests(deps)).toEqual({ drafted: 0, discarded: 0, refused: 0, skipped: 1 });
    expect(requests.rows).toHaveLength(1);
  });

  it('#156/AC-8: a recusa do banco ao gravar é contada, registrada só com a chave, e a rodada segue', async () => {
    const requests = new BlindRequests([existingRow('sent')]);
    const { deps, lines } = setup([okAnswer()], { requests });
    expect(await draftSupplierRequests(deps)).toEqual({ drafted: 0, discarded: 0, refused: 1, skipped: 0 });
    expect(requests.rows).toHaveLength(1);
    expect(lines).toEqual([`pedido ao fornecedor recusado, já há um aberto: ${REQUEST_KEY}`]);
  });

  it('#156/AC-6: o pedido descartado não é pedido de novo nem gravado duas vezes', async () => {
    const requests = new MemoryRequests([existingRow('discarded')]);
    const { deps } = setup([okAnswer()], { requests });
    expect(await draftSupplierRequests(deps)).toEqual({ drafted: 0, discarded: 0, refused: 0, skipped: 1 });
    expect(requests.rows).toHaveLength(1);
  });

  it('rodar duas vezes grava uma vez só', async () => {
    const { deps, requests } = setup([okAnswer()]);
    await draftSupplierRequests(deps);
    expect((await draftSupplierRequests(deps)).skipped).toBe(1);
    expect(rows(requests)).toHaveLength(1);
  });

  it('sem contato do fornecedor a sugestão é pulada, e fica para a rodada seguinte', async () => {
    const { deps, requests } = setup([okAnswer()], { contacts: { F08: null } });
    expect(await draftSupplierRequests(deps)).toEqual({ drafted: 0, discarded: 0, refused: 0, skipped: 1 });
    expect(rows(requests)).toHaveLength(0);
  });

  it('decisão fora do escopo (E6) ou chave que não é de uma decisão: nada é gravado', async () => {
    const e6 = setup([okAnswer()], { classification: 'E6' });
    expect((await draftSupplierRequests(e6.deps)).skipped).toBe(1);
    const stray = setup([{ ...okAnswer(), key: 'chave-qualquer' }, { ...okAnswer(), key: 'outra:return_note' }]);
    expect((await draftSupplierRequests(stray.deps)).skipped).toBe(2);
    expect(rows(stray.requests)).toHaveLength(0);
  });

  it('o log nunca leva o texto do Claude nem o e-mail do contato', async () => {
    const requests = new BlindRequests([existingRow('sent')]);
    const { deps, lines } = setup([answerWith({ subject: 'SEGREDO {{nota.numero}}', body: 'CORPO' })], { requests });
    await draftSupplierRequests(deps);
    expect(lines.join('\n')).not.toMatch(/SEGREDO|CORPO|fornecedor\.teste/);
  });

  it('#156/AC-1, #156/AC-6: o prazo é o dado ao Claude, mesmo se o rascunho sai depois da meia-noite de Brasília', async () => {
    const { deps, requests } = setup([]);
    const asked = await pendingSupplierRequests({ ...deps, now: () => new Date('2026-11-17T02:59:00Z') });
    const [first] = asked.requests;
    if (first === undefined) throw new Error('esperava um pedido a fazer');
    const answered = answerWith(okAnswer().output, first.input);
    const later = { ...deps, suggestions: suggestionsOf([answered]), now: () => new Date('2026-11-17T03:01:00Z') };
    expect(await draftSupplierRequests(later)).toEqual({ drafted: 1, discarded: 0, refused: 0, skipped: 0 });
    expect(rows(requests)[0]?.dueOn).toBe(DUE_ON);
  });

  it.each([
    ['sem o prazo', {}],
    ['com o prazo fora do calendário', { dueOn: '2026-02-30' }],
    ['com o prazo que não é texto', { dueOn: 20261119 }],
    ['sem entrada', null],
  ])('#156/AC-1: a sugestão %s é pulada, com o motivo invalid_input no log', async (_title, input) => {
    const { deps, requests, lines } = setup([answerWith(okAnswer().output, input)]);
    expect(await draftSupplierRequests(deps)).toEqual({ drafted: 0, discarded: 0, refused: 0, skipped: 1 });
    expect(rows(requests)).toHaveLength(0);
    expect(lines.join('\n')).toContain('motivo invalid_input');
  });
});
