// #156/AC-1: o contato do fornecedor sobre supplier_contacts, que só as migrações gravam.
import { isString, parseRows, shaped, type Shape } from '../connectors/guards.js';
import type { SupabaseRest } from '../connectors/supabase-rest.js';
import type { SupplierContacts } from './supplier-request-ports.js';

const TABLE = 'supplier_contacts';

type Row = { supplier_id: string; email: string };
const isRow = shaped<Row>({ supplier_id: isString, email: isString } satisfies Shape<Row>);

/** #156/AC-1: o e-mail do fornecedor, ou null quando não há linha. */
export function supabaseSupplierContacts(rest: SupabaseRest): SupplierContacts {
  return {
    async emailOf(supplierId: string): Promise<string | null> {
      const rows = await rest.select(TABLE, { select: 'supplier_id,email', filters: { supplier_id: `eq.${supplierId}` } });
      return parseRows(rows, isRow, TABLE)[0]?.email ?? null;
    },
  };
}
