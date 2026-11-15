// #156/AC-4: o emissor mock da nota de devolução, com o número reservado em return_note_numbers.
import { isInteger, parseRows, shaped, type Shape } from '../connectors/guards.js';
import { SupabaseRestError, type SupabaseRest } from '../connectors/supabase-rest.js';
import { issueReturnNote, returnAccessKey, type ReturnNoteDocument } from '../domain/index.js';
import type { ReturnNoteEmitRequest, ReturnNoteEmitter } from './ports.js';

export type MockEmitterConfig = {
  /** #156: código da UF na chave de acesso; 35 é São Paulo. */
  readonly ufCode?: string;
  /** #156: a série das devoluções, própria e diferente da série 1 do kit. */
  readonly series?: number;
  /** #156: CNPJ fictício do exemplo do manual da NF-e; nenhuma empresa real. Um serviço fiscal real o troca. */
  readonly issuerCnpj?: string;
};

const DEFAULTS = { ufCode: '35', series: 2, issuerCnpj: '99999090910270' } as const;
const TABLE = 'return_note_numbers';

type Reservation = { number: number };
const isReservation = shaped<Reservation>({ number: isInteger } satisfies Shape<Reservation>);

/** #156/AC-4: a reserva da entrada, ou nulo quando ainda não existe. */
async function reservationOf(rest: SupabaseRest, entryId: number): Promise<number | null> {
  const rows = parseRows(
    await rest.select(TABLE, { select: 'number', filters: { return_note_id: `eq.${entryId}` } }),
    isReservation,
    TABLE,
  );
  return rows[0]?.number ?? null;
}

/**
 * #156/AC-4: o número da entrada. Lê, grava ignorando a duplicada e lê de novo; a restrição única de
 * return_note_id decide a disputa, então a entrada nunca ganha um segundo número.
 */
async function reserveNumber(rest: SupabaseRest, entryId: number): Promise<number> {
  const existing = await reservationOf(rest, entryId);
  if (existing !== null) return existing;
  const inserted = parseRows(
    await rest.insert(TABLE, [{ return_note_id: entryId }], { onConflict: 'return_note_id', ignoreDuplicates: true }),
    isReservation,
    TABLE,
  );
  const reserved = inserted[0]?.number ?? (await reservationOf(rest, entryId));
  if (reserved === null) throw new SupabaseRestError('insert', TABLE, 0, 'a reserva não voltou');
  return reserved;
}

/** #156/AC-4: gera a nota de devolução no formato do kit; um emissor fiscal real pode ficar atrás da mesma porta. */
export function mockReturnNoteEmitter(rest: SupabaseRest, config: MockEmitterConfig = {}): ReturnNoteEmitter {
  const { ufCode, series, issuerCnpj } = { ...DEFAULTS, ...config };
  return {
    async emit(request: ReturnNoteEmitRequest): Promise<ReturnNoteDocument> {
      const number = await reserveNumber(rest, request.entryId);
      return issueReturnNote({
        queue: { lines: request.lines, value: request.value },
        invoice: request.invoice,
        issuerCnpj,
        number,
        series,
        accessKey: returnAccessKey({ ufCode, issuedOn: request.issuedOn, issuerCnpj, series, number }),
        issuedOn: request.issuedOn,
      });
    },
  };
}
