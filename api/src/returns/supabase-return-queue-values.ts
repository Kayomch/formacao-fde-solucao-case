// #156/AC-1: o valor da devolução na fila da #140, por nota de origem, sobre outbox_return_notes e invoices.
import { loadInvoicesByKeys } from '../approval/supabase-store.js';
import { arrayOf, isNumber, isString, oneOf, parseRows, shaped, type Shape } from '../connectors/guards.js';
import { SupabaseRestError, type SupabaseRest } from '../connectors/supabase-rest.js';
import { Money, Quantity, returnLineCents } from '../domain/index.js';
import { accessKeyFilter } from './supplier-request-keys.js';
import type { ReturnQueueValues } from './supplier-request-ports.js';

const TABLE = 'outbox_return_notes';

type PayloadLine = { supplierCode: string; amount: number; unit: 'UN' | 'CX' };
type Row = { invoice_access_key: string; payload: { lines: PayloadLine[] } };

const isPayloadLine = shaped<PayloadLine>({ supplierCode: isString, amount: isNumber, unit: oneOf('UN', 'CX') } satisfies Shape<PayloadLine>);
const isRow = shaped<Row>({
  invoice_access_key: isString,
  payload: shaped<Row['payload']>({ lines: arrayOf(isPayloadLine) }),
} satisfies Shape<Row>);

/**
 * #156/AC-1: soma, por nota, as entradas da fila que não foram canceladas; cada linha vale o preço da nota vezes a
 * quantidade, arredondado por linha como `returnLineCents`, o mesmo valor da fila da #140. A nota sem entrada fica fora.
 */
export function supabaseReturnQueueValues(rest: SupabaseRest): ReturnQueueValues {
  return {
    async valuesOf(invoiceAccessKeys: readonly string[]): Promise<ReadonlyMap<string, Money>> {
      if (invoiceAccessKeys.length === 0) return new Map();
      const rows = parseRows(
        await rest.select(TABLE, {
          select: 'invoice_access_key,payload',
          filters: { invoice_access_key: accessKeyFilter(TABLE, invoiceAccessKeys), status: 'neq.cancelada' }, // ADR-002
        }),
        isRow,
        TABLE,
      );
      const invoices = await loadInvoicesByKeys(rest, [...new Set(rows.map((r) => r.invoice_access_key))]);
      const cents = new Map<string, number>();
      for (const row of rows) {
        const invoice = invoices.get(row.invoice_access_key);
        if (invoice === undefined) continue;
        const entry = row.payload.lines.reduce((sum, line) => {
          const item = invoice.items.find((i) => i.supplierCode === line.supplierCode);
          if (item === undefined) throw new SupabaseRestError('select', TABLE, 0, 'linha fora da nota de origem');
          return sum + returnLineCents(item.unitPrice, Quantity.of(line.amount, line.unit));
        }, 0);
        cents.set(row.invoice_access_key, (cents.get(row.invoice_access_key) ?? 0) + entry);
      }
      return new Map([...cents].map(([key, value]) => [key, Money.ofCents(value)]));
    },
  };
}
