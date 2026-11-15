// #156 A migração, o registro e o ADR-003 dizem o mesmo; sem Postgres local, o texto da migração é o que se confere offline.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../../../', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, ROOT), 'utf8');
const MIGRATION = 'supabase/migrations/20261116110000_return_note_emission.sql';
const ADR = 'docs/adr/ADR-003-return-note-emission-persistence.md';

describe('#156 a migração da emissão da nota de devolução', () => {
  it('#156/AC-4 revoga update, delete e truncate da reserva dos três papéis da API', () => {
    expect(read(MIGRATION)).toContain(
      'revoke update, delete, truncate on public.return_note_numbers from anon, authenticated, service_role;',
    );
  });

  it('#156/AC-4 constrói o índice de proposals por estado e id, para a leitura das decididas', () => {
    const sql = read(MIGRATION);
    expect(sql).toContain('create index proposals_state_id_idx on public.proposals (state, id);');
    expect(sql).toContain('state=in.(aprovada,alterada)');
  });

  it('#156/AC-4 aponta para o ADR-003 na migração e no registro, e o ADR existe com as três decisões', () => {
    expect(read(MIGRATION)).toContain('ADR-003');
    const registry = read('supabase/persistence-modes.yaml');
    expect(registry).toContain('ADR-003');
    // #156 Este desenho não decide o modo de proposals: o registro não a traz, e o índice fica no desenho.
    expect(registry).not.toMatch(/^ {2}proposals:/m);
    expect(registry).not.toContain('proposals_state_id_idx');
    expect(read('supabase/persistence-156-return-note-emission.md')).toContain('proposals_state_id_idx');
    expect(read('supabase/persistence-156-return-note-emission.md')).toContain('docs/adr/ADR-003-return-note-emission-persistence.md');
    expect(registry).not.toContain('UPDATE revogado de anon');
    expect(existsSync(new URL(ADR, ROOT))).toBe(true);
    const adr = read(ADR);
    for (const heading of ['**Status:** accepted', '**Date:** 2026-11-16', '## Context', '## Decision', '## Consequences', '## Alternatives considered']) {
      expect(adr).toContain(heading);
    }
  });
});
