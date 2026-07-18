/**
 * @atlas/workers — queue consumers for the commitment loop (Design §B1
 * Phase 3). buildRunner wires every topic; drain() makes the whole chain
 * synchronously testable and is what the CLI's run-once mode calls.
 */
import type pg from 'pg';
import { WorkerRunner } from './runner.js';
import { handleSecurityChanged, handleUserRecompute } from './handlers.js';
import { handleRadarEvaluate } from './radar-worker.js';
import { handleBriefGenerate, handleNotifyDispatch } from './brief-worker.js';

export function buildRunner(pool: pg.Pool): WorkerRunner {
  return new WorkerRunner(pool)
    .register('security.changed', handleSecurityChanged)
    .register('user.recompute', handleUserRecompute)
    .register('radar.evaluate', handleRadarEvaluate)
    .register('brief.generate', handleBriefGenerate)
    .register('notify.dispatch', handleNotifyDispatch);
}

export { WorkerRunner } from './runner.js';
export { handleSecurityChanged, handleUserRecompute } from './handlers.js';
export { handleRadarEvaluate } from './radar-worker.js';
export { handleBriefGenerate, handleNotifyDispatch } from './brief-worker.js';
