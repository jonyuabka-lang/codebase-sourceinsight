/**
 * Symbol Delta Computation
 *
 * Implements Source Insight's incremental indexing pattern:
 * Instead of fully re-indexing a file, compute the delta between old and new symbols.
 *
 * Delta computation uses a triple-key match:
 *   (name, kind, qualified_name) → determines identity
 *
 * Categories:
 *   - ADDED:    new symbol not in old set
 *   - REMOVED:  old symbol not in new set
 *   - MODIFIED: same identity but signature/position changed
 *   - UNCHANGED: same identity, same content
 *
 * Performance target: <0.1ms per symbol delta check (vs 2-5ms for full parse per file)
 */

import type { Node, Edge } from '../types';

// ── Types ──────────────────────────────────────────────────────────────────

export interface SymbolIdentity {
  name: string;
  kind: string;
  qualifiedName: string;
}

export interface SymbolDelta {
  added: Node[];
  removed: Node[];
  modified: { old: Node; new: Node }[];
  unchanged: number;
}

export interface EdgeDelta {
  added: Edge[];
  removed: Edge[];
  unchanged: number;
}

export interface FileDelta {
  filePath: string;
  symbols: SymbolDelta;
  edges: EdgeDelta;
  summary: {
    symbolsAdded: number;
    symbolsRemoved: number;
    symbolsModified: number;
    symbolsUnchanged: number;
    edgesAdded: number;
    edgesRemoved: number;
    edgesUnchanged: number;
  };
}

// ── Identity Computation ─────────────────────────────────────────────────

/**
 * Compute a stable identity key for a symbol.
 * Uses (name, kind, qualifiedName) as the identity triple.
 */
function identityKey(node: Node): string {
  return `${node.name}|${node.kind}|${node.qualifiedName || ''}`;
}

/**
 * Compute a content hash for change detection.
 * Uses signature + position to detect modifications.
 */
function contentKey(node: Node): string {
  return `${node.signature || ''}|${node.startLine}|${node.endLine}|${node.docstring || ''}`;
}

// ── Symbol Delta ─────────────────────────────────────────────────────────

/**
 * Compute symbol-level delta between old and new symbol sets.
 *
 * Algorithm:
 * 1. Build identity → content maps for old and new
 * 2. For each new symbol: if in old with same content → UNCHANGED
 *    if in old with different content → MODIFIED
 *    if not in old → ADDED
 * 3. Remaining old symbols not in new → REMOVED
 *
 * O(n + m) time, O(n + m) space.
 */
export function computeSymbolDelta(
  oldNodes: Node[],
  newNodes: Node[]
): SymbolDelta {
  // Build identity → (node, contentKey) maps
  const oldMap = new Map<string, { node: Node; contentKey: string }>();
  for (const node of oldNodes) {
    oldMap.set(identityKey(node), { node, contentKey: contentKey(node) });
  }

  const added: Node[] = [];
  const modified: { old: Node; new: Node }[] = [];
  let unchanged = 0;

  // Process new nodes
  const newKeysSeen = new Set<string>();
  for (const newNode of newNodes) {
    const key = identityKey(newNode);
    newKeysSeen.add(key);
    const oldEntry = oldMap.get(key);

    if (!oldEntry) {
      added.push(newNode);
    } else if (oldEntry.contentKey !== contentKey(newNode)) {
      modified.push({ old: oldEntry.node, new: newNode });
    } else {
      unchanged++;
    }
  }

  // Removed: old nodes not in new set
  const removed: Node[] = [];
  for (const [key, entry] of oldMap) {
    if (!newKeysSeen.has(key)) {
      removed.push(entry.node);
    }
  }

  return { added, removed, modified, unchanged };
}

// ── Edge Delta ───────────────────────────────────────────────────────────

/**
 * Compute edge-level delta.
 * Uses (source, target, kind) as the identity triple.
 */
function edgeIdentityKey(edge: Edge): string {
  return `${edge.source}|${edge.target}|${edge.kind}`;
}

/**
 * Compute edge delta between old and new edge sets.
 */
export function computeEdgeDelta(
  oldEdges: Edge[],
  newEdges: Edge[]
): EdgeDelta {
  const oldSet = new Set(oldEdges.map(edgeIdentityKey));
  const newSet = new Set(newEdges.map(edgeIdentityKey));

  const added: Edge[] = [];
  const removed: Edge[] = [];
  let unchanged = 0;

  for (const edge of newEdges) {
    const key = edgeIdentityKey(edge);
    if (oldSet.has(key)) {
      unchanged++;
    } else {
      added.push(edge);
    }
  }

  for (const edge of oldEdges) {
    const key = edgeIdentityKey(edge);
    if (!newSet.has(key)) {
      removed.push(edge);
    }
  }

  return { added, removed, unchanged };
}

// ── File Delta ───────────────────────────────────────────────────────────

/**
 * Compute full file delta including symbols and edges.
 */
export function computeFileDelta(
  filePath: string,
  oldNodes: Node[],
  newNodes: Node[],
  oldEdges: Edge[],
  newEdges: Edge[]
): FileDelta {
  const symbols = computeSymbolDelta(oldNodes, newNodes);
  const edges = computeEdgeDelta(oldEdges, newEdges);

  return {
    filePath,
    symbols,
    edges,
    summary: {
      symbolsAdded: symbols.added.length,
      symbolsRemoved: symbols.removed.length,
      symbolsModified: symbols.modified.length,
      symbolsUnchanged: symbols.unchanged,
      edgesAdded: edges.added.length,
      edgesRemoved: edges.removed.length,
      edgesUnchanged: edges.unchanged,
    },
  };
}

// ── Batch Delta ──────────────────────────────────────────────────────────

export interface BatchDeltaResult {
  files: FileDelta[];
  totals: {
    filesProcessed: number;
    symbolsAdded: number;
    symbolsRemoved: number;
    symbolsModified: number;
    symbolsUnchanged: number;
    edgesAdded: number;
    edgesRemoved: number;
    edgesUnchanged: number;
  };
}

/**
 * Compute deltas for multiple files.
 */
export function computeBatchDelta(
  deltas: { filePath: string; oldNodes: Node[]; newNodes: Node[]; oldEdges: Edge[]; newEdges: Edge[] }[]
): BatchDeltaResult {
  const files: FileDelta[] = [];
  const totals = {
    filesProcessed: deltas.length,
    symbolsAdded: 0,
    symbolsRemoved: 0,
    symbolsModified: 0,
    symbolsUnchanged: 0,
    edgesAdded: 0,
    edgesRemoved: 0,
    edgesUnchanged: 0,
  };

  for (const d of deltas) {
    const fileDelta = computeFileDelta(d.filePath, d.oldNodes, d.newNodes, d.oldEdges, d.newEdges);
    files.push(fileDelta);
    totals.symbolsAdded += fileDelta.summary.symbolsAdded;
    totals.symbolsRemoved += fileDelta.summary.symbolsRemoved;
    totals.symbolsModified += fileDelta.summary.symbolsModified;
    totals.symbolsUnchanged += fileDelta.summary.symbolsUnchanged;
    totals.edgesAdded += fileDelta.summary.edgesAdded;
    totals.edgesRemoved += fileDelta.summary.edgesRemoved;
    totals.edgesUnchanged += fileDelta.summary.edgesUnchanged;
  }

  return { files, totals };
}

// ── Source Insight-compatible metrics ─────────────────────────────────────

/**
 * Compute efficiency metrics comparable to Source Insight's internal stats.
 */
export interface IndexEfficiencyMetrics {
  /** Files that were skipped (fingerprint unchanged) */
  filesSkipped: number;
  /** Files that needed re-indexing */
  filesReindexed: number;
  /** Symbols that were unchanged (delta computation avoided DB write) */
  symbolsSkipped: number;
  /** Symbols that were added/removed/modified */
  symbolsUpdated: number;
  /** Ratio: (filesSkipped / totalFiles) * 100 */
  fileSkipRate: number;
  /** Ratio: (symbolsSkipped / totalSymbols) * 100 */
  symbolSkipRate: number;
  /** Estimated time saved vs full re-index (ms) */
  estimatedTimeSavedMs: number;
}

export function computeEfficiencyMetrics(
  totalFiles: number,
  filesNeedingReindex: number,
  deltas: FileDelta[],
  avgParseTimePerFileMs: number = 15,
  avgDbWritePerSymbolMs: number = 0.05
): IndexEfficiencyMetrics {
  const filesSkipped = totalFiles - filesNeedingReindex;
  const fileSkipRate = totalFiles > 0 ? (filesSkipped / totalFiles) * 100 : 0;

  let totalSymbols = 0;
  let symbolsSkipped = 0;
  let symbolsUpdated = 0;

  for (const d of deltas) {
    symbolsSkipped += d.summary.symbolsUnchanged;
    symbolsUpdated += d.summary.symbolsAdded + d.summary.symbolsRemoved + d.summary.symbolsModified;
    totalSymbols += d.summary.symbolsUnchanged + d.summary.symbolsAdded;
  }

  const symbolSkipRate = totalSymbols > 0 ? (symbolsSkipped / totalSymbols) * 100 : 0;

  // Time saved = (files skipped × avg parse time) + (symbols skipped × avg DB write time)
  const estimatedTimeSavedMs =
    filesSkipped * avgParseTimePerFileMs +
    symbolsSkipped * avgDbWritePerSymbolMs;

  return {
    filesSkipped,
    filesReindexed: filesNeedingReindex,
    symbolsSkipped,
    symbolsUpdated,
    fileSkipRate,
    symbolSkipRate,
    estimatedTimeSavedMs,
  };
}
