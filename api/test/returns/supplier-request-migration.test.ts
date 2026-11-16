// #156 A migração do pedido ao fornecedor, o domínio, o registro e o ADR-005 dizem o mesmo; sem Postgres local, o texto da migração se confere offline (T8, T9).
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isOpenRequest, type SupplierRequestStatus } from '../../src/domain/index.js';

const ROOT = new URL('../../../', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, ROOT), 'utf8');
const MIGRATION = 'supabase/migrations/20261116120000_supplier_requests.sql';
const ADR = 'docs/adr/ADR-005-supplier-request-persistence.md';

/** #156 Todo status do domínio, e só eles: o tipo não deixa faltar nem sobrar um. */
const STATUSES = ['draft', 'sent', 'discarded', 'send_failed'] as const satisfies readonly SupplierRequestStatus[];
type Missing = Exclude<SupplierRequestStatus, (typeof STATUSES)[number]>;
const complete: Missing extends never ? true : false = true;

describe('#156 a migração do pedido ao fornecedor', () => {
  it('#156/AC-1 T8 semeia exatamente os fornecedores do kit, com e-mail do domínio .test', () => {
    expect(complete).toBe(true);
    const sql = read(MIGRATION);
    const seeded = [...sql.matchAll(/^\s*\('(F\d{2})', '([^']+)'\)[,;]$/gm)];
    const kit = (JSON.parse(read('data/kit/fornecedores.json')) as { fornecedor_id: string }[]).map((f) => f.fornecedor_id); // ADR-001
    expect(seeded.map((m) => m[1])).toEqual(kit);
    for (const [, id, email] of seeded) expect(email).toBe(`fiscal.${(id ?? '').toLowerCase()}@fornecedores.test`);
  });

  it('#156/AC-8 T9 o índice parcial é o do domínio: único por nota e tipo, onde status <> discarded', () => {
    const sql = read(MIGRATION);
    expect(sql).toMatch(
      /create unique index outbox_supplier_emails_open_request_key\s+on public\.outbox_supplier_emails \(invoice_access_key, request_type\)\s+where status <> 'discarded';/,
    );
    for (const status of STATUSES) expect(isOpenRequest(status)).toBe(status !== 'discarded');
  });

  it('#156/AC-8 T9 a lista da checagem de status é a de SupplierRequestStatus', () => {
    const check = /outbox_supplier_emails_status_check check \(status in \(([^)]*)\)\)/.exec(read(MIGRATION));
    const listed = [...(check?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect([...listed].sort()).toEqual([...STATUSES].sort());
  });

  it('#156 revoga a escrita do contato e a alteração da história dos papéis da API', () => {
    const sql = read(MIGRATION);
    expect(sql).toContain('revoke insert, update, delete, truncate on public.supplier_contacts from anon, authenticated, service_role;');
    expect(sql).toContain('revoke update, delete, truncate on public.outbox_supplier_email_history from anon, authenticated, service_role;');
  });

  it('#156 o prazo não tem padrão, a versão é guardada por gatilho e a história por outro, no mesmo comando', () => {
    const sql = read(MIGRATION);
    expect(sql).toMatch(/due_on date not null,/);
    expect(sql).toContain('before insert or update on public.outbox_supplier_emails');
    expect(sql).toContain('after insert or update on public.outbox_supplier_emails');
    expect(sql).toContain('outbox_return_notes_invoice_access_key_idx');
  });

  it('#156 toda linha de comentário da migração aponta para a #156', () => {
    const comments = read(MIGRATION).split('\n').filter((l) => l.trimStart().startsWith('--'));
    expect(comments.length).toBeGreaterThan(0);
    for (const line of comments) expect(line).toContain('#156');
  });

  it('#156 T9 a migração cita o ADR-005, o registro traz as três tabelas e o ADR existe com as seções', () => {
    expect(read(MIGRATION)).toContain('ADR-005');
    const registry = read('supabase/persistence-modes.yaml');
    for (const table of ['supplier_contacts', 'outbox_supplier_emails', 'outbox_supplier_email_history']) {
      expect(registry).toMatch(new RegExp(`^ {2}${table}:`, 'm'));
    }
    expect(existsSync(new URL(ADR, ROOT))).toBe(true);
    const adr = read(ADR);
    for (const heading of ['**Status:** accepted', '## Context', '## Decision', '## Consequences', '## Alternatives considered']) {
      expect(adr).toContain(heading);
    }
  });
});
