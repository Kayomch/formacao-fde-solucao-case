import { describe, expect, it } from 'vitest';
import { DockAction, Proposal, AmountAtRisk, Money } from '../../src/domain/index.js';
import { publishApprovedReturnNotes } from '../../src/returns/publish-approved-return-notes.js';
import { approved, decided, giveBack, invoice, MemoryReturnNoteOutbox, ORIGIN_KEY, sourceOf } from './return-note-fixtures.js';

const setup = (items: Parameters<typeof decided>[0][]) => {
  const outbox = new MemoryReturnNoteOutbox();
  const lines: string[] = [];
  const deps = { source: sourceOf(items.map((p) => decided(p))), outbox, log: (l: string) => lines.push(l) };
  return { outbox, lines, deps };
};

describe('o Cron publica as devoluções aprovadas na fila (#156)', () => {
  it('#156/AC-2: a decisão E2 aprovada vira uma devolução só com as linhas devolver', async () => {
    const { outbox, deps } = setup([approved('E2', [giveBack('SKU-1', 10)])]);
    expect(await publishApprovedReturnNotes(deps)).toEqual({ published: 1 });
    expect(outbox.stored).toHaveLength(1);
    expect(outbox.stored[0]?.invoiceAccessKey).toBe(ORIGIN_KEY);
    expect(outbox.stored[0]?.lines.map((l) => l.supplierCode)).toEqual(['F08-001']);
  });

  it('#156/AC-2: rodar duas vezes publica uma vez só', async () => {
    const { outbox, deps } = setup([approved('E1', [giveBack('SKU-1', 10)])]);
    expect((await publishApprovedReturnNotes(deps)).published).toBe(1);
    expect((await publishApprovedReturnNotes(deps)).published).toBe(0);
    expect(outbox.stored).toHaveLength(1);
  });

  it('a decisão sem devolução não entra na fila', async () => {
    const hold = Proposal.register({
      classification: 'E1',
      dockAction: DockAction.receive(),
      level: 'regra',
      amountAtRisk: AmountAtRisk.of(Money.zero(), Money.ofCents(1)),
      justification: 'teste',
    });
    hold.approveByRule();
    const { outbox, deps } = setup([hold, approved('E8', [giveBack('SKU-1', 1)])]);
    expect(await publishApprovedReturnNotes(deps)).toEqual({ published: 0 });
    expect(outbox.stored).toHaveLength(0);
  });

  it('a decisão inconsistente com a nota é pulada, registrada só com a chave e a classificação, e a rodada segue', async () => {
    const bad = approved('E2', [giveBack('SKU-INEXISTENTE', 1)]);
    const good = approved('E3', [giveBack('SKU-1', 2)]);
    const { outbox, lines, deps } = setup([bad, good]);
    expect(await publishApprovedReturnNotes(deps)).toEqual({ published: 1 });
    expect(outbox.stored).toHaveLength(1);
    expect(lines).toEqual([`devolução pulada: nota ${ORIGIN_KEY}, classificação E2`]);
  });

  it('duas decisões da mesma nota com linhas diferentes publicam as duas', async () => {
    const other = decided(approved('E1', [giveBack('SKU-1', 3)]), invoice());
    const outbox = new MemoryReturnNoteOutbox();
    const source = sourceOf([decided(approved('E1', [giveBack('SKU-1', 10)])), other]);
    expect((await publishApprovedReturnNotes({ source, outbox })).published).toBe(2);
  });
});
