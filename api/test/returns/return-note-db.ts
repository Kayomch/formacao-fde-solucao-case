// #156: o PostgREST falso com a nota de origem, as decisões e a fila, para os testes dos adaptadores da devolução.
import { dockActionToJson } from '../../src/approval/supabase-store.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import type { Invoice, Proposal } from '../../src/domain/index.js';
import { FakePostgrest } from '../support/fake-postgrest.js';

export type SeededDecision = { readonly proposal: Proposal; readonly invoice: Invoice; readonly proposalId: number };

export function invoiceRow(invoice: Invoice): Record<string, unknown> {
  return {
    access_key: invoice.accessKey,
    number: invoice.number,
    series: invoice.series,
    supplier_id: invoice.supplierId,
    store: invoice.store,
    issued_on: invoice.issuedOn,
    purchase_order_ref: invoice.purchaseOrderRef,
    entry_channel: invoice.entryChannel,
    total_cents: invoice.total.cents,
    items: invoice.items.map((i) => ({
      supplierCode: i.supplierCode,
      sku: i.sku,
      description: i.description,
      quantity: { amount: i.quantity.amount, unit: i.quantity.unit },
      unitPriceCents: i.unitPrice.cents,
      totalCents: i.total.cents,
    })),
    state: 'decidida',
  };
}

export function proposalRow(d: SeededDecision): Record<string, unknown> {
  return {
    id: d.proposalId,
    invoice_access_key: d.invoice.accessKey,
    classification: d.proposal.classification,
    dock_action: dockActionToJson(d.proposal.dockAction),
    approval_level: d.proposal.level,
    amount_at_risk_cents: 100,
    justification: d.proposal.justification,
    state: d.proposal.state,
    regua_line: null,
  };
}

export function worldWith(decisions: readonly SeededDecision[]): { fake: FakePostgrest; rest: SupabaseRest } {
  const fake = new FakePostgrest({
    invoices: [...new Map(decisions.map((d) => [d.invoice.accessKey, invoiceRow(d.invoice)])).values()],
    proposals: decisions.map(proposalRow),
  });
  return { fake, rest: new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: fake.fetch }) };
}
