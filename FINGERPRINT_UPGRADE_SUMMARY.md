# CodeGraph Fingerprint Enhancement — Source Insight Parity

## Overview

Three-layer incremental indexing system matching Source Insight's pre-compiled
index check architecture, integrated into the CodeGraph code knowledge graph.

## Architecture

```
Layer 1: CRC32 File Fingerprinting
  ├── CRC32 hardware-accelerated hashing (~10x faster than SHA256)
  ├── SQLite file_fingerprints table with batch checkAll()
  └── Result: unchanged | modified | new | deleted classification

Layer 2: Include Graph Propagation
  ├── Regex-based #include extraction (<1ms per file)
  ├── SQLite include_graph with reverse-index for fan-out
  └── Header change → automatic re-index of all includers

Layer 3: Symbol Delta Computation
  ├── Triple-key identity: (name, kind, qualifiedName)
  ├── Content key change detection: (signature + position)
  └── Results: added | removed | modified | unchanged per symbol
```

## Performance (Kerogen C++ Project — 2,818 files, 15,053 include edges)

| Metric | Source Insight Target | CodeGraph+L3 Achieved |
|--------|----------------------|----------------------|
| File check | <1ms/file | 0.00ms/file ✓ |
| Fan-out | <1ms | 0.03ms/file ✓ |
| Skip rate (steady state) | ~90% | 100.0% ✓ |
| Include graph build | - | 94ms (15K edges) |
| Total pipeline (first run) | - | 5.5s |
| Total pipeline (steady state) | - | 6.3s (with I/O) |

## Top Fan-Out Headers (Kerogen)

| Header | Includers | Risk |
|--------|-----------|------|
| keglobal.h | 404 | Critical |
| kedata_global.h | 144 | High |
| kewell.h | 142 | High |
| dlgwarning.h | 135 | High |
| keobject.h | 121 | High |
| keproject.h | 119 | High |
| global.h | 116 | High |
| kewellcurve.h | 105 | High |

## Files

```
src/fingerprint/
├── fingerprint-store.ts   — CRC32 store + batch check + persisted DB
├── include-graph.ts        — #include extraction + fan-out + bulk transactions
├── symbol-delta.ts         — symbol/edge delta + efficiency metrics
├── index.ts                — orchestrator (sync entry point)
└── integration.ts          — extraction pipeline adapter

__tests__/
└── fingerprint-bench.test.ts — 9 unit tests (CRC32, include, delta, full pipeline)

scripts/
├── bench-kerogen.ts         — Kerogen project benchmark (round 1 + round 2)
└── bench-round2.ts          — steady-state verification

REFACTORED/
└── docs/fingerprint-sync-patch.md — integration guide for ExtractionOrchestrator
```

## Key Optimizations

1. **Transaction wrapping**: 15K INSERTs wrapped in single BEGIN/COMMIT → 359x speedup
2. **Bulk DELETE**: Single DELETE with IN clause vs per-file deletes → 30x speedup
3. **Map-based file existence**: Fingerprint map lookup vs fs.existsSync → 1080x speedup
4. **Schema fix**: WITHOUT ROWID → standard table for INSERT OR REPLACE compatibility

## Test Results

```
✓ Layer 1: CRC32 Fingerprinting > deterministic
✓ Layer 1: CRC32 Fingerprinting > detects change
✓ Layer 1: CRC32 Fingerprinting > classifies unchanged (Source Insight parity)
✓ Layer 1: CRC32 Fingerprinting > <0.5ms per file check (1000 files)
✓ Layer 2: Include Graph > extracts includes
✓ Layer 2: Include Graph > fan-out propagates header to includers
✓ Layer 3: Symbol Delta > detects added/removed/modified/unchanged
✓ Layer 3: Symbol Delta > edge delta correct
✓ Full Pipeline > end-to-end sync (0% → 100% skip rate)
+ 11 existing db-perf tests unchanged

20/20 ALL TESTS PASSED
```

## Integration

```typescript
// Drop-in activation in ExtractionOrchestrator:
const orch = new FingerprintOrchestrator(db.getDb(), {
  enableFingerprinting: true,
  enableIncludeGraph: true,
  enableSymbolDelta: true,
});
orch.initialize();
const result = orch.sync(filePaths, rootDir);
// result.efficiency.fileSkipRate → 100% on unchanged
```

## References

- Source Insight architecture analysis (CRC32 + fan-out + delta pattern)
- CodeGraph original: https://github.com/colbymchenry/codegraph
