// #156/AC-1: o passo determinístico depois da rodada do Claude: confere a sugestão e grava o pedido.
import { draftSupplierRequest, type Money } from '../domain/index.js';
import type { DecidedReturnSource } from './ports.js';
import {
  basisOf,
  decisionOf,
  dueOnOfInput,
  invoiceKeyOf,
  skipLine,
  type Decision,
} from './supplier-request-basis.js';
import type {
  ReturnQueueValues,
  StoredSuggestion,
  SupplierContacts,
  SupplierRequests,
  SupplierRequestSuggestions,
} from './supplier-request-ports.js';

export type DraftSupplierRequestsDeps = {
  readonly source: DecidedReturnSource;
  readonly queue: ReturnQueueValues;
  readonly requests: SupplierRequests;
  readonly contacts: SupplierContacts;
  readonly suggestions: SupplierRequestSuggestions;
  readonly now: () => Date;
  readonly log?: (line: string) => void;
};

export type DraftCounts = { drafted: number; discarded: number; refused: number; skipped: number };

/**
 * #156/AC-1, #156/AC-6, #156/AC-8: grava o rascunho, ou o descarte com o motivo, de cada sugestão ok cuja
 * nota ainda não tem pedido, de qualquer status. O catálogo, as perguntas e o contato vêm do banco e da
 * regra, e o prazo do `input` dado ao Claude, não do relógio de agora; da sugestão só o assunto e o corpo. Uma gravação recusada pela regra do pedido aberto
 * (#156/AC-8) é contada e a rodada segue.
 */
export async function draftSupplierRequests(deps: DraftSupplierRequestsDeps): Promise<DraftCounts> {
  const log = deps.log ?? ((): void => undefined);
  const counts: DraftCounts = { drafted: 0, discarded: 0, refused: 0, skipped: 0 };
  const suggestions = [...(await deps.suggestions.listOk())];
  if (suggestions.length === 0) return counts;
  const decisions = new Map<string, Decision>();
  for (const decided of await deps.source.listDecided()) {
    const decision = decisionOf(decided, log);
    if (decision !== null && !decisions.has(decided.invoice.accessKey)) decisions.set(decided.invoice.accessKey, decision);
  }
  const keys = suggestions.flatMap((s) => invoiceKeyOf(s.key) ?? []);
  const known = new Set(
    (await deps.requests.listFor(keys)).filter((r) => r.requestType === 'return_note').map((r) => r.invoiceAccessKey),
  );
  const values = await deps.queue.valuesOf(keys);
  for (const suggestion of suggestions) {
    const outcome = await draftOne(deps, { suggestion, decisions, known, values, log });
    counts[outcome] += 1;
    if (outcome !== 'skipped') known.add(invoiceKeyOf(suggestion.key) ?? '');
  }
  return counts;
}

type Round = {
  readonly suggestion: StoredSuggestion;
  readonly decisions: ReadonlyMap<string, Decision>;
  readonly known: ReadonlySet<string>;
  readonly values: ReadonlyMap<string, Money>;
  readonly log: (line: string) => void;
};

async function draftOne(deps: DraftSupplierRequestsDeps, round: Round): Promise<keyof DraftCounts> {
  const { suggestion, log } = round;
  const accessKey = invoiceKeyOf(suggestion.key);
  const decision = accessKey === null ? undefined : round.decisions.get(accessKey);
  const value = accessKey === null ? undefined : round.values.get(accessKey);
  if (accessKey === null || decision === undefined || value === undefined || round.known.has(accessKey)) return 'skipped';
  const to = await deps.contacts.emailOf(decision.decided.invoice.supplierId);
  if (to === null) {
    log(skipLine(suggestion.key, 'no_contact'));
    return 'skipped';
  }
  const dueOn = dueOnOfInput(suggestion.input);
  if (dueOn === null) {
    log(skipLine(suggestion.key, 'invalid_input'));
    return 'skipped';
  }
  const basis = basisOf(decision, value, dueOn, log);
  if (basis === null) return 'skipped';
  const request = draftSupplierRequest({
    raw: suggestion.output,
    catalog: basis.catalog,
    invoiceAccessKey: accessKey,
    supplierId: basis.invoice.supplierId,
    asks: basis.asks,
    to,
    dueOn: basis.dueOn,
    channel: 'mock',
    model: suggestion.model,
    draftedAt: deps.now().toISOString(),
  });
  if ((await deps.requests.save(request)) === 'refused') {
    log(`pedido ao fornecedor recusado, já há um aberto: ${suggestion.key}`);
    return 'refused';
  }
  return request.status === 'draft' ? 'drafted' : 'discarded';
}
