// #156: os dublês das portas do pedido ao fornecedor e as respostas do Claude dos testes.
import { isOpenRequest, Money, type SupplierRequest, type SupplierRequestDraft, type SupplierRequestStatus } from '../../src/domain/index.js';
import type {
  ExistingSupplierRequest,
  ReturnQueueValues,
  SaveOutcome,
  StoredSuggestion,
  SupplierContacts,
  SupplierRequests,
  SupplierRequestSuggestions,
} from '../../src/returns/supplier-request-ports.js';
import { ORIGIN_KEY } from './return-note-fixtures.js';

export const CONTACT = 'compras@fornecedor.teste';
export const REQUEST_KEY = `${ORIGIN_KEY}:return_note`;
/** #156: uma segunda-feira, 10h em Brasília: o prazo é a quinta-feira seguinte. */
export const NOW = new Date('2026-11-16T13:00:00Z');
export const DUE_ON = '2026-11-19';

export const contactsOf = (emails: Record<string, string | null>): SupplierContacts => ({
  emailOf: async (id) => emails[id] ?? null,
});

export const queueOf = (values: Record<string, Money>): ReturnQueueValues => ({
  valuesOf: async (keys) => new Map(keys.flatMap((k) => (values[k] ? [[k, values[k]] as const] : []))),
});

/** #156/AC-8: o repositório em memória; recusa o segundo aberto como o índice parcial único do banco. */
/** #156/AC-8: a linha guardada; `sent` e `send_failed` são da entrega seguinte, mas já existem no banco. */
export type StoredRow = SupplierRequest | (Omit<SupplierRequestDraft, 'status'> & { readonly status: 'sent' | 'send_failed' });

export class MemoryRequests implements SupplierRequests {
  readonly rows: StoredRow[] = [];
  constructor(seed: readonly StoredRow[] = []) {
    this.rows.push(...seed);
  }
  async listFor(keys: readonly string[]): Promise<readonly ExistingSupplierRequest[]> {
    return this.rows
      .filter((r) => keys.includes(r.invoiceAccessKey))
      .map((r) => ({ invoiceAccessKey: r.invoiceAccessKey, requestType: r.requestType, status: r.status }));
  }
  async save(request: SupplierRequest): Promise<SaveOutcome> {
    const open = this.rows.some(
      (r) => r.invoiceAccessKey === request.invoiceAccessKey && r.requestType === request.requestType && isOpenRequest(r.status),
    );
    if (request.status !== 'discarded' && open) return 'refused';
    this.rows.push(request);
    return 'inserted';
  }
}

/** #156/AC-8: um repositório que não vê o pedido aberto ao listar, mas o recusa ao gravar: a corrida entre duas rodadas. */
export class BlindRequests extends MemoryRequests {
  override async listFor(): Promise<readonly ExistingSupplierRequest[]> {
    return [];
  }
}

export const suggestionsOf = (items: readonly StoredSuggestion[]): SupplierRequestSuggestions => ({ listOk: async () => items });

export const okAnswer = (): StoredSuggestion => ({
  key: REQUEST_KEY,
  model: 'claude-teste',
  output: {
    subject: 'Devolução da nota {{nota.numero}}',
    body: 'Prezados, devolvemos {{devolucao.item[F08-001].quantidade}}, no valor de {{devolucao.valor}}. Respondam até 2026-11-19.',
  },
});

export const answerWith = (output: unknown): StoredSuggestion => ({ key: REQUEST_KEY, model: 'claude-teste', output });

/** #156/AC-8: um pedido já registrado para a nota, no status dado. */
export function existingRow(status: SupplierRequestStatus): StoredRow {
  const base = {
    requestType: 'return_note',
    invoiceAccessKey: ORIGIN_KEY,
    supplierId: 'F08',
    to: CONTACT,
    asks: [],
    dueOn: DUE_ON,
    channel: 'mock',
    model: 'claude-teste',
    draftedAt: NOW.toISOString(),
  } as const;
  return status === 'discarded'
    ? { ...base, status, reason: 'invalid_shape' }
    : { ...base, status, subject: 'assunto antigo', body: 'corpo antigo' };
}
