// #156/AC-4: a composição da emissão da nota de devolução, para a rota da entrega 3 chamar.
import type { SupabaseRest } from '../connectors/supabase-rest.js';
import { emitReturnNote, type EmitReturnNoteInput, type EmitReturnNoteResult } from './emit-return-note.js';
import { mockReturnNoteEmitter, type MockEmitterConfig } from './mock-return-note-emitter.js';
import { supabaseReturnNoteEmissions } from './supabase-return-note-emissions.js';

/** #156/AC-4: a emissão ligada às entradas do Supabase e ao emissor mock; emitir de novo devolve a mesma nota. */
export function returnNoteEmission(
  rest: SupabaseRest,
  config?: MockEmitterConfig,
): (input: EmitReturnNoteInput) => Promise<EmitReturnNoteResult> {
  const deps = { emissions: supabaseReturnNoteEmissions(rest), emitter: mockReturnNoteEmitter(rest, config) };
  return (input) => emitReturnNote(input, deps);
}
