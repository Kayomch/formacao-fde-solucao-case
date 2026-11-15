import { describe, expect, it } from 'vitest';
import { erpReturnNoteOutbox } from '../../src/connectors/erp-return-note.js';
import { AmountAtRisk, DockAction, Money, Proposal } from '../../src/domain/index.js';
import { emitReturnNote } from '../../src/returns/emit-return-note.js';
import { mockReturnNoteEmitter } from '../../src/returns/mock-return-note-emitter.js';
import { publishApprovedReturnNotes } from '../../src/returns/publish-approved-return-notes.js';
import { supabaseReturnNoteQueue } from '../../src/returns/return-notes.js';
import { supabaseDecidedReturnSource } from '../../src/returns/supabase-decided-return-source.js';
import { supabaseReturnNoteEmissions } from '../../src/returns/supabase-return-note-emissions.js';
import { approved, giveBack, invoice, ORIGIN_KEY } from './return-note-fixtures.js';
import { worldWith } from './return-note-db.js';

const SECOND_KEY = '35261100000000000000550010000099981000099998';
const NOW = new Date('2026-11-16T13:00:00Z');
const BY = 'fiscal@exemplo.test';

function e3Altered() {
  const p = Proposal.register({
    classification: 'E3',
    dockAction: DockAction.receive(),
    level: 'coordenacao',
    amountAtRisk: AmountAtRisk.of(Money.ofCents(100), Money.ofCents(88_288)),
    justification: 'devolver a diferença',
  });
  p.awaitApproval();
  p.alter(DockAction.partial([giveBack('SKU-1', 2), giveBack('F08-002', 3)]), 'devolver a diferença');
  return p;
}

const world = () =>
  worldWith([
    { proposal: approved('E2', [giveBack('SKU-1', 10)]), invoice: invoice(ORIGIN_KEY, '9999'), proposalId: 1 },
    { proposal: e3Altered(), invoice: invoice(SECOND_KEY, '9998'), proposalId: 2 },
  ]);

describe('a devolução do Cron até a emissão, sobre os adaptadores reais (#156)', () => {
  it('#156/AC-2: o Cron publica a E2 aprovada e a E3 alterada, e rodar de novo não grava outra', async () => {
    const { fake, rest } = world();
    const deps = { source: supabaseDecidedReturnSource(rest), outbox: erpReturnNoteOutbox(rest) };
    expect(await publishApprovedReturnNotes(deps)).toEqual({ published: 2 });
    expect(await publishApprovedReturnNotes(deps)).toEqual({ published: 0 });
    expect(fake.rows('outbox_return_notes')).toHaveLength(2);
    const keys = fake.rows('outbox_return_notes').map((r) => r.invoice_access_key);
    expect(keys).toEqual([ORIGIN_KEY, SECOND_KEY]);
  });

  it('#156/AC-4: emitir duas vezes dá a mesma nota e uma reserva só', async () => {
    const { fake, rest } = world();
    await publishApprovedReturnNotes({ source: supabaseDecidedReturnSource(rest), outbox: erpReturnNoteOutbox(rest) });
    const deps = { emissions: supabaseReturnNoteEmissions(rest), emitter: mockReturnNoteEmitter(rest) };
    const first = await emitReturnNote({ id: 1, by: BY, now: NOW }, deps);
    const second = await emitReturnNote({ id: 1, by: BY, now: NOW }, deps);
    expect(first.kind).toBe('emitted');
    expect(second.kind).toBe('already_emitted');
    if (first.kind === 'emitted' && second.kind === 'already_emitted') expect(second.note).toEqual(first.note);
    expect(fake.rows('return_note_numbers')).toHaveLength(1);
    expect(fake.rows('outbox_return_notes')[0]).toMatchObject({ status: 'emitida' });
  });

  it('#156/AC-2: o valor_total da nota é o valor que a fila da #140 mostra para a entrada', async () => {
    const { rest } = world();
    await publishApprovedReturnNotes({ source: supabaseDecidedReturnSource(rest), outbox: erpReturnNoteOutbox(rest) });
    const deps = { emissions: supabaseReturnNoteEmissions(rest), emitter: mockReturnNoteEmitter(rest) };
    const result = await emitReturnNote({ id: 2, by: BY, now: NOW }, deps);
    const e3View = (await supabaseReturnNoteQueue(rest).list('emitida', NOW)).find((x) => x.id === 2);
    expect(result.kind).toBe('emitted');
    expect(e3View?.valueCents).toBe(Math.round(849 * 2) + Math.round(970 * 3));
    if (result.kind === 'emitted') {
      expect(Math.round(result.note.valor_total * 100)).toBe(e3View?.valueCents);
      expect(result.note.itens.map((i) => i.codigo_fornecedor)).toEqual(['F08-001', 'F08-002']);
    }
  });

  it('a entrada cancelada não é emitida: conflito, e nenhuma reserva', async () => {
    const { fake, rest } = world();
    await publishApprovedReturnNotes({ source: supabaseDecidedReturnSource(rest), outbox: erpReturnNoteOutbox(rest) });
    await supabaseReturnNoteQueue(rest).cancel(1, 'duplicada', BY, NOW);
    const deps = { emissions: supabaseReturnNoteEmissions(rest), emitter: mockReturnNoteEmitter(rest) };
    expect((await emitReturnNote({ id: 1, by: BY, now: NOW }, deps)).kind).toBe('conflict');
    expect(fake.rows('return_note_numbers')).toHaveLength(0);
  });
});
