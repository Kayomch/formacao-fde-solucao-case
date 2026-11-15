import { describe, expect, it } from 'vitest';
import { erpReturnNoteOutbox } from '../../src/connectors/erp-return-note.js';
import { Money, Quantity } from '../../src/domain/index.js';
import { mockReturnNoteEmitter } from '../../src/returns/mock-return-note-emitter.js';
import { approved, giveBack, invoice, ORIGIN_KEY } from './return-note-fixtures.js';
import { worldWith } from './return-note-db.js';

async function twoEntries() {
  const { fake, rest } = worldWith([{ proposal: approved('E2', [giveBack('SKU-1', 10)]), invoice: invoice(), proposalId: 1 }]);
  const outbox = erpReturnNoteOutbox(rest);
  const lines = (n: number) => [{ supplierCode: 'F08-001', quantity: Quantity.of(n, 'UN') }];
  const a = await outbox.publish({ invoiceAccessKey: ORIGIN_KEY, lines: lines(10), reason: 'a' });
  const b = await outbox.publish({ invoiceAccessKey: ORIGIN_KEY, lines: lines(5), reason: 'b' });
  const request = (entryId: number, amount: number) => ({
    entryId,
    lines: lines(amount),
    value: Money.ofCents(849 * amount),
    invoice: invoice(),
    issuedOn: '2026-11-16',
  });
  return { fake, rest, a, b, request };
}

describe('o emissor mock da nota de devolução (#156)', () => {
  it('#156/AC-4 T1: emitir duas vezes a mesma entrada reusa o número e deixa uma reserva', async () => {
    const { fake, rest, a, request } = await twoEntries();
    const emitter = mockReturnNoteEmitter(rest);
    const first = await emitter.emit(request(a.id, 10));
    const second = await emitter.emit(request(a.id, 10));
    expect(second.numero).toBe(first.numero);
    expect(second.chave).toBe(first.chave);
    expect(fake.rows('return_note_numbers')).toHaveLength(1);
  });

  it('#156/AC-4 T1: duas emissões em paralelo da mesma entrada terminam com o mesmo número e uma reserva', async () => {
    const { fake, rest, a, request } = await twoEntries();
    const emitter = mockReturnNoteEmitter(rest);
    const [x, y] = await Promise.all([emitter.emit(request(a.id, 10)), emitter.emit(request(a.id, 10))]);
    expect(x.numero).toBe(y.numero);
    expect(fake.rows('return_note_numbers')).toHaveLength(1);
  });

  it('T1: entradas diferentes ganham números diferentes', async () => {
    const { rest, a, b, request } = await twoEntries();
    const emitter = mockReturnNoteEmitter(rest);
    const x = await emitter.emit(request(a.id, 10));
    const y = await emitter.emit(request(b.id, 5));
    expect(x.numero).not.toBe(y.numero);
  });

  it('#156/AC-2: a nota sai no formato do kit, com a série própria, o emitente fictício e o valor da fila', async () => {
    const { rest, a, request } = await twoEntries();
    const note = await mockReturnNoteEmitter(rest).emit(request(a.id, 10));
    expect(note).toMatchObject({
      serie: 2,
      emitente: '99999090910270',
      natureza: 'devolucao',
      nota_referenciada: ORIGIN_KEY,
      fornecedor_id: 'F08',
      destino: 'LJ-001',
      data_emissao: '2026-11-16',
      valor_total: 84.9,
    });
    expect(note.nota_id).toBe(`ND-${String(note.numero).padStart(4, '0')}`);
    expect(note.chave).toMatch(/^35261199999090910270550020000000\d{2}1\d{9}$/);
  });

  it('a configuração troca a UF, a série e o emitente', async () => {
    const { rest, a, request } = await twoEntries();
    const note = await mockReturnNoteEmitter(rest, { ufCode: '41', series: 7, issuerCnpj: '12345678000195' }).emit(request(a.id, 10));
    expect(note).toMatchObject({ serie: 7, emitente: '12345678000195' });
    expect(note.chave.startsWith('412611')).toBe(true);
  });
});
