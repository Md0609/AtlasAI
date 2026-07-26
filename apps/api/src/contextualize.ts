/**
 * POST /v1/contextualize (§31.2) — "is X right for me". Runs the orchestrator
 * (Layer-1 specialists → Red Team → PSA → egress guard) and returns the
 * intelligence envelope (§31.4): confidence, provenance and gaps are required,
 * non-nullable fields — the API physically cannot express a confident,
 * unsourced, gap-free claim.
 *
 * Provider-agnostic: whichever LLM backs the runtime (fixture in dev/test,
 * Anthropic in prod) produces the same envelope.
 *
 * Every successful contextualization is PERSISTED before it is returned (P0-8).
 * §51.4: "the data model and the event capture ship at MVP, because
 * retrofitting them would mean the first 12 months of claims are ungradeable
 * forever." The v1.1 Scorecard (F-34) is a nightly job over that table; without
 * the rows there is nothing to grade and no way to recover them. This is
 * capture only — the grader is not built here.
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

    /**
     * Record before responding, and let a failure here fail the request.
     *
     * The alternative — persist best-effort and answer anyway — would silently
     * produce exactly the state §51.4 warns about: claims shown to users that
     * were never recorded, discovered a year later when the Scorecard has
     * nothing to grade. A user seeing an error is recoverable; an ungradeable
     * year is not.
     */
    await pool.query(
      `INSERT INTO contextualizations (
         user_id, security_id, doc, rendered_text,
         confidence_level, what_would_change_it, gaps,
         guard_verdict, guard_ruleset_version, guard_classifier_version,
         generator_agent, generator_prompt_version, generator_model,
         generative, degraded, output_hash, trace_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        user.id,
        parsed.data.security_id,
        JSON.stringify(doc),
        // What the user actually read. Not always the doc: egress may have
        // substituted the safe fallback (FR-12.4 — reconstruct any OUTPUT
        // SHOWN, not merely the output generated).
        ufc.text,
        doc.confidence.level,
        JSON.stringify(doc.confidence.whatWouldChangeIt),
        JSON.stringify(gaps),
        ufc.guard.approved ? 'approved' : 'rejected',
        ufc.guard.rulesetVersion,
        ufc.guard.classifierVersion,
        'psa',
        result.psa.promptVersion,
        result.psa.model,
        result.psa.generative,
        result.psa.degraded,
        // The egress module's own hash of what it emitted: the cheapest way to
        // prove a stored row matches what was shown (FR-12.4).
        ufc.outputHash,
        result.traceId,
      ],
    );

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
