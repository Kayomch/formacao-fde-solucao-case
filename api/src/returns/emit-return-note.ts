// #156/AC-4: a emissão de uma entrada da fila de devolução.
import type { ReturnNoteDocument } from '../domain/index.js';
import { todayInBrasilia } from '../http/approval.js';
import type { ReturnNoteEmissions, ReturnNoteEmitter, ReturnNoteEntry } from './ports.js';

export type EmitReturnNoteInput = { readonly id: number; readonly by: string; readonly now: Date };
export type EmitReturnNoteDeps = { readonly emissions: ReturnNoteEmissions; readonly emitter: ReturnNoteEmitter };

export type EmitReturnNoteResult =
  | { readonly kind: 'emitted'; readonly note: ReturnNoteDocument } // ADR-002
  | { readonly kind: 'already_emitted'; readonly note: ReturnNoteDocument } // ADR-002
  | { readonly kind: 'not_found' } // ADR-002
  | { readonly kind: 'conflict'; readonly reason: string }; // ADR-002

/** #156/AC-4: a resposta de uma entrada que não está mais pendente; nula quando falta emitir. */
function settled(entry: ReturnNoteEntry): EmitReturnNoteResult | null {
  if (entry.status === 'cancelada') return { kind: 'conflict', reason: 'a devolução está cancelada' };
  if (entry.status === 'emitida') {
    if (entry.document === null) return { kind: 'conflict', reason: 'a devolução foi emitida à mão, sem nota gerada' };
    return { kind: 'already_emitted', note: entry.document };
  }
  return null;
}

/** #156/AC-4: emite a entrada pendente uma vez; emitir de novo devolve a mesma nota, sem chamar o emissor. */
export async function emitReturnNote(input: EmitReturnNoteInput, deps: EmitReturnNoteDeps): Promise<EmitReturnNoteResult> {
  const entry = await deps.emissions.find(input.id);
  if (entry === null) return { kind: 'not_found' };
  const done = settled(entry);
  if (done !== null) return done;
  const note = await deps.emitter.emit({
    entryId: entry.id,
    lines: entry.lines,
    value: entry.value,
    invoice: entry.invoice,
    issuedOn: todayInBrasilia(input.now),
  });
  if (await deps.emissions.markEmitted(entry.id, note, input.by, input.now)) return { kind: 'emitted', note };
  const reloaded = await deps.emissions.find(input.id);
  const lost = reloaded === null ? null : settled(reloaded);
  return lost ?? { kind: 'conflict', reason: 'a devolução mudou durante a emissão' };
}
