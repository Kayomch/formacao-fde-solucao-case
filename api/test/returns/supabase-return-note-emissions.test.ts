import { describe, expect, it } from 'vitest';
import { supabaseReturnNoteQueue } from '../../src/returns/return-notes.js';
import { erpReturnNoteOutbox } from '../../src/connectors/erp-return-note.js';
import { SupabaseRestError } from '../../src/connectors/supabase-rest.js';
import { Quantity, type ReturnNoteDocument } from '../../src/domain/index.js';
import { supabaseReturnNoteEmissions } from '../../src/returns/supabase-return-note-emissions.js';
import { approved, DomainEmitter, giveBack, invoice, ORIGIN_KEY } from './return-note-fixtures.js';
import { worldWith } from './return-note-db.js';

const NOW = new Date('2026-11-16T13:00:00Z');
const BY = 'fiscal@exemplo.test';

async function queued() {
  const origin = invoice();
  const { fake, rest } = worldWith([{ proposal: approved('E2', [giveBack('SKU-1', 10)]), invoice: origin, proposalId: 1 }]);
  const entry = await erpReturnNoteOutbox(rest).publish({
    invoiceAccessKey: ORIGIN_KEY,
    lines: [{ supplierCode: 'F08-001', quantity: Quantity.of(10, 'UN') }],
    reason: 'E2 item trocado na nota 9999: devolução do item trocado',
  });
  const emissions = supabaseReturnNoteEmissions(rest);
  const document = async (): Promise<ReturnNoteDocument> => {
    const found = await emissions.find(entry.id);
    if (found === null) throw new Error('entrada ausente');
    return new DomainEmitter().emit({
      entryId: entry.id,
      lines: found.lines,
      value: found.value,
      invoice: found.invoice,
      issuedOn: '2026-11-16',
    });
  };
  return { fake, rest, emissions, id: entry.id, document };
}

describe('o repositório das entradas da fila de devolução (#156)', () => {
  it('#156/AC-2: find monta a entrada pendente com o valor da fila da #140', async () => {
    const { rest, emissions, id } = await queued();
    const found = await emissions.find(id);
    expect(found).toMatchObject({ id, status: 'pendente', document: null });
    expect(found?.value.cents).toBe(8490);
    expect(found?.invoice.accessKey).toBe(ORIGIN_KEY);
    expect(found?.lines.map((l) => l.supplierCode)).toEqual(['F08-001']);
    const [view] = await supabaseReturnNoteQueue(rest).list('pendente', NOW);
    expect(found?.value.cents).toBe(view?.valueCents);
  });

  it('find devolve nulo para a entrada que não existe', async () => {
    const { emissions } = await queued();
    expect(await emissions.find(999)).toBeNull();
  });

  it('#156/AC-4: markEmitted numa pendente grava o estado e as cinco colunas da nota, e devolve true', async () => {
    const { fake, emissions, id, document } = await queued();
    const doc = await document();
    expect(await emissions.markEmitted(id, doc, BY, NOW)).toBe(true);
    expect(fake.rows('outbox_return_notes')[0]).toMatchObject({
      status: 'emitida',
      nfe_number: String(doc.numero),
      emitted_by: BY,
      emitted_at: NOW.toISOString(),
      note_id: doc.nota_id,
      note_access_key: doc.chave,
      note_series: doc.serie,
      note_number: doc.numero,
      note_document: doc,
    });
  });

  it('#156/AC-4: a segunda gravação devolve false e o documento não muda', async () => {
    const { fake, emissions, id, document } = await queued();
    const first = await document();
    await emissions.markEmitted(id, first, BY, NOW);
    const other = { ...first, nota_id: 'ND-0999', numero: 999 };
    expect(await emissions.markEmitted(id, other, 'outro@exemplo.test', NOW)).toBe(false);
    expect(fake.rows('outbox_return_notes')[0]?.note_document).toEqual(first);
  });

  it('markEmitted numa entrada cancelada devolve false', async () => {
    const { rest, emissions, id, document } = await queued();
    await supabaseReturnNoteQueue(rest).cancel(id, 'duplicada', BY, NOW);
    expect(await emissions.markEmitted(id, await document(), BY, NOW)).toBe(false);
  });

  it('#156/AC-4: depois da emissão pelo mock, a emissão à mão da #140 é recusada como conflito', async () => {
    const { rest, emissions, id, document } = await queued();
    await emissions.markEmitted(id, await document(), BY, NOW);
    expect(await supabaseReturnNoteQueue(rest).emit(id, '12345', BY, NOW)).toEqual({ kind: 'conflict' });
  });

  it('find devolve o documento gravado, e a entrada emitida', async () => {
    const { emissions, id, document } = await queued();
    const doc = await document();
    await emissions.markEmitted(id, doc, BY, NOW);
    expect(await emissions.find(id)).toMatchObject({ status: 'emitida', document: doc });
  });

  it('find recusa o documento gravado fora do formato, sem repetir os dados no erro', async () => {
    const { fake, emissions, id } = await queued();
    Object.assign(fake.rows('outbox_return_notes')[0] ?? {}, { status: 'emitida', note_document: { chave: 'segredo-123' } });
    const failure = await emissions.find(id).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SupabaseRestError);
    expect(failure instanceof Error ? failure.message : '').not.toContain('segredo-123');
  });

  it('#156 PER-4: todo PATCH na fila filtra por status pendente', async () => {
    const { fake, emissions, id, document } = await queued();
    await emissions.markEmitted(id, await document(), BY, NOW);
    const patches = fake.requests.filter((r) => r.method === 'PATCH' && r.url.includes('/outbox_return_notes'));
    expect(patches).toHaveLength(1);
    expect(patches.every((r) => new URL(r.url).searchParams.get('status') === 'eq.pendente')).toBe(true);
    expect(new URL(patches[0]?.url ?? '').searchParams.get('id')).toBe(`eq.${id}`);
  });
});
