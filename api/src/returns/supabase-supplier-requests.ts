// #156/AC-8: os pedidos ao fornecedor sobre outbox_supplier_emails; o índice parcial único do banco é o árbitro do pedido aberto.
import { oneOf, parseRows, shaped, isString, type Shape } from '../connectors/guards.js';
import { SupabaseRestError, type SupabaseRest } from '../connectors/supabase-rest.js';
import type { Ask, SupplierRequest, SupplierRequestStatus, SupplierRequestType } from '../domain/index.js';
import { accessKeyFilter } from './supplier-request-keys.js';
import type { ExistingSupplierRequest, SaveOutcome, SupplierRequests } from './supplier-request-ports.js';

const TABLE = 'outbox_supplier_emails';
const OPEN_REQUEST_INDEX = 'outbox_supplier_emails_open_request_key';
const UNIQUE_VIOLATION = '23505';
/** #156: quem escreve o rascunho; a pessoa que age depois grava a identidade dela. */
const DRAFTED_BY = 'cron:supplier-request';

type Row = { invoice_access_key: string; request_type: SupplierRequestType; status: SupplierRequestStatus };
const isRow = shaped<Row>({
  invoice_access_key: isString,
  request_type: oneOf('return_note'),
  status: oneOf('draft', 'sent', 'discarded', 'send_failed'),
} satisfies Shape<Row>);

const askRow = (ask: Ask): Record<string, unknown> => ({ kind: ask.kind, supplier_code: ask.supplierCode });

/** #156: o resultado do rascunho como a linha da caixa de saída; a versão, o id e a história são do banco. */
function toRow(request: SupplierRequest): Record<string, unknown> {
  const common = {
    invoice_access_key: request.invoiceAccessKey,
    supplier_id: request.supplierId,
    request_type: request.requestType,
    to_address: request.to,
    asks: request.asks.map(askRow),
    due_on: request.dueOn,
    status: request.status,
    channel: request.channel,
    model: request.model,
    drafted_at: request.draftedAt,
    changed_by: DRAFTED_BY,
  };
  return request.status === 'discarded'
    ? { ...common, subject: null, body: null, reason: request.reason }
    : { ...common, subject: request.subject, body: request.body };
}

/** #156/AC-8: o 409 do índice parcial; o 409 da chave estrangeira (23503) e qualquer outro erro não são recusa. */
const isOpenRequestRefusal = (error: unknown): boolean =>
  error instanceof SupabaseRestError &&
  error.status === 409 &&
  error.code === UNIQUE_VIOLATION &&
  (error.serverMessage?.includes(OPEN_REQUEST_INDEX) ?? false);

/** #156/AC-8: lê e grava os pedidos pelo PostgREST; `save` é um insert simples, sem on_conflict, e o índice decide. */
export function supabaseSupplierRequests(rest: SupabaseRest): SupplierRequests {
  return {
    async listFor(invoiceAccessKeys: readonly string[]): Promise<readonly ExistingSupplierRequest[]> {
      if (invoiceAccessKeys.length === 0) return [];
      const rows = await rest.select(TABLE, {
        select: 'invoice_access_key,request_type,status',
        filters: { invoice_access_key: accessKeyFilter(TABLE, invoiceAccessKeys) },
        order: 'id',
      });
      return parseRows(rows, isRow, TABLE).map((r) => ({
        invoiceAccessKey: r.invoice_access_key,
        requestType: r.request_type,
        status: r.status,
      }));
    },

    async save(request: SupplierRequest): Promise<SaveOutcome> {
      try {
        await rest.insert(TABLE, [toRow(request)], { ignoreDuplicates: false });
        return 'inserted';
      } catch (error) {
        // #156/AC-8: o descartado não está no índice parcial, então nunca é recusado.
        if (request.status !== 'discarded' && isOpenRequestRefusal(error)) return 'refused';
        throw error;
      }
    },
  };
}
