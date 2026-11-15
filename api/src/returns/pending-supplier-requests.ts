// #156/AC-1: o que falta perguntar ao Claude: a devolução aprovada, na fila e com contato, sem pedido ainda.
import { buildPromptInput } from '../agent/supplier-request.js';
import type { SupplierRequestPromptInput } from '../agent/supplier-request.js';
import type { PendingRequest } from '../claude/task.js';
import type { DecidedReturnSource } from './ports.js';
import { basisOf, decisionOf, dueOnOf, requestKeyOf, skipLine, type Decision } from './supplier-request-basis.js';
import type { ReturnQueueValues, SupplierContacts, SupplierRequests } from './supplier-request-ports.js';

export type PendingSupplierRequestsDeps = {
  readonly source: DecidedReturnSource;
  readonly queue: ReturnQueueValues;
  readonly requests: SupplierRequests;
  readonly contacts: SupplierContacts;
  readonly now: () => Date;
  readonly log?: (line: string) => void;
};

/**
 * #156/AC-1, #156/AC-8: um pedido por nota de origem, com a chave `<chave de acesso>:return_note`. Quem já
 * tem pedido de qualquer status fica de fora: o descartado só se refaz pelo botão (entrega seguinte).
 * Sem contato a nota é pulada e volta na rodada seguinte.
 */
export async function pendingSupplierRequests(
  deps: PendingSupplierRequestsDeps,
): Promise<{ requests: PendingRequest<SupplierRequestPromptInput>[]; dropped: number }> {
  const log = deps.log ?? ((): void => undefined);
  const decisions = new Map<string, Decision>();
  for (const decided of await deps.source.listDecided()) {
    const decision = decisionOf(decided, log);
    if (decision !== null && !decisions.has(decided.invoice.accessKey)) decisions.set(decided.invoice.accessKey, decision);
  }
  const keys = [...decisions.keys()];
  if (keys.length === 0) return { requests: [], dropped: 0 };
  const asked = new Set(
    (await deps.requests.listFor(keys)).filter((r) => r.requestType === 'return_note').map((r) => r.invoiceAccessKey),
  );
  const values = await deps.queue.valuesOf(keys.filter((k) => !asked.has(k)));
  const dueOn = dueOnOf(deps.now());
  const requests: PendingRequest<SupplierRequestPromptInput>[] = [];
  for (const [accessKey, decision] of decisions) {
    const value = values.get(accessKey);
    if (asked.has(accessKey) || value === undefined) continue;
    const key = requestKeyOf(accessKey);
    if ((await deps.contacts.emailOf(decision.decided.invoice.supplierId)) === null) {
      log(skipLine(key, 'no_contact'));
      continue;
    }
    const basis = basisOf(decision, value, dueOn, log);
    if (basis !== null) requests.push({ key, input: buildPromptInput(basis) });
  }
  return { requests, dropped: 0 };
}
