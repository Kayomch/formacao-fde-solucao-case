// #156/AC-4: o repositório das entradas da fila de devolução (#140) sobre outbox_return_notes e invoices.
import { loadInvoicesByKeys } from '../approval/supabase-store.js';
import {
  arrayOf,
  isInteger,
  isNumber,
  isString,
  nullable,
  oneOf,
  parseRows,
  shaped,
  type Shape,
} from '../connectors/guards.js';
import { SupabaseRestError, type SupabaseRest } from '../connectors/supabase-rest.js';
import { Money, Quantity, type ReturnNoteDocument, type ReturnNoteItemDocument } from '../domain/index.js';
import type { ReturnNoteEmissions, ReturnNoteEntry, ReturnNoteEntryStatus } from './ports.js';

const TABLE = 'outbox_return_notes';
const COLUMNS = 'id,invoice_access_key,payload,status,note_document';

type PayloadLine = { supplierCode: string; amount: number; unit: 'UN' | 'CX' };
type Row = {
  id: number;
  invoice_access_key: string;
  payload: { lines: PayloadLine[] };
  status: ReturnNoteEntryStatus;
  note_document: ReturnNoteDocument | null;
};

const isUnit = oneOf('UN', 'CX');

const isPayloadLine = shaped<PayloadLine>({ supplierCode: isString, amount: isNumber, unit: isUnit } satisfies Shape<PayloadLine>);

// ADR-001: as chaves do documento copiam o formato do kit.
const isItem = shaped<ReturnNoteItemDocument>({
  codigo_fornecedor: isString, // ADR-001
  sku: nullable(isString),
  descricao: isString, // ADR-001
  quantidade: isNumber, // ADR-001
  unidade: isUnit, // ADR-001
  preco_unitario: isNumber, // ADR-001
  valor: isNumber,
} satisfies Shape<ReturnNoteItemDocument>);

const isDocument = shaped<ReturnNoteDocument>({
  nota_id: isString, // ADR-001
  chave: isString, // ADR-001
  numero: isInteger, // ADR-001
  serie: isInteger, // ADR-001
  emitente: isString, // ADR-001
  fornecedor_id: isString, // ADR-001
  destino: isString, // ADR-001
  data_emissao: isString, // ADR-001
  nota_referenciada: isString, // ADR-001
  natureza: oneOf('devolucao'), // ADR-001
  itens: arrayOf(isItem), // ADR-001
  valor_total: isNumber, // ADR-001
} satisfies Shape<ReturnNoteDocument>);

const isRow = shaped<Row>({
  id: isInteger,
  invoice_access_key: isString,
  payload: shaped<Row['payload']>({ lines: arrayOf(isPayloadLine) }),
  status: oneOf('pendente', 'emitida', 'cancelada'), // ADR-002
  note_document: nullable(isDocument),
} satisfies Shape<Row>);

/** #156/AC-4: as entradas da fila lidas e gravadas pelo PostgREST; a gravação só pega a entrada pendente. */
export function supabaseReturnNoteEmissions(rest: SupabaseRest): ReturnNoteEmissions {
  return {
    async find(id: number): Promise<ReturnNoteEntry | null> {
      const [row] = parseRows(await rest.select(TABLE, { select: COLUMNS, filters: { id: `eq.${id}` } }), isRow, TABLE);
      if (row === undefined) return null;
      const invoice = (await loadInvoicesByKeys(rest, [row.invoice_access_key])).get(row.invoice_access_key);
      if (invoice === undefined) throw new SupabaseRestError('select', 'invoices', 404, 'nota de origem não encontrada');
      const lines = row.payload.lines.map((l) => ({ supplierCode: l.supplierCode, quantity: Quantity.of(l.amount, l.unit) }));
      // #156/AC-2: o mesmo valor da fila da #140: o preço da nota vezes a quantidade, arredondado por linha e somado.
      const cents = lines.reduce((sum, line) => {
        const item = invoice.items.find((i) => i.supplierCode === line.supplierCode);
        if (item === undefined) throw new SupabaseRestError('select', TABLE, 0, 'linha fora da nota de origem');
        return sum + Math.round(item.unitPrice.cents * line.quantity.amount);
      }, 0);
      return { id: row.id, status: row.status, lines, value: Money.ofCents(cents), invoice, document: row.note_document };
    },

    async markEmitted(id: number, document: ReturnNoteDocument, by: string, at: Date): Promise<boolean> {
      const changed = await rest.update(TABLE, { id: `eq.${id}`, status: 'eq.pendente' }, {
        status: 'emitida', // ADR-002
        nfe_number: String(document.numero), // ADR-001
        emitted_by: by,
        emitted_at: at.toISOString(),
        note_document: document,
        note_id: document.nota_id, // ADR-001
        note_access_key: document.chave, // ADR-001
        note_series: document.serie, // ADR-001
        note_number: document.numero, // ADR-001
      });
      return changed.length > 0;
    },
  };
}
