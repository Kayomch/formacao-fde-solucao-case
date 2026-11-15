import { DomainError } from './errors.js';
import type { InvoiceItem, InvoiceView } from './invoice.js';
import type { Proposal } from './proposal.js';
import type { Quantity } from './quantity.js';

/** A nota de devolução da decisão. Mesma forma do `ReturnNoteMessage` da caixa de saída do ERP. */
export type ReturnNote = {
  readonly invoiceAccessKey: string;
  readonly lines: readonly { readonly supplierCode: string; readonly quantity: Quantity }[];
  readonly reason: string;
};

const RETURNING = new Set(['E1', 'E2', 'E3']);

/** A chave da linha da doca: o SKU do item, ou o código do fornecedor quando não há SKU (E8). */
const keyOf = (item: InvoiceItem): string => item.sku ?? item.supplierCode;

/**
 * #156/AC-2: a devolução de uma decisão. Só E1, E2 e E3, aprovadas ou alteradas, com a ação receber
 * parcial e ao menos uma linha `devolver`; fora disso, `null`. As linhas `segurar` não entram.
 * A razão é texto fixo: a chave de idempotência da caixa de saída é o hash do conteúdo.
 */
export function returnNoteOfDecision(proposal: Proposal, invoice: InvoiceView): ReturnNote | null {
  if (!RETURNING.has(proposal.classification)) return null;
  if (proposal.state !== 'aprovada' && proposal.state !== 'alterada') return null;
  const action = proposal.dockAction;
  if (action.kind !== 'receber_parcial') return null;
  const given = action.lines.filter((l) => l.disposition === 'devolver');
  if (given.length === 0) return null;
  const lines = given.map((line) => {
    const item = invoice.items.find((i) => keyOf(i) === line.sku);
    if (item === undefined) {
      throw new DomainError(`Devolução: a linha ${line.sku} não está na nota ${invoice.number}`);
    }
    if (item.quantity.unit !== line.quantity.unit) {
      throw new DomainError(`Devolução: a linha ${line.sku} está em ${line.quantity.unit}, a nota em ${item.quantity.unit}`);
    }
    if (line.quantity.amount > item.quantity.amount) {
      throw new DomainError(`Devolução: a linha ${line.sku} devolve mais do que a nota ${invoice.number} cobra`);
    }
    return { supplierCode: item.supplierCode, quantity: line.quantity };
  });
  return {
    invoiceAccessKey: invoice.accessKey,
    lines,
    reason: `${proposal.classification} na nota ${invoice.number}: devolução das linhas devolvidas`,
  };
}

/** Os pesos do módulo 11 da NF-e: 2 a 9, da direita para a esquerda. */
const WEIGHTS = [2, 3, 4, 5, 6, 7, 8, 9];

/** O dígito verificador da chave de acesso: módulo 11 sobre os 43 dígitos; resto 0 ou 1 dá 0. */
export function accessKeyCheckDigit(first43: string): string {
  if (!/^\d{43}$/.test(first43)) throw new DomainError('Chave de acesso: o dígito verificador pede 43 dígitos');
  let sum = 0;
  for (let i = 0; i < 43; i += 1) {
    sum += Number(first43[42 - i]) * (WEIGHTS[i % 8] as number);
  }
  const rest = sum % 11;
  return String(rest < 2 ? 0 : 11 - rest);
}

export type AccessKeyParts = {
  readonly ufCode: string;
  /** AAAA-MM-DD */
  readonly issuedOn: string;
  readonly issuerCnpj: string;
  readonly series: number;
  readonly number: number;
};

const pad = (value: number, size: number): string => String(value).padStart(size, '0');

/** O código numérico de 8 dígitos sai das demais partes (FNV-1a), sem sorteio e sem relógio. */
function numericCode(base: string): string {
  let hash = 0x811c9dc5;
  for (const char of base) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193) >>> 0;
  }
  return pad(hash % 100_000_000, 8);
}

/**
 * #156/AC-4: a chave de acesso de 44 dígitos da nota emitida: UF, AAMM, CNPJ do emitente, modelo 55,
 * série, número, emissão normal (1), código numérico e dígito verificador. Mesmo layout das chaves do kit.
 */
export function returnAccessKey(parts: AccessKeyParts): string {
  if (!/^\d{2}$/.test(parts.ufCode)) throw new DomainError('Chave de acesso: a UF tem 2 dígitos');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(parts.issuedOn)) throw new DomainError('Chave de acesso: a data é AAAA-MM-DD');
  if (!/^\d{14}$/.test(parts.issuerCnpj)) throw new DomainError('Chave de acesso: o CNPJ do emitente tem 14 dígitos');
  if (!Number.isInteger(parts.series) || parts.series < 1 || parts.series > 999) {
    throw new DomainError(`Chave de acesso: a série ${parts.series} fora de 1 a 999`);
  }
  if (!Number.isInteger(parts.number) || parts.number < 1 || parts.number > 999_999_999) {
    throw new DomainError(`Chave de acesso: o número ${parts.number} fora de 1 a 999999999`);
  }
  const aamm = parts.issuedOn.slice(2, 4) + parts.issuedOn.slice(5, 7);
  const base = `${parts.ufCode}${aamm}${parts.issuerCnpj}55${pad(parts.series, 3)}${pad(parts.number, 9)}1`;
  const first43 = `${base}${numericCode(base)}`;
  return `${first43}${accessKeyCheckDigit(first43)}`;
}

/** O formato das notas do kit (`data/kit/notas.json`) mais os campos da devolução. */
export type ReturnNoteItemDocument = {
  readonly codigo_fornecedor: string; // ADR-001
  readonly sku: string | null; // ADR-001
  readonly descricao: string; // ADR-001
  readonly quantidade: number; // ADR-001
  readonly unidade: 'UN' | 'CX'; // ADR-001
  readonly preco_unitario: number; // ADR-001
  readonly valor: number; // ADR-001
};

export type ReturnNoteDocument = {
  readonly nota_id: string; // ADR-001
  readonly chave: string; // ADR-001
  readonly numero: number; // ADR-001
  readonly serie: number; // ADR-001
  readonly emitente: string; // ADR-001
  readonly fornecedor_id: string; // ADR-001
  readonly destino: string; // ADR-001
  readonly data_emissao: string; // ADR-001
  readonly nota_referenciada: string; // ADR-001
  readonly natureza: 'devolucao'; // ADR-001
  readonly itens: readonly ReturnNoteItemDocument[]; // ADR-001
  readonly valor_total: number; // ADR-001
};

export type IssueReturnNoteInput = {
  /** A entrada da fila da #140: as linhas e o valor da devolução, em centavos. */
  readonly queue: {
    readonly lines: readonly { readonly supplierCode: string; readonly quantity: Quantity }[];
    readonly valueCents: number;
  };
  readonly invoice: InvoiceView;
  readonly issuerCnpj: string;
  readonly number: number;
  readonly series: number;
  readonly accessKey: string;
  /** AAAA-MM-DD */
  readonly issuedOn: string;
};

/** Reais com duas casas a partir de centavos inteiros, sem acumular ponto flutuante. */
const reais = (cents: number): number => cents / 100;

/**
 * #156/AC-2: a nota de devolução no formato do kit, com só as linhas devolvidas e os dados do item da
 * nota de origem. O valor_total, somado em centavos, tem de ser o valor da devolução na fila.
 */
export function issueReturnNote(input: IssueReturnNoteInput): ReturnNoteDocument {
  const { queue, invoice } = input;
  if (!/^\d{44}$/.test(input.accessKey)) throw new DomainError('Nota de devolução: a chave tem 44 dígitos');
  const rows = queue.lines.map((line) => {
    const item = invoice.items.find((i) => i.supplierCode === line.supplierCode);
    if (item === undefined) {
      throw new DomainError(`Nota de devolução: a linha ${line.supplierCode} não está na nota ${invoice.number}`);
    }
    if (item.quantity.unit !== line.quantity.unit) {
      throw new DomainError(`Nota de devolução: a linha ${line.supplierCode} está em outra unidade que a da nota`);
    }
    const cents = Math.round(item.unitPrice.cents * line.quantity.amount);
    const document: ReturnNoteItemDocument = {
      codigo_fornecedor: item.supplierCode,
      sku: item.sku,
      descricao: item.description,
      quantidade: line.quantity.amount,
      unidade: line.quantity.unit,
      preco_unitario: reais(item.unitPrice.cents),
      valor: reais(cents),
    };
    return { cents, document };
  });
  const totalCents = rows.reduce((sum, row) => sum + row.cents, 0);
  if (totalCents !== queue.valueCents) {
    throw new DomainError(`Nota de devolução: o total ${totalCents} difere do valor da devolução na fila ${queue.valueCents}`);
  }
  return {
    nota_id: `ND-${pad(input.number, 4)}`,
    chave: input.accessKey,
    numero: input.number,
    serie: input.series,
    emitente: input.issuerCnpj,
    fornecedor_id: invoice.supplierId,
    destino: invoice.store,
    data_emissao: input.issuedOn,
    nota_referenciada: invoice.accessKey,
    natureza: 'devolucao',
    itens: rows.map((row) => row.document),
    valor_total: reais(totalCents),
  };
}
