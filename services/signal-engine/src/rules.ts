/**
 * Rules evaluator (F-05) — rules.v1. Deterministic, no LLM, no clock:
 * evaluation happens against pre-computed portfolio signals plus a
 * transaction-derived holding-period digest. The firing decision for a rule
 * is never probabilistic (§16.1 discipline applied to rules).
 *
 * Every rule type here maps 1:1 to a branch below; adding a rule type the
 * engine cannot evaluate is impossible by construction (US-ONB-05).
 */
import type {
  LookThroughRow,
  RuleEvaluationResult,
  RuleParams,
  RuleType,
  ExposureSlice,
} from '@atlas/contracts';
import { ZERO, dec, fixed, str } from '@atlas/domain';

export interface RuleInput {
  id: string;
  ruleType: RuleType;
  params: RuleParams;
}

/** One sell with the earliest buy date of that security at or before it. */
export interface SellRecord {
  securityId: string;
  label: string;
  sellDate: string; // YYYY-MM-DD
  firstBuyDate: string | null;
}

export interface RuleContext {
  lookThrough: LookThroughRow[];
  sectorExposure: ExposureSlice[];
  cashWeight: string;
  /** Direct position count (not look-through names). */
  directPositions: Array<{ securityId: string; label: string }>;
  sells: SellRecord[];
}

const MONTH_DAYS = 30.44; // mean Gregorian month; deterministic constant

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export function evaluateRules(rules: RuleInput[], ctx: RuleContext): RuleEvaluationResult[] {
  return rules.map((rule) => evaluateRule(rule, ctx));
}

function evaluateRule(rule: RuleInput, ctx: RuleContext): RuleEvaluationResult {
  const named = ctx.lookThrough.filter((r) => r.securityId !== null);
  switch (rule.ruleType) {
    case 'max_single_name': {
      const limit = rule.params.limit;
      if (!limit) return notEvaluable(rule.id, 'missing limit');
      let worst: LookThroughRow | null = null;
      for (const r of named) {
        if (!worst || dec(r.weight).gt(worst.weight)) worst = r;
      }
      if (!worst) return ok(rule.id, null, limit, 'no equity positions');
      const w = dec(worst.weight);
      const breach = w.gt(limit);
      return {
        ruleId: rule.id,
        status: breach ? 'breach' : 'ok',
        observed: {
          value: str(w),
          limit,
          detail: `${worst.label} at ${pct(w)} (look-through) vs limit ${pct(dec(limit))}`,
        },
      };
    }

    case 'max_sector': {
      const { limit, sector } = rule.params;
      if (!limit || !sector) return notEvaluable(rule.id, 'missing limit or sector');
      const slice = ctx.sectorExposure.find((s) => s.key === sector);
      const w = slice ? dec(slice.weight) : ZERO;
      return {
        ruleId: rule.id,
        status: w.gt(limit) ? 'breach' : 'ok',
        observed: {
          value: str(w),
          limit,
          detail: `${sector} at ${pct(w)} vs limit ${pct(dec(limit))}`,
        },
      };
    }

    case 'min_cash': {
      const limit = rule.params.limit;
      if (!limit) return notEvaluable(rule.id, 'missing limit');
      const w = dec(ctx.cashWeight);
      return {
        ruleId: rule.id,
        status: w.lt(limit) ? 'breach' : 'ok',
        observed: { value: str(w), limit, detail: `cash at ${pct(w)} vs minimum ${pct(dec(limit))}` },
      };
    }

    case 'max_cash': {
      const limit = rule.params.limit;
      if (!limit) return notEvaluable(rule.id, 'missing limit');
      const w = dec(ctx.cashWeight);
      return {
        ruleId: rule.id,
        status: w.gt(limit) ? 'breach' : 'ok',
        observed: { value: str(w), limit, detail: `cash at ${pct(w)} vs maximum ${pct(dec(limit))}` },
      };
    }

    case 'no_buy_list': {
      const list = rule.params.securityIds ?? [];
      if (list.length === 0) return notEvaluable(rule.id, 'empty no-buy list');
      const held = ctx.directPositions.filter((p) => list.includes(p.securityId));
      return {
        ruleId: rule.id,
        status: held.length > 0 ? 'breach' : 'ok',
        observed: {
          value: str(dec(held.length)),
          limit: '0',
          detail:
            held.length > 0
              ? `holding ${held.map((h) => h.label).join(', ')} from the no-buy list`
              : 'no listed security is held',
        },
      };
    }

    case 'max_positions': {
      const count = rule.params.count;
      if (!count) return notEvaluable(rule.id, 'missing count');
      const n = ctx.directPositions.length;
      return {
        ruleId: rule.id,
        status: n > count ? 'breach' : 'ok',
        observed: { value: str(dec(n)), limit: str(dec(count)), detail: `${n} positions vs limit ${count}` },
      };
    }

    case 'min_holding_period': {
      const months = rule.params.months;
      if (!months) return notEvaluable(rule.id, 'missing months');
      const violations: string[] = [];
      let shortest: number | null = null;
      for (const s of ctx.sells) {
        if (!s.firstBuyDate) continue; // sell without a recorded buy: not evaluable for this sell
        const heldMonths = daysBetween(s.firstBuyDate, s.sellDate) / MONTH_DAYS;
        if (shortest === null || heldMonths < shortest) shortest = heldMonths;
        if (heldMonths < months) {
          violations.push(`${s.label} sold ${s.sellDate} after ${heldMonths.toFixed(1)} months`);
        }
      }
      return {
        ruleId: rule.id,
        status: violations.length > 0 ? 'breach' : 'ok',
        observed: {
          value: shortest === null ? null : fixed(dec(shortest.toFixed(4)), 1),
          limit: str(dec(months)),
          detail:
            violations.length > 0 ? violations.join('; ') : 'no sell below the minimum holding period',
        },
      };
    }
  }
}

function ok(ruleId: string, value: string | null, limit: string | null, detail: string): RuleEvaluationResult {
  return { ruleId, status: 'ok', observed: { value, limit, detail } };
}

function notEvaluable(ruleId: string, reason: string): RuleEvaluationResult {
  return { ruleId, status: 'not_evaluable', observed: { value: null, limit: null, detail: reason } };
}

function pct(d: ReturnType<typeof dec>): string {
  return `${fixed(d.times(100), 1)}%`;
}
