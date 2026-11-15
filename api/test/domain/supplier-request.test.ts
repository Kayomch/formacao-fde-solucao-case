import { describe, expect, it } from 'vitest';
import {
  AmountAtRisk,
  DockAction,
  DomainError,
  Invoice,
  Money,
  Proposal,
  Quantity,
  SUPPLIER_REQUEST_OUTPUT_SCHEMA,
  asksFor,
  brasiliaDate,
  buildSupplierRequestCatalog,
  catalogKeys,
  draftSupplierRequest,
  dueOnAfter,
  factKey,
  isOpenRequest,
  returnNoteOfDecision,
  textChecks,
  type Classification,
  type FactCatalog,
  type PartialLine,
  type ReturnNote,
  type SupplierRequest,
  type SupplierRequestStatus,
} from '../../src/domain/index.js';

// #156: o pedido ao fornecedor da nota de devolução, no ramo receber parcial (E1, E2, E3).

const ORIGIN_KEY = '35261100000000000000550010000099991000099999';

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
        sku: 'SKU-2',
        description: 'Água de coco 1 L',
        quantity: Quantity.of(28, 'UN'),
        unitPrice: Money.ofCents(970),
        total: Money.ofCents(27_160),
      },
    ],
    total: Money.ofCents(88_288),
  });

const giveBack = (sku: string, amount: number): PartialLine => ({
  sku,
  quantity: Quantity.of(amount, 'UN'),
  disposition: 'devolver',
});

const decided = (classification: Classification, lines: readonly PartialLine[]): Proposal => {
  const p = Proposal.register({
    classification,
    dockAction: DockAction.partial(lines),
    level: 'regra',
    amountAtRisk: AmountAtRisk.of(Money.ofCents(100), Money.ofCents(88_288)),
    justification: 'teste',
  });
  p.approveByRule();
  return p;
};

const noteOf = (classification: Classification, lines: readonly PartialLine[]): ReturnNote => {
  const note = returnNoteOfDecision(decided(classification, lines), invoice());
  if (note === null) throw new Error('fixture: a decisão não devolve');
  return note;
};

// #156: 10 UN × R$ 8,49 = R$ 84,90 e 3 UN × R$ 9,70 = R$ 29,10: total R$ 114,00.
const LINES = [giveBack('SKU-1', 10), giveBack('SKU-2', 3)];
const QUEUE_VALUE = Money.ofCents(11_400);
const DUE_ON = '2026-11-18';

const catalog = (): FactCatalog => buildSupplierRequestCatalog(invoice(), noteOf('E2', LINES), DUE_ON, QUEUE_VALUE);

const GOOD = {
  subject: 'NF {{nota.numero}} · devolução do item trocado',
  body:
    'Olá. Na nota {{nota.numero}} (série {{nota.serie}}) veio {{devolucao.item[F08-001].quantidade}} ' +
    'de F08-001 a {{devolucao.item[F08-001].preco_unitario}}, {{devolucao.item[F08-001].valor}}. ' +
    'Total da devolução: {{devolucao.valor}}. Prazo de resposta: 2026-11-18.',
};

const draft = (raw: unknown, over: Partial<Parameters<typeof draftSupplierRequest>[0]> = {}): SupplierRequest =>
  draftSupplierRequest({
    raw,
    catalog: catalog(),
    invoiceAccessKey: ORIGIN_KEY,
    supplierId: 'F08',
    asks: asksFor('E2', noteOf('E2', LINES)),
    to: 'fiscal@fornecedor08.test',
    dueOn: DUE_ON,
    channel: 'mock',
    model: 'claude-opus-5-5',
    draftedAt: '2026-11-15T12:00:00.000Z',
    ...over,
  });

describe('o que pedir ao fornecedor, dado pela regra', () => {
  it('#156/AC-1 E1 pede, por item, entregar o que faltou ou aceitar a devolução', () => {
    expect(asksFor('E1', noteOf('E1', LINES))).toEqual([
      { kind: 'deliver_missing_or_accept_return', supplierCode: 'F08-001' },
      { kind: 'deliver_missing_or_accept_return', supplierCode: 'F08-002' },
    ]);
  });

  it('#156/AC-1 E2 pede, por item, retirar o item trocado e entregar o item pedido', () => {
    expect(asksFor('E2', noteOf('E2', LINES))).toEqual([
      { kind: 'withdraw_swapped_item', supplierCode: 'F08-001' },
      { kind: 'deliver_ordered_item', supplierCode: 'F08-001' },
      { kind: 'withdraw_swapped_item', supplierCode: 'F08-002' },
      { kind: 'deliver_ordered_item', supplierCode: 'F08-002' },
    ]);
  });

  it('#156/AC-1 E3 pede ciência da devolução de cada item e um abatimento no título da nota', () => {
    expect(asksFor('E3', noteOf('E3', [giveBack('SKU-1', 10)]))).toEqual([
      { kind: 'acknowledge_return', supplierCode: 'F08-001' },
      { kind: 'offset_title', supplierCode: null },
    ]);
  });

  it('recusa uma classificação que não devolve', () => {
    expect(() => asksFor('E4', noteOf('E2', LINES))).toThrow(DomainError);
  });
});

describe('prazo de resposta', () => {
  it('#156/AC-1 são 3 dias úteis depois do dia do rascunho', () => {
    expect(dueOnAfter('2026-11-11')).toBe('2026-11-16'); // #156: quarta: quinta, sexta, segunda
    expect(dueOnAfter('2026-11-13')).toBe('2026-11-18'); // #156: sexta
  });

  it('fim de semana conta a partir da segunda', () => {
    expect(dueOnAfter('2026-11-14')).toBe('2026-11-18'); // #156: sábado
    expect(dueOnAfter('2026-11-15')).toBe('2026-11-18'); // #156: domingo
  });

  it('recusa uma data fora de AAAA-MM-DD', () => {
    expect(() => dueOnAfter('15/11/2026')).toThrow(DomainError);
  });

  it('recusa uma data que não existe no calendário', () => {
    expect(() => dueOnAfter('2026-02-30')).toThrow(DomainError);
    expect(() => dueOnAfter('2026-13-01')).toThrow(DomainError);
  });

  it('o dia do rascunho é o de Brasília, não o do UTC', () => {
    expect(brasiliaDate('2026-11-16T01:30:00.000Z')).toBe('2026-11-15');
    expect(brasiliaDate('2026-11-15T12:00:00.000Z')).toBe('2026-11-15');
  });
});

describe('catálogo de fatos do pedido ao fornecedor', () => {
  it('#156/AC-6 traz a nota de origem e a devolução como estão no banco', () => {
    const { facts } = catalog();
    expect(facts['nota.numero']?.value).toBe('9999');
    expect(facts['nota.serie']?.value).toBe('1');
    expect(facts['nota.item[F08-001].quantidade']?.value).toBe('72 UN');
    expect(facts['devolucao.item[F08-001].quantidade']).toMatchObject({ value: '10 UN', source: 'return_note' });
    expect(facts['devolucao.item[F08-001].preco_unitario']?.value).toBe(Money.ofCents(849).toString());
    expect(facts['devolucao.item[F08-001].valor']?.value).toBe(Money.ofCents(8490).toString());
    expect(facts['devolucao.item[F08-002].valor']?.value).toBe(Money.ofCents(2910).toString());
    expect(facts['devolucao.valor']?.value).toBe(QUEUE_VALUE.toString());
  });

  it('#156/AC-6 o total da devolução tem de ser o valor da fila', () => {
    expect(() => buildSupplierRequestCatalog(invoice(), noteOf('E2', LINES), DUE_ON, Money.ofCents(11_401))).toThrow(DomainError);
  });

  it('lista os identificadores que podem aparecer sem marcador, e nenhum número de quantidade ou valor', () => {
    const { identifiers } = catalog();
    expect(identifiers).toEqual(
      expect.arrayContaining([ORIGIN_KEY, 'F08', 'F08-001', 'F08-002', 'SKU-1', 'SKU-2', 'LJ-001', '2026-11-10', DUE_ON]),
    );
    expect(identifiers).not.toContain('9999');
  });

  it('toda chave segue o esquema documentado em domain/dossier.ts', () => {
    const contract =
      /^(nota\.(numero|serie)|nota\.item\[[^\]]+\]\.(quantidade|preco_unitario|total)|devolucao\.valor|devolucao\.item\[[^\]]+\]\.(quantidade|preco_unitario|valor))$/;
    for (const key of catalogKeys(catalog())) expect(key).toMatch(contract);
    expect(factKey.returnTotal()).toBe('devolucao.valor');
    expect(factKey.returnItem('A1', 'preco_unitario')).toBe('devolucao.item[A1].preco_unitario');
  });
});

describe('o verificador do dossiê é o mesmo', () => {
  it('textChecks continua conferindo marcador e número fora de marcador', () => {
    const c = catalog();
    const allowed = new Set(c.identifiers);
    expect(textChecks('Total {{devolucao.valor}}', c, allowed)).toBe(true);
    expect(textChecks('Total 40 UN', c, allowed)).toBe(false);
    expect(textChecks('Total {{devolucao.nao_existe}}', c, allowed)).toBe(false);
  });
});

describe('rascunho do e-mail', () => {
  it('#156/AC-1 nasce em rascunho, com o texto renderizado com os valores do banco', () => {
    const r = draft(GOOD);
    expect(r.status).toBe('draft');
    if (r.status !== 'draft') return;
    expect(r).toMatchObject({
      requestType: 'return_note',
      invoiceAccessKey: ORIGIN_KEY,
      supplierId: 'F08',
      to: 'fiscal@fornecedor08.test',
      dueOn: DUE_ON,
      channel: 'mock',
      model: 'claude-opus-5-5',
      draftedAt: '2026-11-15T12:00:00.000Z',
    });
    expect(r.asks).toEqual(asksFor('E2', noteOf('E2', LINES)));
    expect(r.subject).toBe('NF 9999 · devolução do item trocado');
    expect(r.body).toContain(`Total da devolução: ${QUEUE_VALUE.toString()}.`);
    expect(r.body).toContain('veio 10 UN de F08-001');
    expect(r.body).not.toContain('{{');
  });

  it('#156/AC-6 um número fora de marcador descarta o rascunho e registra o motivo', () => {
    const r = draft({ ...GOOD, body: 'Devolvemos 40 UN de F08-001. Nota {{nota.numero}}.' });
    expect(r).toMatchObject({ status: 'discarded', reason: 'number_outside_marker' });
    expect(r).not.toHaveProperty('subject');
    expect(r).not.toHaveProperty('body');
  });

  it('#156/AC-6 um número por extenso fora de marcador também descarta', () => {
    expect(draft({ ...GOOD, body: 'Devolvemos quarenta unidades. Nota {{nota.numero}}.' })).toMatchObject({
      status: 'discarded',
      reason: 'number_outside_marker',
    });
  });

  it('#156/AC-6 um marcador que o catálogo não tem descarta o rascunho', () => {
    expect(draft({ ...GOOD, body: 'Valor {{devolucao.desconto}}. Nota {{nota.numero}}.' })).toMatchObject({
      status: 'discarded',
      reason: 'unknown_marker',
    });
  });

  it('#156/AC-6 um número ou marcador inválido no assunto também descarta', () => {
    expect(draft({ ...GOOD, subject: 'NF {{nota.numero}} de 40 UN' })).toMatchObject({ status: 'discarded', reason: 'number_outside_marker' });
    expect(draft({ ...GOOD, subject: 'NF {{nota.numero}} {{x}}' })).toMatchObject({ status: 'discarded', reason: 'unknown_marker' });
  });

  it('#156/AC-6 o motivo é um código fechado: nunca traz o texto do Claude', () => {
    const r = draft({ ...GOOD, body: 'Devolvemos 40 UN de SEGREDO. {{nota.numero}}' });
    expect(r.status).toBe('discarded');
    expect(JSON.stringify(r)).not.toContain('SEGREDO');
  });

  it('o assunto sem o número da nota de origem é descartado', () => {
    expect(draft({ ...GOOD, subject: 'Devolução do item trocado' })).toMatchObject({
      status: 'discarded',
      reason: 'subject_without_invoice_number',
    });
  });

  it('uma resposta fora do formato é descartada', () => {
    for (const raw of [null, 'texto', [], { subject: 'NF {{nota.numero}}' }, { ...GOOD, body: 7 }, { ...GOOD, body: '  ' }]) {
      expect(draft(raw)).toMatchObject({ status: 'discarded', reason: 'invalid_shape' });
    }
  });

  it('o Claude escreve só o assunto e o corpo: campo a mais nunca é copiado', () => {
    const r = draft({
      ...GOOD,
      to: 'atacante@fora.test',
      asks: [{ kind: 'offset_title', supplierCode: null }],
      due_on: '2030-01-01',
      status: 'sent',
    });
    expect(r.status).toBe('draft');
    expect(r).toMatchObject({ to: 'fiscal@fornecedor08.test', dueOn: DUE_ON });
    expect(r.asks).toEqual(asksFor('E2', noteOf('E2', LINES)));
    expect(Object.keys(SUPPLIER_REQUEST_OUTPUT_SCHEMA.properties).sort()).toEqual(['body', 'subject']);
    expect(SUPPLIER_REQUEST_OUTPUT_SCHEMA.additionalProperties).toBe(false);
  });

  it('o descartado guarda o que a regra pôs, para a pessoa ver o que pedimos', () => {
    expect(draft(null)).toMatchObject({
      requestType: 'return_note',
      invoiceAccessKey: ORIGIN_KEY,
      supplierId: 'F08',
      dueOn: DUE_ON,
      channel: 'mock',
      model: 'claude-opus-5-5',
      draftedAt: '2026-11-15T12:00:00.000Z',
    });
  });
});

describe('pedido aberto', () => {
  it.each<[SupplierRequestStatus, boolean]>([
    ['draft', true],
    ['sent', true],
    ['discarded', false],
    ['send_failed', true],
  ])('#156/AC-8 %s: aberto é %s', (status, open) => {
    expect(isOpenRequest(status)).toBe(open);
  });
});
