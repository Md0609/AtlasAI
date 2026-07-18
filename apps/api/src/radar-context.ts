/**
 * Radar evaluation context assembly moved to @atlas/dataplane in Phase 4b so
 * the intelligence plane can share it without importing the API. Re-exported
 * here to keep existing api imports (radar-service, radar routes) unchanged.
 */
export { loadRadarContext, conditionSecurityIds } from '@atlas/dataplane';
