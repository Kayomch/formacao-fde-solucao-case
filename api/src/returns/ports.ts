// #156: as portas da emissão da nota de devolução. Os adaptadores reais são da camada seguinte.
import type { ReturnNoteLine } from '../connectors/ports.js';
import type { InvoiceView, Money, Proposal, ReturnNoteDocument } from '../domain/index.js';

/** #156: uma proposta decidida com a nota de origem, para o Cron decidir o que vai à fila. */
export type DecidedReturn = { readonly proposal: Proposal; readonly invoice: InvoiceView };

/** #156: lista as propostas decididas (aprovadas ou alteradas) com a nota de origem. */
export interface DecidedReturnSource {
  listDecided(): Promise<readonly DecidedReturn[]>;
}

export type ReturnNoteEntryStatus = 'pendente' | 'emitida' | 'cancelada'; // ADR-002

/** #156: a entrada da fila da #140 como a emissão a lê. `document` é nulo quando o número foi digitado à mão. */
export type ReturnNoteEntry = {
  readonly id: number;
  readonly status: ReturnNoteEntryStatus;
  readonly lines: readonly ReturnNoteLine[];
  /** #156: o valor da devolução na fila (#140). */
  readonly value: Money;
  readonly invoice: InvoiceView;
  readonly document: ReturnNoteDocument | null;
};

/** #156/AC-4: o repositório das entradas da fila. */
export interface ReturnNoteEmissions {
  find(id: number): Promise<ReturnNoteEntry | null>;
  /** #156/AC-4: condicional a a entrada ainda estar pendente; devolve se esta chamada ganhou. */
  markEmitted(id: number, document: ReturnNoteDocument, by: string, at: Date): Promise<boolean>;
}

export type ReturnNoteEmitRequest = {
  /** #156/AC-4: o id da entrada é a chave de idempotência do emissor. */
  readonly entryId: number;
  readonly lines: readonly ReturnNoteLine[];
  readonly value: Money;
  readonly invoice: InvoiceView;
  /** #156: AAAA-MM-DD, a data em Brasília. */
  readonly issuedOn: string;
};

/** #156/AC-4: o serviço fiscal; um real pode substituir o mock atrás desta porta. */
export interface ReturnNoteEmitter {
  emit(request: ReturnNoteEmitRequest): Promise<ReturnNoteDocument>;
}
