// #156: a nota de origem, as propostas e os dublês das portas dos casos de uso da devolução.
import type { Published, ReturnNoteMessage, ReturnNoteOutbox } from '../../src/connectors/ports.js';
import {
  AmountAtRisk,
  DockAction,
  Invoice,
  Money,
  Proposal,
  Quantity,
  issueReturnNote,
  returnAccessKey,
  type Classification,
  type PartialLine,
  type ReturnNoteDocument,
} from '../../src/domain/index.js';
import type {
  DecidedReturn,
  DecidedReturnSource,
  ReturnNoteEmitter,
  ReturnNoteEmissions,
  ReturnNoteEntry,
} from '../../src/returns/ports.js';

export const ORIGIN_KEY = '35261100000000000000550010000099991000099999';
export const ISSUER = '12345678000195';

export const invoice = (accessKey = ORIGIN_KEY, number = '9999'): Invoice =>
  Invoice.receive({
    accessKey,
    number,
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

export const giveBack = (sku: string, amount: number): PartialLine => ({
  sku,
  quantity: Quantity.of(amount, 'UN'),
  disposition: 'devolver',
});

export const approved = (classification: Classification, lines: readonly PartialLine[]): Proposal => {
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

export const decided = (proposal: Proposal, origin: Invoice = invoice()): DecidedReturn => ({ proposal, invoice: origin });

export const sourceOf = (items: readonly DecidedReturn[]): DecidedReturnSource => ({ listDecided: async () => items });

/** #156: caixa de saída em memória, idempotente pelo conteúdo como a real (#59). */
export class MemoryReturnNoteOutbox implements ReturnNoteOutbox {
  readonly stored: Published<ReturnNoteMessage>[] = [];
  async publish(message: ReturnNoteMessage): Promise<Published<ReturnNoteMessage>> {
    const same = this.stored.find((m) => JSON.stringify([m.invoiceAccessKey, m.lines, m.reason]) === JSON.stringify([message.invoiceAccessKey, message.lines, message.reason]));
    if (same) return same;
    const published = { ...message, id: this.stored.length + 1, publishedAt: '2026-11-15T10:00:00Z' };
    this.stored.push(published);
    return published;
  }
  async list(): Promise<Published<ReturnNoteMessage>[]> {
    return [...this.stored];
  }
}

/** #156/AC-4: o emissor de teste, sobre o `issueReturnNote` do domínio, como o mock da camada seguinte. */
export class DomainEmitter implements ReturnNoteEmitter {
  calls = 0;
  readonly requests: Parameters<ReturnNoteEmitter['emit']>[0][] = [];
  async emit(request: Parameters<ReturnNoteEmitter['emit']>[0]): Promise<ReturnNoteDocument> {
    this.calls += 1;
    this.requests.push(request);
    const number = 100 + request.entryId;
    const accessKey = returnAccessKey({ ufCode: '35', issuedOn: request.issuedOn, issuerCnpj: ISSUER, series: 1, number });
    return issueReturnNote({
      queue: { lines: request.lines, value: request.value },
      invoice: request.invoice,
      issuerCnpj: ISSUER,
      number,
      series: 1,
      accessKey,
      issuedOn: request.issuedOn,
    });
  }
}

export const pendingEntry = (id = 7): ReturnNoteEntry => ({
  id,
  status: 'pendente',
  lines: [{ supplierCode: 'F08-001', quantity: Quantity.of(10, 'UN') }],
  value: Money.ofCents(8490),
  invoice: invoice(),
  document: null,
});

/** #156/AC-4: repositório em memória; `beforeMark` deixa outra emissão ganhar a corrida. */
export class MemoryEmissions implements ReturnNoteEmissions {
  readonly marked: { id: number; document: ReturnNoteDocument; by: string; at: Date }[] = [];
  beforeMark: (() => void) | null = null;
  constructor(private entry: ReturnNoteEntry | null) {}
  async find(id: number): Promise<ReturnNoteEntry | null> {
    return this.entry && this.entry.id === id ? this.entry : null;
  }
  async markEmitted(id: number, document: ReturnNoteDocument, by: string, at: Date): Promise<boolean> {
    this.beforeMark?.();
    if (!this.entry || this.entry.id !== id || this.entry.status !== 'pendente') return false;
    this.marked.push({ id, document, by, at });
    this.entry = { ...this.entry, status: 'emitida', document };
    return true;
  }
  /** #156/AC-4: outra chamada emitiu a entrada antes desta. */
  winElsewhere(document: ReturnNoteDocument): void {
    if (this.entry) this.entry = { ...this.entry, status: 'emitida', document };
  }
  withStatus(status: ReturnNoteEntry['status'], document: ReturnNoteDocument | null = null): void {
    if (this.entry) this.entry = { ...this.entry, status, document };
  }
}
