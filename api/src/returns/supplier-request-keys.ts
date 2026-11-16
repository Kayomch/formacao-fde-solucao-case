// #156: o filtro `in` do PostgREST por chave de acesso, com a chave conferida antes de entrar na consulta.
import { SupabaseRestError } from '../connectors/supabase-rest.js';

const ACCESS_KEY = /^\d{44}$/;

/** #156: `in.("k1","k2")`; uma chave fora do formato de 44 dígitos lança, para nunca chegar ao filtro. */
export function accessKeyFilter(table: string, keys: readonly string[]): string {
  if (!keys.every((k) => ACCESS_KEY.test(k))) throw new SupabaseRestError('select', table, 0, 'chave de acesso fora do formato');
  return `in.(${keys.map((k) => `"${k}"`).join(',')})`;
}
