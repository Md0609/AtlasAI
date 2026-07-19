/**
 * POST /v1/contextualize (§31.2) — "is X right for me". Runs the orchestrator
 * (Layer-1 specialists → Red Team → PSA → egress guard) and returns the
 * intelligence envelope (§31.4): confidence, provenance and gaps are required,
 * non-nullable fields — the API physically cannot express a confident,
 * unsourced, gap-free claim.
 *
 * Provider-agnostic: whichever LLM backs the runtime (fixture in dev/test,
 * Anthropic in prod) produces the same envelope.
 */
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { contextualize } from '@atlas/agents';
import { isRejected, type UserFacingContent } from '@atlas/egress';
import { requireUser } from './auth.js';
import { problem } from './http.js';

const schema = z.object({ security_id: z.string().uuid() });

export function registerContextualizeRoutes(app: FastifyInstance, pool: pg.Pool): void {
  app.post('/v1/contextualize', async (req, reply) => {
    const user = requireUser(req, reply);
    if (!user) return;
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return problem(reply, req, 400, 'validation', 'security_id is required');
    }
    const sec = await pool.query(`SELECT 1 FROM securities WHERE id = $1`, [parsed.data.security_id]);
    if (sec.rows.length === 0) return problem(reply, req, 404, 'not-found', 'Security not found');

    const result = await contextualize(pool, {
      userId: user.id,
      baseCurrency: user.baseCurrency,
      securityId: parsed.data.security_id,
    });

    if (isRejected(result.egress)) {
      // Both the model output and the safe fallback failed the guard — the
      // honest response is the §31.5 guard-rejection, not a fabricated answer.
      return problem(
        reply,
        req,
        422,
        'guard-rejection',
        'Output could not be safely generated',
        'Atlas could not contextualize this without crossing the line into a recommendation.',
      );
    }

    const ufc: UserFacingContent = result.egress;
    const doc = result.psa.doc;

    const provenance = Object.entries(doc.signals).map(([signalId, v]) => ({
      claim_id: signalId,
      sources: [
        {
          methodology: v.provenance.methodology,
          engine_version: v.provenance.engineVersion,
          input_hash: v.provenance.inputHash,
        },
      ],
    }));
    const gaps = result.findings
      .filter((f) => f.confidence === 'insufficient' || f.kind.endsWith('.gap'))
      .map((f) => ({ component: f.agent, reason: f.statement }));

    return reply.send({
      data: {
        text: ufc.text,
        sections: ufc.sections,
        security_id: parsed.data.security_id,
      },
      confidence: {
        level: doc.confidence.level,
        what_would_change_it: doc.confidence.whatWouldChangeIt,
      },
      provenance,
      gaps,
      guard: {
        verdict: ufc.guard.approved ? 'approved' : 'rejected',
        ruleset_version: ufc.guard.rulesetVersion,
        classifier_version: ufc.guard.classifierVersion,
        classifier_score: ufc.guard.classifierScore,
        degraded: result.psa.degraded,
      },
      generated_at: new Date().toISOString(),
    });
  });
}
