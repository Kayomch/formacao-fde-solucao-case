// #156/AC-1: a base de um pedido ao fornecedor, a mesma para perguntar ao Claude e para redigir o e-mail.
import {
  asksFor,
  brasiliaDate,
  buildSupplierRequestCatalog,
  dueOnAfter,
  DomainError,
  returnNoteOfDecision,
  type Ask,
  type FactCatalog,
  type InvoiceView,
  type Money,
  type ReturnNote,
} from '../domain/index.js';
import type { DecidedReturn } from './ports.js';

const KEY_SUFFIX = ':return_note';

/** #156: a chave estável do pedido na tarefa do Claude: a nota de origem e o tipo. */
export const requestKeyOf = (invoiceAccessKey: string): string => `${invoiceAccessKey}${KEY_SUFFIX}`;

/** #156: a nota de origem de uma chave de pedido; `null` quando a chave não é de um pedido return_note. */
export function invoiceKeyOf(requestKey: string): string | null {
  if (!requestKey.endsWith(KEY_SUFFIX)) return null;
  const key = requestKey.slice(0, -KEY_SUFFIX.length);
  return key === '' ? null : key;
}

/** #156: o prazo de resposta: 3 dias úteis depois do dia de Brasília do instante dado. */
export const dueOnOf = (now: Date): string => dueOnAfter(brasiliaDate(now.toISOString()));

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * #156/AC-1, #156/AC-6: o prazo que o `input` da sugestão guardou, o dado ao Claude; `null` quando falta ou não é
 * uma data do calendário em AAAA-MM-DD.
 */
export function dueOnOfInput(input: unknown): string | null {
  if (typeof input !== 'object' || input === null || !('dueOn' in input)) return null;
  const { dueOn } = input;
  if (typeof dueOn !== 'string' || !ISO_DATE.test(dueOn)) return null;
  const at = Date.parse(dueOn);
  return !Number.isNaN(at) && new Date(at).toISOString().slice(0, 10) === dueOn ? dueOn : null;
}

export type Decision = { readonly decided: DecidedReturn; readonly note: ReturnNote };

/** #156: registra um pulo só com a chave, a classificação e um código fechado. */
export function skipLine(key: string, reason: string, classification?: string): string {
  const where = classification === undefined ? key : `${key}, classificação ${classification}`;
  return `pedido ao fornecedor pulado: ${where}, motivo ${reason}`;
}

/**
 * #156/AC-1: a devolução da decisão, ou `null` fora do escopo (E1, E2, E3 aprovadas com receber parcial e
 * linha devolver). Uma decisão que não bate com a nota é pulada e registrada, e a rodada segue.
 */
export function decisionOf(decided: DecidedReturn, log: (line: string) => void): Decision | null {
  try {
    const note = returnNoteOfDecision(decided.proposal, decided.invoice);
    return note === null ? null : { decided, note };
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    log(skipLine(requestKeyOf(decided.invoice.accessKey), 'inconsistent', decided.proposal.classification));
    return null;
  }
}

export type RequestBasis = {
  readonly invoice: InvoiceView;
  readonly classification: string;
  readonly asks: readonly Ask[];
  readonly catalog: FactCatalog;
  readonly dueOn: string;
};

/** #156/AC-6: refaz as perguntas e o catálogo a partir do banco, nunca da sugestão do Claude. */
export function basisOf(
  decision: Decision,
  queueValue: Money,
  dueOn: string,
  log: (line: string) => void,
): RequestBasis | null {
  const { invoice, proposal } = decision.decided;
  try {
    const asks = asksFor(proposal.classification, decision.note);
    const catalog = buildSupplierRequestCatalog(invoice, decision.note, dueOn, queueValue);
    return { invoice, classification: proposal.classification, asks, catalog, dueOn };
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    log(skipLine(requestKeyOf(invoice.accessKey), 'inconsistent', proposal.classification));
    return null;
  }
}
