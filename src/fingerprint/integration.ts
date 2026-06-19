/**
 * CodeGraph Extraction Pipeline Integration
 *
 * Hooks FingerprintOrchestrator (L1+L2+L3) into ExtractionOrchestrator.sync().
 * This is a drop-in patch — the existing sync flow continues to work.
 *
 * To activate, pass { fingerprint: true } to ExtractionOrchestrator options.
 */

import * as path from 'path';
import { FingerprintOrchestrator, FingerprintSyncResult } from './index';
import { DatabaseConnection } from '../db';

// Re-export for convenience
export { FingerprintOrchestrator, FingerprintSyncResult };
export { FingerprintStore } from './fingerprint-store';
export { IncludeGraphStore, extractIncludes } from './include-graph';
export { computeSymbolDelta, computeEdgeDelta } from './symbol-delta';

/**
 * Patch: augment ExtractionOrchestrator.sync() with fingerprint-enhanced flow.
 *
 * Usage:
 *   const orch = new ExtractionOrchestrator(db, { fingerprint: true });
 *   const result = await orch.syncAll();  // now uses 3-layer pipeline
 *
 * Without { fingerprint: true }, behavior is unchanged (backward compatible).
 */
export interface FingerprintIntegrationOptions {
  /** Enable fingerprint-enhanced incremental indexing */
  enabled: boolean;
  /** Root directory for file path resolution */
  rootDir: string;
}

/**
 * Create a FingerprintOrchestrator bound to the given DB.
 */
export function createFingerprintOrchestrator(
  db: DatabaseConnection,
  rootDir: string
): FingerprintOrchestrator {
  const orch = new FingerprintOrchestrator(db.getDb(), {
    enableFingerprinting: true,
    enableIncludeGraph: true,
    enableSymbolDelta: true,
  });
  orch.initialize();
  return orch;
}

/**
 * Pre-index hook: compute fingerprints and extract includes.
 * Call before the main parse phase.
 */
export function preIndexFiles(
  orchestrator: FingerprintOrchestrator,
  filePaths: string[],
  rootDir: string
) {
  return orchestrator.preIndex(filePaths, rootDir);
}

/**
 * Post-parse hook: update fingerprints, compute deltas, generate report.
 * Call after the main parse phase with parse results.
 */
export function postIndexUpdate(
  orchestrator: FingerprintOrchestrator,
  filePaths: string[],
  rootDir: string,
  parseResults: Map<string, { nodes: any[]; edges: any[]; oldNodes?: any[]; oldEdges?: any[] }>
): FingerprintSyncResult {
  return orchestrator.sync(filePaths, rootDir, parseResults);
}

/**
 * Format a human-readable efficiency report.
 */
export function formatReport(orchestrator: FingerprintOrchestrator, result: FingerprintSyncResult): string {
  return orchestrator.formatReport(result);
}
