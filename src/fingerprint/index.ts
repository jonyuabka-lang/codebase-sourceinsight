/**
 * Fingerprint-Enhanced Indexing Orchestrator
 *
 * Implements Source Insight's three-layer incremental indexing:
 *   Layer 1: CRC32 File Fingerprinting (skip unchanged files)
 *   Layer 2: Include Graph Propagation (fan-out header changes)
 *   Layer 3: Symbol Delta Computation (minimal DB updates)
 *
 * Integration point: hooks into ExtractionOrchestrator's sync flow.
 */

import * as fs from 'fs';
import * as path from 'path';
import { SqliteDatabase } from '../db/sqlite-adapter';
import { FingerprintStore, crc32, FileFingerprint, FingerprintCheckResult } from './fingerprint-store';
import { IncludeGraphStore, extractIncludes, IncludeEdge } from './include-graph';
import {
  computeFileDelta,
  computeEfficiencyMetrics,
  FileDelta,
  IndexEfficiencyMetrics,
} from './symbol-delta';
import type { Node, Edge } from '../types';

// ── Types ──────────────────────────────────────────────────────────────────

export interface FingerprintOrchestratorOptions {
  /** Enable Layer 1: fingerprint-based skip */
  enableFingerprinting?: boolean;
  /** Enable Layer 2: include-graph propagation */
  enableIncludeGraph?: boolean;
  /** Enable Layer 3: symbol-delta computation */
  enableSymbolDelta?: boolean;
  /** Average ms per file parse (for efficiency estimation) */
  avgParseTimeMs?: number;
}

export interface FingerprintSyncResult {
  /** Result of fingerprint check */
  check: {
    totalFiles: number;
    unchanged: number;
    modified: number;
    new: number;
    deleted: number;
  };
  /** Files that need re-indexing */
  filesToReindex: string[];
  /** Files that can be skipped */
  filesSkipped: string[];
  /** Delta results (if symbol delta enabled) */
  deltas?: FileDelta[];
  /** Efficiency metrics */
  efficiency: IndexEfficiencyMetrics;
  /** Wall-clock duration */
  durationMs: number;
}

export interface PreIndexResult {
  /** Fingerprints computed for current files */
  fingerprints: Map<string, { crc32: number; mtime_ms: number; size_bytes: number }>;
  /** Include edges extracted from source */
  includeEdges: Map<string, IncludeEdge[]>;
  /** Duration */
  durationMs: number;
}

// ── Orchestrator ──────────────────────────────────────────────────────────

export class FingerprintOrchestrator {
  readonly fingerprintStore: FingerprintStore;
  readonly includeGraphStore: IncludeGraphStore;
  private options: Required<FingerprintOrchestratorOptions>;

  constructor(db: SqliteDatabase, options: FingerprintOrchestratorOptions = {}) {
    this.fingerprintStore = new FingerprintStore(db);
    this.includeGraphStore = new IncludeGraphStore(db);
    this.options = {
      enableFingerprinting: options.enableFingerprinting ?? true,
      enableIncludeGraph: options.enableIncludeGraph ?? true,
      enableSymbolDelta: options.enableSymbolDelta ?? true,
      avgParseTimeMs: options.avgParseTimeMs ?? 15,
    };
  }

  initialize(): void {
    this.fingerprintStore.initialize();
    this.includeGraphStore.initialize();
  }

  // ── Pre-Index Phase (compute fingerprints + extract includes) ───────

  /**
   * Pre-index phase: compute fingerprints and extract includes for all files.
   * This is the equivalent of Source Insight's "scan project" phase.
   *
   * Call this BEFORE the main extraction/parse phase.
   */
  preIndex(filePaths: string[], rootDir: string): PreIndexResult {
    const startTime = Date.now();
    const fingerprints = new Map<string, { crc32: number; mtime_ms: number; size_bytes: number }>();
    const includeEdges = new Map<string, IncludeEdge[]>();

    for (const filePath of filePaths) {
      const absPath = path.join(rootDir, filePath);
      try {
        const stat = fs.statSync(absPath);
        const content = fs.readFileSync(absPath, 'utf-8');

        // Layer 1: Fingerprint
        fingerprints.set(filePath, {
          crc32: crc32(content),
          mtime_ms: stat.mtimeMs,
          size_bytes: stat.size,
        });

        // Layer 2: Extract includes
        if (this.options.enableIncludeGraph) {
          const includes = extractIncludes(content, filePath);
          if (includes.length > 0) {
            includeEdges.set(filePath, includes);
          }
        }
      } catch {
        // File unreadable — skip
      }
    }

    return {
      fingerprints,
      includeEdges,
      durationMs: Date.now() - startTime,
    };
  }

  // ── Check Phase (fingerprint comparison) ────────────────────────────

  /**
   * Check phase: compare current fingerprints against stored ones.
   * Returns classification of every file.
   */
  check(preIndexResult: PreIndexResult): FingerprintCheckResult[] {
    return this.fingerprintStore.checkAll(preIndexResult.fingerprints);
  }

  // ── Fan-out Phase (include propagation) ─────────────────────────────

  /**
   * Fan-out phase: propagate header changes to includers.
   *
   * First, update the include graph for all files being checked.
   * Then, for modified headers, find all affected includers.
   */
  fanOut(
    preIndexResult: PreIndexResult,
    checkResults: FingerprintCheckResult[],
    rootDir: string
  ): Set<string> {
    // Update include graph using batch operation (single DELETE + bulk INSERTs)
    this.includeGraphStore.batchReplaceIncludes(preIndexResult.includeEdges);

    // Build the dirty set from fingerprint check
    const dirtyFiles = new Set<string>();
    for (const r of checkResults) {
      if (r.status === 'modified' || r.status === 'new') {
        dirtyFiles.add(r.path);
      }
    }

    // Layer 2: Propagate header changes to includers
    if (this.options.enableIncludeGraph) {
      const propagatedDirty = this.includeGraphStore.getAffectedFilesBatch([...dirtyFiles]);

      // Only re-index files we have fingerprints for (avoids N existsSync calls)
      for (const f of propagatedDirty) {
        if (preIndexResult.fingerprints.has(f)) {
          dirtyFiles.add(f);
        }
      }
    }

    return dirtyFiles;
  }

  // ── Full Sync (all layers) ──────────────────────────────────────────

  /**
   * Full fingerprint-enhanced sync: the equivalent of Source Insight's
   * "synchronize project" operation.
   *
   * Flow:
   *   1. Pre-index: compute fingerprints + extract includes
   *   2. Check: compare against stored fingerprints
   *   3. Fan-out: propagate header changes
   *   4. (caller performs parse on dirty files)
   *   5. Update: store results
   */
  sync(
    filePaths: string[],
    rootDir: string,
    parseResults?: Map<string, { nodes: Node[]; edges: Edge[]; oldNodes?: Node[]; oldEdges?: Edge[] }>
  ): FingerprintSyncResult {
    const syncStart = Date.now();

    // Step 1: Pre-index
    const preIndexResult = this.preIndex(filePaths, rootDir);

    // Step 2: Check
    const checkResults = this.check(preIndexResult);

    // Step 3: Fan-out
    const filesToReindex = this.fanOut(preIndexResult, checkResults, rootDir);

    // Count results
    const counts = this.fingerprintStore.countDirty(checkResults);

    const filesSkipped: string[] = [];
    for (const r of checkResults) {
      if (r.status === 'unchanged') {
        filesSkipped.push(r.path);
      }
    }

    // Step 4: Update fingerprints for files that were checked
    for (const [filePath, fp] of preIndexResult.fingerprints) {
      const checkResult = checkResults.find(r => r.path === filePath);
      if (checkResult && checkResult.status !== 'deleted') {
        this.fingerprintStore.upsertFingerprint({
          file_path: filePath,
          crc32: fp.crc32,
          mtime_ms: fp.mtime_ms,
          size_bytes: fp.size_bytes,
          symbol_count: parseResults?.get(filePath)?.nodes.length ?? 0,
          updated_at: Date.now(),
        });
      }
    }

    // Remove deleted files
    for (const r of checkResults) {
      if (r.status === 'deleted') {
        this.fingerprintStore.removeFingerprint(r.path);
        this.includeGraphStore.removeIncludes(r.path);
      }
    }

    // Step 5: Compute symbol deltas (Layer 3)
    let deltas: FileDelta[] | undefined;
    if (this.options.enableSymbolDelta && parseResults) {
      deltas = [];
      for (const filePath of filesToReindex) {
        const result = parseResults.get(filePath);
        if (result && result.oldNodes && result.oldEdges) {
          const delta = computeFileDelta(
            filePath,
            result.oldNodes,
            result.nodes,
            result.oldEdges,
            result.edges
          );
          deltas.push(delta);
        }
      }
    }

    // Compute efficiency
    const efficiency = computeEfficiencyMetrics(
      filePaths.length,
      filesToReindex.size,
      deltas ?? [],
      this.options.avgParseTimeMs
    );

    return {
      check: {
        totalFiles: filePaths.length,
        unchanged: counts.unchanged,
        modified: counts.modified,
        new: counts.new,
        deleted: counts.deleted,
      },
      filesToReindex: [...filesToReindex],
      filesSkipped,
      deltas,
      efficiency,
      durationMs: Date.now() - syncStart,
    };
  }

  // ── Stats / Reporting ───────────────────────────────────────────────

  /**
   * Get comprehensive statistics across all three layers.
   */
  getStats() {
    const fpStats = this.fingerprintStore.getStats();
    const igStats = this.includeGraphStore.getStats();

    return {
      fingerprint: fpStats,
      includeGraph: igStats,
    };
  }

  /**
   * Format a human-readable efficiency report.
   */
  formatReport(result: FingerprintSyncResult): string {
    const lines: string[] = [
      '═══════════════════════════════════════════════',
      '  CodeGraph Fingerprint Sync Report',
      '═══════════════════════════════════════════════',
      '',
      `  Files checked:    ${result.check.totalFiles}`,
      `    Unchanged:      ${result.check.unchanged} (skipped)`,
      `    Modified:       ${result.check.modified}`,
      `    New:            ${result.check.new}`,
      `    Deleted:        ${result.check.deleted}`,
      `  Files to reindex: ${result.filesToReindex.length}`,
      `  Files skipped:    ${result.filesSkipped.length}`,
      '',
      '  ── Efficiency ──',
      `  File skip rate:   ${result.efficiency.fileSkipRate.toFixed(1)}%`,
      `  Symbol skip rate: ${result.efficiency.symbolSkipRate.toFixed(1)}%`,
      `  Est. time saved:  ${result.efficiency.estimatedTimeSavedMs.toFixed(0)}ms`,
      `  Total duration:   ${result.durationMs}ms`,
      '',
      '═══════════════════════════════════════════════',
    ];

    return lines.join('\n');
  }
}
