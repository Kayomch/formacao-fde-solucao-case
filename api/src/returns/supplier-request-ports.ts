// #156: as portas do pedido ao fornecedor. Os adaptadores reais (banco) são da camada seguinte.
import type { Money, SupplierRequest, SupplierRequestStatus, SupplierRequestType } from '../domain/index.js';

/** #156/AC-8: um pedido já registrado para a nota, de qualquer status. */
export type ExistingSupplierRequest = {
  readonly invoiceAccessKey: string;
  readonly requestType: SupplierRequestType;
  readonly status: SupplierRequestStatus;
};

/** #156: `refused` é um resultado normal: a regra do pedido aberto (#156/AC-8) o impôs. */
export type SaveOutcome = 'inserted' | 'refused';

/** #156: o contato do fornecedor; `null` quando não há e-mail cadastrado. */
export interface SupplierContacts {
  emailOf(supplierId: string): Promise<string | null>;
}

/** #156/AC-8: os pedidos ao fornecedor. */
export interface SupplierRequests {
  /** #156: os pedidos das notas dadas, de qualquer tipo e status. */
  listFor(invoiceAccessKeys: readonly string[]): Promise<readonly ExistingSupplierRequest[]>;
  /** #156/AC-8: grava o resultado; recusa se já existe um pedido aberto do mesmo tipo para a nota. */
  save(request: SupplierRequest): Promise<SaveOutcome>;
}

/** #156: o valor da devolução na fila da #140, por nota de origem; a entrada cancelada não conta. */
export interface ReturnQueueValues {
  valuesOf(invoiceAccessKeys: readonly string[]): Promise<ReadonlyMap<string, Money>>;
}

/** #156: uma sugestão ok do Claude, como o laço a gravou em claude_suggestions. */
export type StoredSuggestion = { readonly key: string; readonly output: unknown; readonly model: string };

/** #156: as sugestões ok da tarefa `supplier-request`. */
export interface SupplierRequestSuggestions {
  listOk(): Promise<readonly StoredSuggestion[]>;
}
