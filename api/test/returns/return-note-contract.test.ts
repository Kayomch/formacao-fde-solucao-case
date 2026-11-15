// #156/AC-2: o contrato autorado da nota de devolução emitida; a nota emitida de ponta a ponta o cumpre.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { tick } from '../../src/cron/tick.js';
import { returnNoteEmission } from '../../src/returns/return-note-emission.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitTables } from '../support/kit.js';

type Rule = {
  type: string;
  pattern?: string;
  enum?: string[];
  minimum?: number;
  exclusiveMinimum?: number;
  minItems?: number;
  nullable?: boolean;
  items?: string;
};
type Contract = {
  kit_keys_not_carried: string[];
  extra_keys: string[];
  fields: Record<string, Rule>;
  item: Record<string, Rule>;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isRuleMap = (v: unknown): v is Record<string, Rule> =>
  isRecord(v) && Object.values(v).every((r) => isRecord(r) && typeof r.type === 'string');
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
}

function loadContract(): Contract {
  const raw = readJson('./return-note-contract.json');
  if (!isRecord(raw) || !isRuleMap(raw.fields) || !isRuleMap(raw.item) || !isStrings(raw.kit_keys_not_carried) || !isStrings(raw.extra_keys)) {
    throw new Error('contrato da nota de devolução malformado');
  }
  return { kit_keys_not_carried: raw.kit_keys_not_carried, extra_keys: raw.extra_keys, fields: raw.fields, item: raw.item };
}

const isMoney = (v: unknown): boolean => typeof v === 'number' && Math.round(v * 100) / 100 === v;

/** #156 As violações do valor contra a regra; vazio quando cumpre. */
function violations(name: string, value: unknown, rule: Rule): string[] {
  if (value === null) return rule.nullable === true ? [] : [`${name}: nulo`];
  const bad: string[] = [];
  if (rule.type === 'money') return isMoney(value) ? [] : [`${name}: dinheiro com mais de 2 casas`];
  if (rule.type === 'string' && typeof value !== 'string') return [`${name}: não é texto`];
  if ((rule.type === 'number' || rule.type === 'integer') && typeof value !== 'number') return [`${name}: não é número`];
  if (rule.type === 'integer' && !Number.isInteger(value)) bad.push(`${name}: não é inteiro`);
  if (rule.type === 'array' && !Array.isArray(value)) return [`${name}: não é lista`];
  if (rule.pattern !== undefined && !new RegExp(rule.pattern).test(String(value))) bad.push(`${name}: fora do padrão`);
  if (rule.enum !== undefined && !rule.enum.includes(String(value))) bad.push(`${name}: fora do enum`);
  if (rule.minimum !== undefined && Number(value) < rule.minimum) bad.push(`${name}: abaixo do mínimo`);
  if (rule.exclusiveMinimum !== undefined && Number(value) <= rule.exclusiveMinimum) bad.push(`${name}: não passa do mínimo`);
  if (rule.minItems !== undefined && Array.isArray(value) && value.length < rule.minItems) bad.push(`${name}: poucos itens`);
  return bad;
}

function validate(note: unknown, contract: Contract): string[] {
  if (!isRecord(note)) return ['nota: não é objeto'];
  const bad = shapeViolations('nota', note, contract.fields);
  const itens = note.itens;
  if (Array.isArray(itens)) {
    itens.forEach((item, i) => bad.push(...(isRecord(item) ? shapeViolations(`itens[${i}]`, item, contract.item) : [`itens[${i}]: não é objeto`])));
  }
  return bad;
}

function shapeViolations(where: string, value: Record<string, unknown>, rules: Record<string, Rule>): string[] {
  const extra = Object.keys(value).filter((k) => !(k in rules)).map((k) => `${where}.${k}: chave fora do contrato`);
  const checks = Object.entries(rules).flatMap(([key, rule]) => (key in value ? violations(`${where}.${key}`, value[key], rule) : [`${where}.${key}: falta`]));
  return [...extra, ...checks];
}

const ENV = { BARTE_ACADEMY_SUPABASE_URL: 'https://fake.supabase.co', BARTE_ACADEMY_SUPABASE_SECRET_KEY: 'sb_secret_fake' };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function emittedNote(): Promise<unknown> {
  const fake = new FakePostgrest(kitTables());
  vi.stubGlobal('fetch', fake.fetch);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const rest = new SupabaseRest({ url: ENV.BARTE_ACADEMY_SUPABASE_URL, secretKey: ENV.BARTE_ACADEMY_SUPABASE_SECRET_KEY, fetch: fake.fetch });
  await tick({ cron: 'x' }, ENV);
  await rest.update('proposals', { id: 'eq.3' }, { state: 'aprovada' }); // ADR-002
  await tick({ cron: 'x' }, ENV);
  const id = Number(fake.rows('outbox_return_notes')[0]?.id);
  const result = await returnNoteEmission(rest)({ id, by: 'fiscal@exemplo.test', now: new Date('2026-11-16T13:00:00Z') });
  if (result.kind !== 'emitted') throw new Error(`emissão não saiu: ${result.kind}`);
  return result.note;
}

describe('contrato da nota de devolução emitida', () => {
  it('#156/AC-2 a nota emitida de ponta a ponta cumpre o contrato autorado', async () => {
    expect(validate(await emittedNote(), loadContract())).toEqual([]);
  });

  it('#156/AC-2 o contrato recusa uma nota sem a chave de 44 dígitos e com dinheiro de 3 casas', async () => {
    const note = await emittedNote();
    if (!isRecord(note)) throw new Error('nota malformada');
    const broken = { ...note, chave: '123', valor_total: 10.123 };
    expect(validate(broken, loadContract())).toEqual(['nota.chave: fora do padrão', 'nota.valor_total: dinheiro com mais de 2 casas']);
  });

  it('#156/AC-2 as chaves da nota são as da nota do kit, menos as não levadas, mais as da devolução', () => {
    const contract = loadContract();
    const kit = readJson('../../../data/kit/notas.json');
    const first = Array.isArray(kit) ? kit[0] : null;
    if (!isRecord(first)) throw new Error('kit: notas.json sem nota');
    const expected = [...Object.keys(first).filter((k) => !contract.kit_keys_not_carried.includes(k)), ...contract.extra_keys].sort();
    expect(Object.keys(contract.fields).sort()).toEqual(expected);
  });

  it('#156/AC-2 as chaves do item são as do item de uma nota real do kit', () => {
    const contract = loadContract();
    const kit = readJson('../../../data/kit/notas.json');
    const items = Array.isArray(kit) && isRecord(kit[0]) ? kit[0].itens : null;
    const firstItem = Array.isArray(items) ? items[0] : null;
    if (!isRecord(firstItem)) throw new Error('kit: nota sem item');
    expect(Object.keys(contract.item).sort()).toEqual(Object.keys(firstItem).sort());
  });
});
