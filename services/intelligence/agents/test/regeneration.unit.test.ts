/**
 * The regeneration loop mechanics (§21.6), in isolation: retry until approved,
 * the retry LIMIT, the regeneration count, and that each attempt receives the
 * prior attempt's violations (so it can correct them).
 */
import { describe, expect, it, vi } from 'vitest';
import type { GuardVerdict } from '@atlas/contracts';
import { MAX_REGENERATIONS, correctionForViolations, withRegeneration } from '../src/index.js';

const violation = (code: string): GuardVerdict['violations'][number] => ({
  layer: 'lexical',
  code,
  detail: `blocked: ${code}`,
});

describe('withRegeneration (§21.6)', () => {
  it('approves on the first try ⇒ zero regenerations, no retry', async () => {
    const attempt = vi.fn(async () => ({ approved: true, result: 'ok', violations: [] }));
    const out = await withRegeneration(attempt);
    expect(out).toEqual({ result: 'ok', approved: true, regenerations: 0 });
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('regenerates until the Guard approves, counting the regenerations', async () => {
    const attempt = vi.fn(async (i: number) => ({
      approved: i === 2,
      result: `attempt-${i}`,
      violations: i === 2 ? [] : [violation('lex.directive')],
    }));
    const out = await withRegeneration(attempt);
    expect(out.approved).toBe(true);
    expect(out.regenerations).toBe(2);
    expect(out.result).toBe('attempt-2');
    expect(attempt).toHaveBeenCalledTimes(3); // initial + 2 regenerations
  });

  it('stops at the retry limit and returns un-approved for the caller to degrade', async () => {
    const attempt = vi.fn(async (i: number) => ({
      approved: false,
      result: `attempt-${i}`,
      violations: [violation('lex.directive')],
    }));
    const out = await withRegeneration(attempt);
    expect(out.approved).toBe(false);
    expect(out.regenerations).toBe(MAX_REGENERATIONS);
    // §21.6: regenerate ≤2 ⇒ at most 3 total attempts, never more.
    expect(attempt).toHaveBeenCalledTimes(MAX_REGENERATIONS + 1);
  });

  it('feeds the prior attempt\'s violations into the next attempt', async () => {
    const seen: string[][] = [];
    const attempt = vi.fn(async (i: number, prior: GuardVerdict['violations']) => {
      seen.push(prior.map((v) => v.code));
      return { approved: i === 1, result: 'x', violations: i === 0 ? [violation('lex.rating')] : [] };
    });
    await withRegeneration(attempt);
    expect(seen[0]).toEqual([]); // first attempt has no prior
    expect(seen[1]).toEqual(['lex.rating']); // regeneration gets the specifics
  });

  it('honours a custom regeneration budget', async () => {
    const attempt = vi.fn(async (i: number) => ({ approved: false, result: `a${i}`, violations: [] }));
    const out = await withRegeneration(attempt, 1);
    expect(out.regenerations).toBe(1);
    expect(attempt).toHaveBeenCalledTimes(2);
  });
});

describe('correctionForViolations', () => {
  it('renders the specific violations as a corrective instruction', () => {
    const text = correctionForViolations([violation('lex.directive_second_person')]);
    expect(text).toContain('lex.directive_second_person');
    expect(text).toContain('compliance guard');
  });

  it('is empty when there is nothing to correct', () => {
    expect(correctionForViolations([])).toBe('');
  });
});
