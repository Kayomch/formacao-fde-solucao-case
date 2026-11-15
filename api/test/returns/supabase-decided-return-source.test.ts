import { describe, expect, it } from 'vitest';
import { AmountAtRisk, DockAction, Money, Proposal } from '../../src/domain/index.js';
import { supabaseDecidedReturnSource } from '../../src/returns/supabase-decided-return-source.js';
import { approved, giveBack, invoice, ORIGIN_KEY } from './return-note-fixtures.js';
import { worldWith } from './return-note-db.js';

const SECOND_KEY = '35261100000000000000550010000099981000099998';

function altered() {
  const p = Proposal.register({
    classification: 'E3',
    dockAction: DockAction.receive(),
    level: 'coordenacao',
    amountAtRisk: AmountAtRisk.of(Money.ofCents(100), Money.ofCents(88_288)),
    justification: 'devolver o que faltou',
  });
  p.awaitApproval();
  p.alter(DockAction.partial([giveBack('SKU-1', 2)]), 'devolver o que faltou');
  return p;
}

describe('a fonte das devoluções decididas (#156)', () => {
  it('#156/AC-2: lista as propostas aprovadas e alteradas com a nota de origem reidratada', async () => {
    const { rest } = worldWith([
      { proposal: approved('E2', [giveBack('SKU-1', 10)]), invoice: invoice(ORIGIN_KEY, '9999'), proposalId: 1 },
      { proposal: altered(), invoice: invoice(SECOND_KEY, '9998'), proposalId: 2 },
    ]);
    const decided = await supabaseDecidedReturnSource(rest).listDecided();
    expect(decided.map((d) => [d.proposal.classification, d.proposal.state, d.invoice.accessKey])).toEqual([
      ['E2', 'aprovada', ORIGIN_KEY],
      ['E3', 'alterada', SECOND_KEY],
    ]);
    expect(decided[1]?.proposal.dockAction.kind).toBe('receber_parcial');
    expect(decided[0]?.invoice.items[0]?.unitPrice.cents).toBe(849);
  });

  it('não lista a proposta ainda não decidida', async () => {
    const { fake, rest } = worldWith([{ proposal: approved('E2', [giveBack('SKU-1', 10)]), invoice: invoice(), proposalId: 1 }]);
    Object.assign(fake.rows('proposals')[0] ?? {}, { state: 'aguardando_aprovacao', approval_level: 'coordenacao' });
    expect(await supabaseDecidedReturnSource(rest).listDecided()).toEqual([]);
  });

  it('sem propostas decididas devolve lista vazia', async () => {
    const { rest } = worldWith([]);
    expect(await supabaseDecidedReturnSource(rest).listDecided()).toEqual([]);
  });
});
