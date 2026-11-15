import { describe, expect, it } from 'vitest';
import { emitReturnNote } from '../../src/returns/emit-return-note.js';
import { DomainEmitter, MemoryEmissions, pendingEntry } from './return-note-fixtures.js';

// #156: 2026-11-16T01:30Z ainda é 15/11 em Brasília (UTC-3).
const input = { id: 7, by: 'fiscal@exemplo.test', now: new Date('2026-11-16T01:30:00Z') };

describe('a emissão da devolução da fila (#156)', () => {
  it('a entrada pendente é emitida: o emissor é chamado uma vez e a fila recebe o documento com o número novo', async () => {
    const emissions = new MemoryEmissions(pendingEntry());
    const emitter = new DomainEmitter();
    const result = await emitReturnNote(input, { emissions, emitter });
    expect(result.kind).toBe('emitted');
    expect(emitter.calls).toBe(1);
    expect(emitter.requests[0]?.entryId).toBe(7);
    expect(emitter.requests[0]?.issuedOn).toBe('2026-11-15');
    expect(emissions.marked).toHaveLength(1);
    expect(emissions.marked[0]?.document.numero).toBe(107);
    expect(emissions.marked[0]?.by).toBe(input.by);
    expect(emissions.marked[0]?.at).toEqual(input.now);
    if (result.kind === 'emitted') expect(result.note.numero).toBe(107);
  });

  it('#156/AC-4: emitir de novo devolve a mesma nota, sem chamar o emissor', async () => {
    const emissions = new MemoryEmissions(pendingEntry());
    const emitter = new DomainEmitter();
    const first = await emitReturnNote(input, { emissions, emitter });
    const second = await emitReturnNote(input, { emissions, emitter });
    expect(emitter.calls).toBe(1);
    expect(second.kind).toBe('already_emitted');
    if (first.kind === 'emitted' && second.kind === 'already_emitted') {
      expect(second.note).toEqual(first.note);
    } else {
      throw new Error('esperava emitted e already_emitted');
    }
  });

  it('#156/AC-2: o valor_total da nota é o valor da devolução na fila', async () => {
    const entry = pendingEntry();
    const result = await emitReturnNote(input, { emissions: new MemoryEmissions(entry), emitter: new DomainEmitter() });
    if (result.kind !== 'emitted') throw new Error('esperava emitted');
    expect(Math.round(result.note.valor_total * 100)).toBe(entry.value.cents);
    expect(result.note.nota_referenciada).toBe(entry.invoice.accessKey);
    expect(result.note.itens.map((i) => i.codigo_fornecedor)).toEqual(['F08-001']);
  });

  it('a entrada que não existe dá not_found', async () => {
    const emitter = new DomainEmitter();
    expect(await emitReturnNote(input, { emissions: new MemoryEmissions(null), emitter })).toEqual({ kind: 'not_found' });
    expect(emitter.calls).toBe(0);
  });

  it('a entrada cancelada dá conflito e não chama o emissor', async () => {
    const emissions = new MemoryEmissions(pendingEntry());
    emissions.withStatus('cancelada');
    const emitter = new DomainEmitter();
    const result = await emitReturnNote(input, { emissions, emitter });
    expect(result.kind).toBe('conflict');
    expect(emitter.calls).toBe(0);
  });

  it('a entrada emitida à mão, sem documento, dá conflito e não chama o emissor', async () => {
    const emissions = new MemoryEmissions(pendingEntry());
    emissions.withStatus('emitida', null);
    const emitter = new DomainEmitter();
    const result = await emitReturnNote(input, { emissions, emitter });
    expect(result.kind).toBe('conflict');
    expect(emitter.calls).toBe(0);
  });

  it('perdida a corrida, devolve a nota guardada pela outra emissão como already_emitted', async () => {
    const emissions = new MemoryEmissions(pendingEntry());
    const other = await new DomainEmitter().emit({
      entryId: 7,
      lines: pendingEntry().lines,
      value: pendingEntry().value,
      invoice: pendingEntry().invoice,
      issuedOn: '2026-11-15',
    });
    emissions.beforeMark = () => emissions.winElsewhere({ ...other, numero: 999 });
    const result = await emitReturnNote(input, { emissions, emitter: new DomainEmitter() });
    expect(result.kind).toBe('already_emitted');
    if (result.kind === 'already_emitted') expect(result.note.numero).toBe(999);
    expect(emissions.marked).toHaveLength(0);
  });
});
