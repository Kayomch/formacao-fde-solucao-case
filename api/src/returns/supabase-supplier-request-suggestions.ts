// #156/AC-1: as sugestões ok da tarefa supplier-request, como o laço do Claude as gravou em claude_suggestions.
import { isString, isUnknown, parseRows, shaped, type Shape } from '../connectors/guards.js';
import type { SupabaseRest } from '../connectors/supabase-rest.js';
import type { StoredSuggestion, SupplierRequestSuggestions } from './supplier-request-ports.js';

const TABLE = 'claude_suggestions';
const TASK = 'supplier-request';

type Row = { input_key: string; input: unknown; output: unknown; model: string };
const isRow = shaped<Row>({ input_key: isString, input: isUnknown, output: isUnknown, model: isString } satisfies Shape<Row>);

/** #156/AC-1: lê as linhas ok da tarefa; o `input` e a saída seguem crus, quem os confere é o caso de uso. */
export function supabaseSupplierRequestSuggestions(rest: SupabaseRest): SupplierRequestSuggestions {
  return {
    async listOk(): Promise<readonly StoredSuggestion[]> {
      const rows = await rest.select(TABLE, {
        select: 'input_key,input,output,model',
        filters: { task: `eq.${TASK}`, status: 'eq.ok' },
        order: 'id',
      });
      return parseRows(rows, isRow, TABLE).map((r) => ({ key: r.input_key, input: r.input, output: r.output, model: r.model }));
    },
  };
}
