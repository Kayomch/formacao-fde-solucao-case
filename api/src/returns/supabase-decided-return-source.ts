// #156/AC-2: as propostas decididas com a nota de origem, para o Cron decidir o que vai à fila.
import { isProposalRow, loadInvoicesByKeys, proposalFromRow } from '../approval/supabase-store.js';
import { parseRows } from '../connectors/guards.js';
import type { SupabaseRest } from '../connectors/supabase-rest.js';
import type { DecidedReturn, DecidedReturnSource } from './ports.js';

/** #156/AC-2: lê as propostas aprovadas ou alteradas e a nota de cada uma; a proposta sem nota fica de fora. */
export function supabaseDecidedReturnSource(rest: SupabaseRest): DecidedReturnSource {
  return {
    async listDecided(): Promise<readonly DecidedReturn[]> {
      const proposals = parseRows(
        await rest.select('proposals', { filters: { state: 'in.(aprovada,alterada)' }, order: 'id' }), // ADR-002
        isProposalRow,
        'proposals',
      );
      const invoices = await loadInvoicesByKeys(rest, [...new Set(proposals.map((p) => p.invoice_access_key))]);
      return proposals.flatMap((row): DecidedReturn[] => {
        const invoice = invoices.get(row.invoice_access_key);
        return invoice === undefined ? [] : [{ proposal: proposalFromRow(row, invoice), invoice }];
      });
    },
  };
}
