import { describe, expect, it } from 'vitest';
import { AmountAtRisk, DockAction, Money, Proposal } from '../../src/domain/index.js';
import { pendingSupplierRequests } from '../../src/returns/pending-supplier-requests.js';
import { approved, decided, giveBack, ORIGIN_KEY, sourceOf } from './return-note-fixtures.js';
import { CONTACT, contactsOf, existingRow, MemoryRequests, NOW, queueOf, REQUEST_KEY } from './supplier-request-fixtures.js';

const VALUE = Money.ofCents(8490);

const setup = (
  proposals: Parameters<typeof decided>[0][],
  over: { contacts?: Record<string, string | null>; queue?: Record<string, Money>; requests?: MemoryRequests } = {},
) => {
  const lines: string[] = [];
  const deps = {
    source: sourceOf(proposals.map((p) => decided(p))),
    queue: queueOf(over.queue ?? { [ORIGIN_KEY]: VALUE }),
    requests: over.requests ?? new MemoryRequests(),
    contacts: contactsOf(over.contacts ?? { F08: CONTACT }),
    now: () => NOW,
    log: (l: string) => lines.push(l),
  };
  return { deps, lines };
};

describe('o que falta pedir ao fornecedor (#156)', () => {
  it.each(['E1', 'E2', 'E3'] as const)('#156/AC-1: a decisão %s aprovada, na fila e com contato vira um pedido com a chave estável', async (classification) => {
    const { deps } = setup([approved(classification, [giveBack('SKU-1', 10)])]);
    const { requests, dropped } = await pendingSupplierRequests(deps);
    expect(dropped).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.key).toBe(REQUEST_KEY);
    expect(requests[0]?.input).toMatchObject({
      invoiceAccessKey: ORIGIN_KEY,
      supplierId: 'F08',
      classification,
      dueOn: '2026-11-19',
    });
    expect(requests[0]?.input.asks.length).toBeGreaterThan(0);
    expect(requests[0]?.input.catalog.map((c) => c.key)).toContain('devolucao.valor');
  });

  it.each(['draft', 'sent', 'send_failed', 'discarded'] as const)(
    '#156/AC-8: a nota com pedido %s não é perguntada de novo ao Claude (o descartado só se refaz pelo botão)',
    async (status) => {
      const { deps } = setup([approved('E1', [giveBack('SKU-1', 10)])]);
      deps.requests.rows.push(existingRow(status));
      expect((await pendingSupplierRequests(deps)).requests).toEqual([]);
    },
  );

  it('sem contato do fornecedor a nota é pulada, registrada só com a chave, e volta na rodada seguinte', async () => {
    const { deps, lines } = setup([approved('E1', [giveBack('SKU-1', 10)])], { contacts: { F08: null } });
    expect((await pendingSupplierRequests(deps)).requests).toEqual([]);
    expect(lines).toEqual([`pedido ao fornecedor pulado: ${REQUEST_KEY}, motivo no_contact`]);
    const withContact = setup([approved('E1', [giveBack('SKU-1', 10)])]);
    expect((await pendingSupplierRequests(withContact.deps)).requests).toHaveLength(1);
  });

  it('sem entrada na fila, ou com a entrada cancelada, não há pedido', async () => {
    const { deps } = setup([approved('E1', [giveBack('SKU-1', 10)])], { queue: {} });
    expect((await pendingSupplierRequests(deps)).requests).toEqual([]);
  });

  it('fora do escopo (E6, recusar, receber integral, segurar) não gera pedido', async () => {
    const hold = Proposal.register({
      classification: 'E1',
      dockAction: DockAction.partial([{ sku: 'SKU-1', quantity: giveBack('SKU-1', 1).quantity, disposition: 'segurar' }]),
      level: 'regra',
      amountAtRisk: AmountAtRisk.of(Money.zero(), Money.ofCents(1)),
      justification: 'teste',
    });
    hold.approveByRule();
    const receive = Proposal.register({
      classification: 'E1',
      dockAction: DockAction.receive(),
      level: 'regra',
      amountAtRisk: AmountAtRisk.of(Money.zero(), Money.ofCents(1)),
      justification: 'teste',
    });
    receive.approveByRule();
    const { deps } = setup([approved('E6', [giveBack('SKU-1', 10)]), hold, receive]);
    expect((await pendingSupplierRequests(deps)).requests).toEqual([]);
  });

  it('a decisão que não bate com a nota é pulada, registrada com a chave e a classificação, e a rodada segue', async () => {
    const { deps, lines } = setup([approved('E2', [giveBack('SKU-INEXISTENTE', 1)])]);
    expect((await pendingSupplierRequests(deps)).requests).toEqual([]);
    expect(lines).toEqual([`pedido ao fornecedor pulado: ${REQUEST_KEY}, classificação E2, motivo inconsistent`]);
  });

  it('o log nunca leva o e-mail do contato', async () => {
    const { deps, lines } = setup([approved('E2', [giveBack('SKU-INEXISTENTE', 1)])]);
    await pendingSupplierRequests(deps);
    expect(lines.join('\n')).not.toContain(CONTACT);
  });
});
