// #156/AC-2: o Cron põe na fila da #140 a devolução das decisões aprovadas.
import { canonicalJson } from '../connectors/outbox.js';
import type { ReturnNoteMessage, ReturnNoteOutbox } from '../connectors/ports.js';
import { DomainError, returnNoteOfDecision } from '../domain/index.js';
import type { DecidedReturnSource } from './ports.js';

export type PublishApprovedReturnNotesDeps = {
  readonly source: DecidedReturnSource;
  readonly outbox: ReturnNoteOutbox;
  readonly log?: (line: string) => void;
};

/** #156/AC-2: o conteúdo comparável: a nota, as linhas canônicas e a razão, como o hash da caixa (#59). */
function fingerprint(note: ReturnNoteMessage): string {
  return canonicalJson({
    invoiceAccessKey: note.invoiceAccessKey,
    lines: note.lines.map((l) => ({ supplierCode: l.supplierCode, amount: l.quantity.amount, unit: l.quantity.unit })),
    reason: note.reason,
  });
}

/**
 * #156/AC-2: publica a devolução de cada decisão ainda fora da fila; rodar de novo não publica outra.
 * Uma decisão que não bate com a nota é pulada e registrada com a chave e a classificação, e a rodada segue.
 */
export async function publishApprovedReturnNotes(deps: PublishApprovedReturnNotesDeps): Promise<{ published: number }> {
  const decided = await deps.source.listDecided();
  if (decided.length === 0) return { published: 0 };
  const known = new Set((await deps.outbox.list()).map(fingerprint));
  let published = 0;
  for (const { proposal, invoice } of decided) {
    let note: ReturnNoteMessage | null;
    try {
      note = returnNoteOfDecision(proposal, invoice);
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      deps.log?.(`devolução pulada: nota ${invoice.accessKey}, classificação ${proposal.classification}`);
      continue;
    }
    if (note === null || known.has(fingerprint(note))) continue;
    await deps.outbox.publish(note);
    known.add(fingerprint(note));
    published += 1;
  }
  return { published };
}
