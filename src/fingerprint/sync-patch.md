# Integration Patch for ExtractionOrchestrator.sync()

## Integration Points (src/extraction/index.ts)

### Point 1: After line 1355 — Fingerprint Pre-Index
```typescript
// === PATCH START: Fingerprint pre-index ===
if (this.options.fingerprint?.enabled) {
  const fpo = this._fingerprintOrchestrator;
  // Compute CRC32 fingerprints + extract includes for ALL files
  const preIdx = fpo.preIndex(currentFiles, this.rootDir);
  this._preIndexCache = preIdx; // cache for later delta computation
  onProgress?.({ phase: 'scanning', current: currentFiles.length, total: currentFiles.length,
    currentFile: `Fingerprinting: ${preIdx.fingerprints.size} files, ${preIdx.includeEdges.size} with includes` });
}
// === PATCH END ===
```

### Point 2: Replace lines 1376-1416 — Fingerprint-based skip
```typescript
// === PATCH START: Fingerprint-enhanced change detection ===
if (this.options.fingerprint?.enabled && this._preIndexCache) {
  const fpo = this._fingerprintOrchestrator;
  const checkResults = fpo.check(this._preIndexCache);
  const filesToReindex = fpo.fanOut(this._preIndexCache, checkResults, this.rootDir);

  filesChecked = currentFiles.length;
  for (const r of checkResults) {
    if (r.status === 'new') filesAdded++;
    else if (r.status === 'modified') filesModified++;
    else if (r.status === 'deleted') filesRemoved++;
    // unchanged: skipped (filesSkipped tracked separately)
  }

  // Store old symbols for delta computation
  for (const fp of [...filesToReindex]) {
    if (this._preIndexCache.oldNodes) {
      // Capture old nodes before re-index
    }
    const tracked = trackedMap.get(fp);
    if (tracked) {
      const oldNodes = this.queries.getNodesByFile(fp);
      const oldEdges = this.queries.getEdgesByFile(fp);
      this._preIndexCache.oldData = this._preIndexCache.oldData || new Map();
      this._preIndexCache.oldData.set(fp, { oldNodes, oldEdges });
    }
  }

  filesToIndex.push(...filesToReindex);
  changedFilePaths.push(...filesToReindex);
} else {
  // === ORIGINAL CODE (backward compatible) ===
  for (const filePath of currentFiles) { ... }
}
// === PATCH END ===
```

### Point 3: After line 1441 — Fingerprint update + delta report
```typescript
// === PATCH START: Fingerprint post-update ===
if (this.options.fingerprint?.enabled && this._preIndexCache) {
  const fpo = this._fingerprintOrchestrator;
  const parseResults = new Map();
  // Collect parse results for files that were actually indexed
  for (const fp of filesToIndex) {
    const nodes = this.queries.getNodesByFile(fp);
    const edges = this.queries.getEdgesByFile(fp);
    const old = this._preIndexCache.oldData?.get(fp);
    parseResults.set(fp, {
      nodes, edges,
      oldNodes: old?.oldNodes,
      oldEdges: old?.oldEdges,
    });
  }
  const syncResult = fpo.sync(currentFiles, this.rootDir, parseResults);
  // Augment result with fingerprint metrics
  result.fingerprintEfficiency = syncResult.efficiency;
  result.filesSkipped = syncResult.filesSkipped.length;
  result.deltas = syncResult.deltas;
}
// === PATCH END ===
```

## Usage
```typescript
// Enable fingerprint in ExtractionOrchestrator options:
const orch = new ExtractionOrchestrator(rootDir, db, {
  fingerprint: { enabled: true }
});
const result = await orch.sync();
// result now includes:
//   result.filesSkipped    — files skipped via fingerprint
//   result.fingerprintEfficiency — fileSkipRate, symbolSkipRate, timeSaved
//   result.deltas          — per-file symbol deltas
```

## Backward Compatibility
When `fingerprint` option is not set or `{ enabled: false }`, the sync function behaves
exactly as before. No existing code needs to change.
