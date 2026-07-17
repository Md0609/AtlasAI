/**
 * Rules evaluator (rules.v1) — every rule type exercised in both directions
 * (§48.2 discipline: the firing decision is deterministic and tested).
 */
import { describe, expect, it } from 'vitest';
import { evaluateRules, type RuleContext, type RuleInput } from '../src/rules.js';

const ctx: RuleContext = {
  lookThrough: [
    { securityId: 'aapl', label: 'Apple', weight: '0.22', viaDirect: '0.18', viaFunds: '0.04' },
    { securityId: 'msft', label: 'Microsoft', weight: '0.12', viaDirect: '0.12', viaFunds: '0' },
    { securityId: 'sie', label: 'Siemens', weight: '0.08', viaDirect: '0.08', viaFunds: '0' },
    { securityId: null, label: 'Unknown (no holdings data)', weight: '0.3', viaDirect: '0', viaFunds: '0.3' },
  ],
  sectorExposure: [
    { key: 'Information Technology', weight: '0.34', marketValueBase: '34000' },
    { key: 'Industrials', weight: '0.08', marketValueBase: '8000' },
    { key: 'UNKNOWN', weight: '0.3', marketValueBase: '30000' },
    { key: 'CASH', weight: '0.28', marketValueBase: '28000' },
  ],
  cashWeight: '0.28',
  directPositions: [
    { securityId: 'aapl', label: 'Apple' },
    { securityId: 'msft', label: 'Microsoft' },
    { securityId: 'sie', label: 'Siemens' },
  ],
  sells: [
    { securityId: 'msft', label: 'Microsoft', sellDate: '2026-06-01', firstBuyDate: '2026-02-01' },
    { securityId: 'sie', label: 'Siemens', sellDate: '2026-06-01', firstBuyDate: '2024-01-01' },
  ],
};

const evalOne = (rule: RuleInput) => evaluateRules([rule], ctx)[0]!;

describe('rules.v1 — deterministic evaluation of every type', () => {
  it('max_single_name breaches on the largest look-through name', () => {
    const breach = evalOne({ id: 'r1', ruleType: 'max_single_name', params: { limit: '0.15' } });
    expect(breach.status).toBe('breach');
    expect(breach.observed.value).toBe('0.22');
    expect(breach.observed.detail).toContain('Apple');

    const ok = evalOne({ id: 'r1', ruleType: 'max_single_name', params: { limit: '0.25' } });
    expect(ok.status).toBe('ok');
  });

  it('max_sector reads look-through sector exposure', () => {
    const breach = evalOne({
      id: 'r2',
      ruleType: 'max_sector',
      params: { sector: 'Information Technology', limit: '0.30' },
    });
    expect(breach.status).toBe('breach');
    const ok = evalOne({
      id: 'r2',
      ruleType: 'max_sector',
      params: { sector: 'Industrials', limit: '0.30' },
    });
    expect(ok.status).toBe('ok');
  });

  it('min_cash / max_cash bracket the cash weight', () => {
    expect(evalOne({ id: 'r3', ruleType: 'min_cash', params: { limit: '0.30' } }).status).toBe('breach');
    expect(evalOne({ id: 'r3', ruleType: 'min_cash', params: { limit: '0.05' } }).status).toBe('ok');
    expect(evalOne({ id: 'r4', ruleType: 'max_cash', params: { limit: '0.10' } }).status).toBe('breach');
    expect(evalOne({ id: 'r4', ruleType: 'max_cash', params: { limit: '0.50' } }).status).toBe('ok');
  });

  it('no_buy_list names the offending holdings', () => {
    const breach = evalOne({
      id: 'r5',
      ruleType: 'no_buy_list',
      params: { securityIds: ['sie', 'other'] },
    });
    expect(breach.status).toBe('breach');
    expect(breach.observed.detail).toContain('Siemens');
    const ok = evalOne({ id: 'r5', ruleType: 'no_buy_list', params: { securityIds: ['other'] } });
    expect(ok.status).toBe('ok');
  });

  it('max_positions counts direct positions, not look-through names', () => {
    expect(evalOne({ id: 'r6', ruleType: 'max_positions', params: { count: 2 } }).status).toBe('breach');
    expect(evalOne({ id: 'r6', ruleType: 'max_positions', params: { count: 3 } }).status).toBe('ok');
  });

  it('min_holding_period flags the early sell and names it', () => {
    const breach = evalOne({ id: 'r7', ruleType: 'min_holding_period', params: { months: 12 } });
    expect(breach.status).toBe('breach');
    expect(breach.observed.detail).toContain('Microsoft'); // 4 months
    expect(breach.observed.detail).not.toContain('Siemens'); // ~29 months
    const ok = evalOne({ id: 'r7', ruleType: 'min_holding_period', params: { months: 3 } });
    expect(ok.status).toBe('ok');
  });

  it('missing params produce not_evaluable, never a silent ok', () => {
    const r = evalOne({ id: 'r8', ruleType: 'max_single_name', params: {} });
    expect(r.status).toBe('not_evaluable');
  });

  it('is deterministic: identical input, identical output', () => {
    const rules: RuleInput[] = [
      { id: 'a', ruleType: 'max_single_name', params: { limit: '0.15' } },
      { id: 'b', ruleType: 'min_holding_period', params: { months: 12 } },
    ];
    expect(JSON.stringify(evaluateRules(rules, ctx))).toBe(JSON.stringify(evaluateRules(rules, ctx)));
  });
});
