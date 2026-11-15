import type { Classification } from './classification.js';
import {
  catalogIdentifiers,
  factKey,
  invoiceFacts,
  renderText,
  textProblem,
  type Fact,
  type FactCatalog,
  type TextProblem,
} from './dossier.js';
import { DomainError } from './errors.js';
import type { InvoiceView } from './invoice.js';
import { Money } from './money.js';
import { returnLineCents, type ReturnNote } from './return-note.js';

/**
 * #156: o pedido ao fornecedor. O Claude escreve só o assunto e o corpo do e-mail; quem diz o que
 * pedimos (`asks`), a quem (`to`), até quando (`dueOn`) e todo número do texto é a regra e o banco.
 */

export type SupplierRequestType = 'return_note'; // #156: os outros tipos da história estão fora desta entrega
export type SupplierRequestStatus = 'draft' | 'sent' | 'discarded' | 'send_failed'; // #156
export type SupplierRequestChannel = 'mock' | 'resend'; // #156

/**
 * #156/AC-8: aberto é o pedido que ainda vale: em rascunho, enviado ou com envio falho. Só o descartado é
 * fechado. Decisão: `send_failed` é aberto porque "Tentar enviar de novo" reenvia o mesmo pedido, e um
 * segundo rascunho ao lado deixaria dois pedidos do mesmo tipo chegarem ao fornecedor.
 */
export function isOpenRequest(status: SupplierRequestStatus): boolean {
  return status !== 'discarded';
}

export type AskKind =
  | 'deliver_missing_or_accept_return' // #156: E1, por item
  | 'withdraw_swapped_item' // #156: E2, por item
  | 'deliver_ordered_item' // #156: E2, por item
  | 'acknowledge_return' // #156: E3, por item
  | 'offset_title'; // #156: E3, uma vez na nota

/** #156: o que pedimos. `supplierCode` é o item; `null` é um pedido sobre a nota toda. */
export type Ask = { readonly kind: AskKind; readonly supplierCode: string | null };

const perItem = (note: ReturnNote, ...kinds: readonly AskKind[]): Ask[] =>
  note.lines.flatMap((line) => kinds.map((kind): Ask => ({ kind, supplierCode: line.supplierCode })));

/**
 * #156/AC-1: o que o e-mail pede, dado pela classificação e nunca pelo Claude: E1 falta física pede entregar
 * o que faltou ou aceitar a devolução; E2 item trocado pede retirar o trocado e entregar o pedido; E3
 * quantidade menor pede ciência da devolução e o abatimento no título. Fora de E1, E2 e E3, não há pedido.
 */
export function asksFor(classification: Classification, note: ReturnNote): readonly Ask[] {
  switch (classification) {
    case 'E1':
      return perItem(note, 'deliver_missing_or_accept_return');
    case 'E2':
      return perItem(note, 'withdraw_swapped_item', 'deliver_ordered_item');
    case 'E3':
      return [...perItem(note, 'acknowledge_return'), { kind: 'offset_title', supplierCode: null }];
    default:
      throw new DomainError(`Pedido ao fornecedor: a classificação ${classification} não devolve mercadoria`);
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const BRASILIA_OFFSET_MS = 3 * 60 * 60 * 1000; // #156: UTC-3, sem horário de verão
const DAY_MS = 24 * 60 * 60 * 1000;
const BUSINESS_DAYS = 3; // #156: o prazo padrão de resposta

/** #156: o dia de Brasília (AAAA-MM-DD) de um instante ISO. */
export function brasiliaDate(instant: string): string {
  const at = new Date(instant);
  if (Number.isNaN(at.getTime())) throw new DomainError('Pedido ao fornecedor: o instante não é uma data ISO');
  return new Date(at.getTime() - BRASILIA_OFFSET_MS).toISOString().slice(0, 10);
}

/** #156: a data existe no calendário: Date.parse rola 2026-02-30 para março, então a volta tem de dar a mesma data. */
function isCalendarDate(date: string): boolean {
  const at = Date.parse(date);
  return !Number.isNaN(at) && new Date(at).toISOString().slice(0, 10) === date;
}

/**
 * #156: o prazo de resposta: 3 dias úteis (segunda a sexta) depois do dia dado, AAAA-MM-DD. Feriado fica fora.
 * Um sábado ou domingo conta a partir da segunda.
 */
export function dueOnAfter(date: string): string {
  if (!ISO_DATE.test(date) || !isCalendarDate(date)) {
    throw new DomainError(`Pedido ao fornecedor: a data ${date} não é AAAA-MM-DD`);
  }
  let at = Date.parse(date);
  for (let left = BUSINESS_DAYS; left > 0; ) {
    at += DAY_MS;
    const weekday = new Date(at).getUTCDay();
    if (weekday !== 0 && weekday !== 6) left -= 1;
  }
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * #156/AC-6: o catálogo de fatos do pedido: a nota de origem (número, série, itens) e a nota de devolução
 * (linhas, preço, valor e total). O total tem de ser o valor da devolução na fila da #140; o valor da
 * linha é arredondado como em `issueReturnNote`.
 */
export function buildSupplierRequestCatalog(
  invoice: InvoiceView,
  note: ReturnNote,
  dueOn: string,
  queueValue: Money,
): FactCatalog {
  const facts: Record<string, Fact> = invoiceFacts(invoice);
  const ids = new Set<string>([invoice.accessKey, invoice.supplierId, invoice.store, invoice.issuedOn, dueOn]);
  const put = (key: string, label: string, value: string, source: Fact['source']): void => {
    facts[key] = Object.freeze({ label, value, source });
  };
  for (const item of invoice.items) {
    ids.add(item.supplierCode);
    if (item.sku) ids.add(item.sku);
  }
  let totalCents = 0;
  for (const line of note.lines) {
    const item = invoice.items.find((i) => i.supplierCode === line.supplierCode);
    if (item === undefined) {
      throw new DomainError(`Pedido ao fornecedor: a linha ${line.supplierCode} não está na nota ${invoice.number}`);
    }
    const cents = returnLineCents(item.unitPrice, line.quantity);
    totalCents += cents;
    const code = line.supplierCode;
    put(factKey.returnItem(code, 'quantidade'), `Quantidade devolvida de ${item.description}`, `${line.quantity.amount} ${line.quantity.unit}`, 'return_note');
    put(factKey.returnItem(code, 'preco_unitario'), `Preço unitário devolvido de ${item.description}`, item.unitPrice.toString(), 'return_note');
    put(factKey.returnItem(code, 'valor'), `Valor devolvido de ${item.description}`, Money.ofCents(cents).toString(), 'return_note');
  }
  if (totalCents !== queueValue.cents) {
    throw new DomainError(`Pedido ao fornecedor: o total ${totalCents} da devolução difere do valor na fila ${queueValue.cents}`);
  }
  put(factKey.returnTotal(), 'Valor total da devolução', queueValue.toString(), 'return_note');
  return Object.freeze({ facts: Object.freeze(facts), identifiers: catalogIdentifiers(ids) });
}

/** #156: o schema da saída estruturada do Claude: só o assunto e o corpo, com os números como `{{chave}}`. */
export const SUPPLIER_REQUEST_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['subject', 'body'],
  properties: {
    subject: { type: 'string' },
    body: { type: 'string' },
  },
} as const;

/** #156/AC-6: por que o pedido foi descartado. Código fechado: nunca o texto do Claude. */
export type DiscardReason = TextProblem | 'invalid_shape' | 'subject_without_invoice_number';

type RequestBase = {
  readonly requestType: SupplierRequestType;
  readonly invoiceAccessKey: string;
  readonly supplierId: string;
  readonly to: string;
  readonly asks: readonly Ask[];
  readonly dueOn: string;
  readonly channel: SupplierRequestChannel;
  readonly model: string;
  readonly draftedAt: string;
};

/**
 * #156: o resultado do rascunho, não o registro persistido: o id e os carimbos de quando e por quem ficam na
 * linha de `outbox_supplier_emails`, da camada OLTP.
 */
export type SupplierRequestDraft = RequestBase & {
  readonly status: 'draft';
  readonly subject: string;
  readonly body: string;
};

/** #156: o pedido descartado, também resultado do rascunho; id e carimbos são da linha persistida, como no rascunho. */
export type SupplierRequestDiscarded = RequestBase & {
  readonly status: 'discarded';
  readonly reason: DiscardReason;
};

/** #156: o resultado do rascunho; `sent` e `send_failed` são da entrega seguinte. */
export type SupplierRequest = SupplierRequestDraft | SupplierRequestDiscarded;

export type DraftSupplierRequestInput = {
  /** #156: a resposta crua do Claude, ainda não confiável. */
  readonly raw: unknown;
  readonly catalog: FactCatalog;
  readonly invoiceAccessKey: string;
  readonly supplierId: string;
  readonly asks: readonly Ask[];
  readonly to: string;
  readonly dueOn: string;
  readonly channel: SupplierRequestChannel;
  readonly model: string;
  readonly draftedAt: string;
};

const INVOICE_NUMBER_MARKER = `{{${factKey.invoiceNumber()}}}`;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** #156: a resposta do Claude já lida; as chaves vêm do `required` do esquema, então mudar o esquema quebra o parser. */
type SupplierEmail = Readonly<Record<(typeof SUPPLIER_REQUEST_OUTPUT_SCHEMA.required)[number], string>>;

/** #156: lê só `subject` e `body`; qualquer outro campo é descartado, nunca copiado. */
function parseEmail(raw: unknown): SupplierEmail | null {
  if (!isRecord(raw)) return null;
  const { subject, body } = raw;
  if (typeof subject !== 'string' || typeof body !== 'string') return null;
  if (subject.trim() === '' || body.trim() === '') return null;
  return { subject, body };
}

/**
 * #156/AC-1, #156/AC-6: confere a resposta do Claude contra o catálogo com o verificador do dossiê. O
 * assunto leva o número da nota de origem como marcador. Qualquer falha descarta o pedido, com o motivo.
 */
export function draftSupplierRequest(input: DraftSupplierRequestInput): SupplierRequest {
  const base: RequestBase = {
    requestType: 'return_note',
    invoiceAccessKey: input.invoiceAccessKey,
    supplierId: input.supplierId,
    to: input.to,
    asks: input.asks,
    dueOn: input.dueOn,
    channel: input.channel,
    model: input.model,
    draftedAt: input.draftedAt,
  };
  const discard = (reason: DiscardReason): SupplierRequest => Object.freeze({ ...base, status: 'discarded', reason });
  const email = parseEmail(input.raw);
  if (email === null) return discard('invalid_shape');
  const allowed = new Set(input.catalog.identifiers);
  const problem =
    textProblem(email.subject, input.catalog, allowed) ?? textProblem(email.body, input.catalog, allowed);
  if (problem !== null) return discard(problem);
  if (!email.subject.includes(INVOICE_NUMBER_MARKER)) return discard('subject_without_invoice_number');
  return Object.freeze({
    ...base,
    status: 'draft',
    subject: renderText(email.subject, input.catalog),
    body: renderText(email.body, input.catalog),
  });
}
