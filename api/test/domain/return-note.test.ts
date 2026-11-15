import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AmountAtRisk,
  DockAction,
  DomainError,
  Invoice,
  Money,
  Proposal,
  Quantity,
  Title,
  accessKeyCheckDigit,
  issueReturnNote,
  returnAccessKey,
  returnNoteOfDecision,
  type Classification,
  type PartialLine,
  type Unit,
} from '../../src/domain/index.js';
import { e3ReturnNote } from '../../src/domain/checks/e3-quantidade-menor.js';

const ORIGIN_KEY = '35261100000000000000550010000099991000099999';
const ISSUER = '12345678000195';

const invoice = (): Invoice =>
  Invoice.receive({
    accessKey: ORIGIN_KEY,
    number: '9999',
    series: '1',
    supplierId: 'F08',
    store: 'LJ-001',
    issuedOn: '2026-11-10',
    purchaseOrderRef: 'OC-1',
    entryChannel: 'SEFAZ',
    items: [
      {
        supplierCode: 'F08-001',
        sku: 'SKU-1',
        description: 'Refrigerante cola 2 L',
        quantity: Quantity.of(72, 'UN'),
        unitPrice: Money.ofCents(849),
        total: Money.ofCents(61_128),
      },
      {
        supplierCode: 'F08-002',
        sku: null,
        description: 'Água de coco 1 L',
        quantity: Quantity.of(28, 'UN'),
        unitPrice: Money.ofCents(970),
        total: Money.ofCents(27_160),
      },
    ],
    total: Money.ofCents(88_288),
  });

const approved = (classification: Classification, lines: readonly PartialLine[], how: 'rule' | 'altered' = 'rule'): Proposal => {
  const p = Proposal.register({
    classification,
    dockAction: DockAction.partial(lines),
    level: how === 'rule' ? 'regra' : 'analista',
    amountAtRisk: AmountAtRisk.of(Money.ofCents(100), Money.ofCents(88_288)),
    justification: 'teste',
  });
  if (how === 'rule') p.approveByRule();
  else {
    p.awaitApproval();
    p.alter(DockAction.partial(lines), 'contagem física');
  }
  return p;
};

const giveBack = (sku: string, amount: number, unit: Unit = 'UN'): PartialLine => ({
  sku,
  quantity: Quantity.of(amount, unit),
  disposition: 'devolver',
});
const hold = (sku: string, amount: number): PartialLine => ({
  sku,
  quantity: Quantity.of(amount, 'UN'),
  disposition: 'segurar',
});

describe('nota de devolução da decisão', () => {
  it('devolve só as linhas devolver, pelo código do fornecedor da nota de origem', () => {
    const note = returnNoteOfDecision(approved('E2', [giveBack('SKU-1', 10), giveBack('F08-002', 3), hold('SKU-9', 1)]), invoice());
    expect(note).not.toBeNull();
    expect(note?.invoiceAccessKey).toBe(ORIGIN_KEY);
    expect(note?.lines.map((l) => [l.supplierCode, l.quantity.amount])).toEqual([
      ['F08-001', 10],
      ['F08-002', 3],
    ]);
  });

  it('a justificativa é a mesma para a mesma decisão e cita a classificação e a nota', () => {
    const a = returnNoteOfDecision(approved('E2', [giveBack('SKU-1', 10)]), invoice());
    const b = returnNoteOfDecision(approved('E2', [giveBack('SKU-1', 10)]), invoice());
    expect(a?.reason).toBe(b?.reason);
    expect(a?.reason).toContain('E2');
    expect(a?.reason).toContain('9999');
  });

  it('a proposta alterada por uma pessoa, em E1 ou E3, também devolve', () => {
    expect(returnNoteOfDecision(approved('E1', [giveBack('SKU-1', 5)], 'altered'), invoice())).not.toBeNull();
    expect(returnNoteOfDecision(approved('E3', [giveBack('SKU-1', 5)], 'altered'), invoice())).not.toBeNull();
  });

  it('as razões de E1 e E2 seguem o estilo da E3', () => {
    expect(returnNoteOfDecision(approved('E1', [giveBack('SKU-1', 5)]), invoice())?.reason).toBe(
      'E1 falta física na nota 9999: devolução do que faltou',
    );
    expect(returnNoteOfDecision(approved('E2', [giveBack('SKU-1', 5)]), invoice())?.reason).toBe(
      'E2 item trocado na nota 9999: devolução do item trocado',
    );
  });

  it('a E3 aprovada dá a mesma nota por returnNoteOfDecision e por e3ReturnNote, para o hash da fila bater', () => {
    const proposal = approved('E3', [giveBack('SKU-1', 10)]);
    const line = {
      supplierCode: 'F08-001',
      sku: 'SKU-1',
      invoiced: Quantity.of(72, 'UN'),
      counted: Quantity.of(62, 'UN'),
      missing: Quantity.of(10, 'UN'),
    };
    const title = Title.post({ invoiceAccessKey: ORIGIN_KEY, amount: Money.ofCents(88_288), dueOn: '2026-12-10' });
    const canonical = returnNoteOfDecision(proposal, invoice());
    const fromE3 = e3ReturnNote(proposal, title, invoice(), [line]);
    expect(canonical).toEqual(fromE3);
    expect(JSON.stringify(canonical)).toBe(JSON.stringify(fromE3));
  });

  it('não devolve de outra classificação', () => {
    expect(returnNoteOfDecision(approved('E4', [giveBack('SKU-1', 5)]), invoice())).toBeNull();
  });

  it('não devolve proposta ainda não decidida', () => {
    const p = Proposal.register({
      classification: 'E3',
      dockAction: DockAction.partial([giveBack('SKU-1', 5)]),
      level: 'analista',
      amountAtRisk: AmountAtRisk.of(Money.ofCents(100), Money.ofCents(88_288)),
      justification: 'x',
    });
    expect(returnNoteOfDecision(p, invoice())).toBeNull();
    p.awaitApproval();
    expect(returnNoteOfDecision(p, invoice())).toBeNull();
  });

  it('não devolve quando a ação não é receber parcial', () => {
    const p = Proposal.register({
      classification: 'E2',
      dockAction: DockAction.refuse(),
      level: 'regra',
      amountAtRisk: AmountAtRisk.of(Money.ofCents(100), Money.ofCents(88_288)),
      justification: 'x',
    });
    p.approveByRule();
    expect(returnNoteOfDecision(p, invoice())).toBeNull();
  });

  it('não devolve quando só há linhas segurar', () => {
    expect(returnNoteOfDecision(approved('E1', [hold('SKU-1', 5)]), invoice())).toBeNull();
  });

  it('recusa linha devolver que não está na nota', () => {
    expect(() => returnNoteOfDecision(approved('E2', [giveBack('SKU-X', 1)]), invoice())).toThrow(DomainError);
  });

  it('recusa linha devolver em unidade diferente da do item', () => {
    expect(() => returnNoteOfDecision(approved('E2', [giveBack('SKU-1', 1, 'CX')]), invoice())).toThrow(DomainError);
  });

  it('recusa linha devolver acima da quantidade do item', () => {
    expect(() => returnNoteOfDecision(approved('E2', [giveBack('SKU-1', 73)]), invoice())).toThrow(DomainError);
  });
});

describe('chave de acesso da NF-e', () => {
  it('o dígito verificador (módulo 11) bate com a chave de exemplo do manual da NF-e', () => {
    const exemplo = '35080599999090910270550010000000015180051273';
    expect(accessKeyCheckDigit(exemplo.slice(0, 43))).toBe(exemplo.slice(43));
  });

  it('o layout bate com o das chaves do kit: modelo 55 e emissão normal nas mesmas posições', () => {
    const notas: unknown = JSON.parse(readFileSync(new URL('../../../data/kit/notas.json', import.meta.url), 'utf8'));
    if (!Array.isArray(notas)) throw new Error('notas.json não é uma lista');
    const keys = notas.map((n: unknown): string => {
      const key = typeof n === 'object' && n !== null && 'chave' in n ? n.chave : undefined; // ADR-001
      if (typeof key !== 'string') throw new Error('notas.json: nota sem chave'); // ADR-001
      return key;
    });
    const nossa = returnAccessKey({ ufCode: '35', issuedOn: '2026-11-15', issuerCnpj: ISSUER, series: 1, number: 12 });
    expect(keys.length).toBeGreaterThan(0);
    for (const kitKey of keys) {
      expect(kitKey).toHaveLength(44);
      expect(kitKey.slice(20, 22)).toBe(nossa.slice(20, 22));
      expect(kitKey.slice(34, 35)).toBe(nossa.slice(34, 35));
    }
  });

  it('monta 44 dígitos com UF, AAMM, CNPJ, modelo 55, série, número e emissão normal', () => {
    const key = returnAccessKey({ ufCode: '35', issuedOn: '2026-11-15', issuerCnpj: ISSUER, series: 1, number: 12 });
    expect(key).toMatch(/^\d{44}$/);
    expect(key.slice(0, 20)).toBe(`352611${ISSUER}`);
    expect(key.slice(20, 35)).toBe('550010000000121');
    expect(accessKeyCheckDigit(key.slice(0, 43))).toBe(key.slice(43));
  });

  it('é determinística: as mesmas partes dão a mesma chave, outro número dá outra', () => {
    const parts = { ufCode: '35', issuedOn: '2026-11-15', issuerCnpj: ISSUER, series: 1, number: 12 };
    expect(returnAccessKey(parts)).toBe(returnAccessKey(parts));
    expect(returnAccessKey({ ...parts, number: 13 })).not.toBe(returnAccessKey(parts));
  });

  it('recusa CNPJ que não tem 14 dígitos', () => {
    expect(() => returnAccessKey({ ufCode: '35', issuedOn: '2026-11-15', issuerCnpj: '123', series: 1, number: 1 })).toThrow(DomainError);
  });

  it('recusa série e número fora da faixa', () => {
    const base = { ufCode: '35', issuedOn: '2026-11-15', issuerCnpj: ISSUER, series: 1, number: 1 };
    expect(() => returnAccessKey({ ...base, series: 1000 })).toThrow(DomainError);
    expect(() => returnAccessKey({ ...base, series: 0 })).toThrow(DomainError);
    expect(() => returnAccessKey({ ...base, number: 1_000_000_000 })).toThrow(DomainError);
    expect(() => returnAccessKey({ ...base, number: 0 })).toThrow(DomainError);
  });
});

describe('nota de devolução emitida, no formato do kit', () => {
  const key = returnAccessKey({ ufCode: '35', issuedOn: '2026-11-15', issuerCnpj: ISSUER, series: 1, number: 12 });
  const emit = (over: Partial<Parameters<typeof issueReturnNote>[0]> = {}) =>
    issueReturnNote({
      queue: {
        lines: [
          { supplierCode: 'F08-001', quantity: Quantity.of(10, 'UN') },
          { supplierCode: 'F08-002', quantity: Quantity.of(3, 'UN') },
        ],
        value: Money.ofCents(8490 + 2910),
      },
      invoice: invoice(),
      issuerCnpj: ISSUER,
      number: 12,
      series: 1,
      accessKey: key,
      issuedOn: '2026-11-15',
      ...over,
    });

  it('#156/AC-2: segue o formato do kit, cita a nota de origem e traz só as linhas devolvidas', () => {
    const note = emit();
    expect(note).toEqual({
      nota_id: 'ND-0012',
      chave: key, // ADR-001
      numero: 12,
      serie: 1,
      emitente: ISSUER,
      fornecedor_id: 'F08',
      destino: 'LJ-001',
      data_emissao: '2026-11-15',
      nota_referenciada: ORIGIN_KEY,
      natureza: 'devolucao',
      itens: [
        { codigo_fornecedor: 'F08-001', sku: 'SKU-1', descricao: 'Refrigerante cola 2 L', quantidade: 10, unidade: 'UN', preco_unitario: 8.49, valor: 84.9 },
        { codigo_fornecedor: 'F08-002', sku: null, descricao: 'Água de coco 1 L', quantidade: 3, unidade: 'UN', preco_unitario: 9.7, valor: 29.1 },
      ],
      valor_total: 114,
    });
  });

  it('#156/AC-2: o valor_total em centavos bate com o valor da devolução na fila', () => {
    expect(emit().valor_total * 100).toBeCloseTo(11_400, 6);
  });

  it('#156/AC-2: o valor de uma linha com quantidade fracionária arredonda como a fila da #140', () => {
    const note = emit({
      queue: { lines: [{ supplierCode: 'F08-001', quantity: Quantity.of(0.5, 'UN') }], value: Money.ofCents(Math.round(849 * 0.5)) },
    });
    expect(note.itens[0]?.valor).toBe(4.25);
    expect(note.valor_total).toBe(4.25);
  });

  it('é JSON puro: sobrevive a serializar e ler de volta', () => {
    const note = emit();
    expect(JSON.parse(JSON.stringify(note))).toEqual(note);
  });

  it('recusa linha que não está na nota de origem', () => {
    expect(() => emit({ queue: { lines: [{ supplierCode: 'F99-001', quantity: Quantity.of(1, 'UN') }], value: Money.ofCents(100) } })).toThrow(DomainError);
  });

  it('recusa chave que não tem 44 dígitos', () => {
    expect(() => emit({ accessKey: '123' })).toThrow(DomainError);
  });

  it('#156/AC-2: recusa valor_total diferente do valor da devolução na fila', () => {
    expect(() => emit({ queue: { lines: [{ supplierCode: 'F08-001', quantity: Quantity.of(10, 'UN') }], value: Money.ofCents(1) } })).toThrow(DomainError);
  });

  it('a mesma entrada da fila com o mesmo número e chave dá o mesmo documento', () => {
    expect(emit()).toEqual(emit());
  });
});
