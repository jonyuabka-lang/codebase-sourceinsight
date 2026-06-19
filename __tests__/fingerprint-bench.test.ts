import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DatabaseConnection } from '../src/db';
import { FingerprintStore, crc32 } from '../src/fingerprint/fingerprint-store';
import { IncludeGraphStore, extractIncludes } from '../src/fingerprint/include-graph';
import { computeSymbolDelta, computeEdgeDelta } from '../src/fingerprint/symbol-delta';
import { FingerprintOrchestrator } from '../src/fingerprint';
import type { Node, Edge } from '../src/types';

function makeNode(o: Partial<Node> = {}): Node {
  return { id: 'x', kind: 'function', name: 'f', qualifiedName: 'f',
    filePath: 'a.cpp', language: 'cpp', startLine: 1, endLine: 1,
    startColumn: 0, endColumn: 0, ...o };
}

// ── L1: CRC32 ─────────────────────────────────────────────────────
describe('Layer 1: CRC32 Fingerprinting', () => {
  it('deterministic', () => expect(crc32('hello')).toBe(crc32('hello')));
  it('detects change', () => expect(crc32('hello')).not.toBe(crc32('Hello')));
  it('classifies unchanged (Source Insight parity)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-'));
    const db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    const s = new FingerprintStore(db.getDb()); s.initialize();
    const fp = { crc32: crc32('int x=1;'), mtime_ms: 1, size_bytes: 9 };
    let r = s.checkAll(new Map([['a.cpp', fp]]));
    expect(r[0].status).toBe('new');
    s.upsertFingerprint({ file_path: 'a.cpp', ...fp, symbol_count: 1, updated_at: 1 });
    r = s.checkAll(new Map([['a.cpp', fp]]));
    expect(r[0].status).toBe('unchanged');
    db.close(); fs.rmSync(dir, { recursive: true, force: true });
  });
  it('<0.5ms per file check (1000 files)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-'));
    const db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    const s = new FingerprintStore(db.getDb()); s.initialize();
    const files = new Map<string, {crc32:number;mtime_ms:number;size_bytes:number}>();
    for (let i=0;i<1000;i++) files.set(`f${i}.cpp`, {crc32:i,mtime_ms:1,size_bytes:10});
    const t0 = performance.now();
    s.checkAll(files);
    expect(performance.now()-t0).toBeLessThan(500);
    db.close(); fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ── L2: Include Graph ──────────────────────────────────────────────
describe('Layer 2: Include Graph', () => {
  it('extracts includes', () => {
    const e = extractIncludes('#include "a.h"\n#include <b.h>\n', 't.cpp');
    expect(e).toHaveLength(2);
    expect(e[0].included).toBe('a.h');
    expect(e[1].is_system).toBe(true);
  });
  it('fan-out propagates header to includers', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-'));
    const db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    const s = new IncludeGraphStore(db.getDb()); s.initialize();
    s.replaceIncludes('a.cpp', [{includer:'a.cpp',included:'h.h',line:1,is_system:false}]);
    s.replaceIncludes('b.cpp', [{includer:'b.cpp',included:'h.h',line:1,is_system:false}]);
    const aff = s.getAffectedFiles('h.h');
    expect(aff.has('a.cpp')).toBe(true);
    expect(aff.has('b.cpp')).toBe(true);
    db.close(); fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ── L3: Symbol Delta ───────────────────────────────────────────────
describe('Layer 3: Symbol Delta', () => {
  it('detects added/removed/modified/unchanged', () => {
    const oldN = [makeNode({name:'keep'}), makeNode({name:'rm'}), makeNode({name:'mod',signature:'old'})];
    const newN = [makeNode({name:'keep'}), makeNode({name:'add'}), makeNode({name:'mod',signature:'new'})];
    const d = computeSymbolDelta(oldN, newN);
    expect(d.unchanged).toBe(1);
    expect(d.added).toHaveLength(1);
    expect(d.removed).toHaveLength(1);
    expect(d.modified).toHaveLength(1);
  });
  it('edge delta correct', () => {
    const d = computeEdgeDelta(
      [{source:'a',target:'b',kind:'calls'},{source:'b',target:'c',kind:'calls'}],
      [{source:'a',target:'b',kind:'calls'},{source:'c',target:'d',kind:'calls'}]
    );
    expect(d.unchanged).toBe(1);
    expect(d.added).toHaveLength(1);
    expect(d.removed).toHaveLength(1);
  });
});

// ── Full Pipeline ──────────────────────────────────────────────────
describe('Full Pipeline (Source Insight parity)', () => {
  it('end-to-end sync', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-'));
    const db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    const orch = new FingerprintOrchestrator(db.getDb()); orch.initialize();
    // Create files
    fs.writeFileSync(path.join(dir,'h.h'), '#pragma once\nint f();\n');
    fs.writeFileSync(path.join(dir,'a.cpp'), '#include "h.h"\nint main(){}');
    const files = ['h.h','a.cpp'];
    const r = orch.sync(files, dir);
    expect(r.check.totalFiles).toBe(2);
    expect(r.efficiency.fileSkipRate).toBe(0); // first run, all new
    // Second sync: no changes
    const r2 = orch.sync(files, dir);
    expect(r2.check.unchanged).toBe(2);
    expect(r2.efficiency.fileSkipRate).toBe(100);
    expect(r2.filesToReindex).toHaveLength(0);
    db.close(); fs.rmSync(dir, { recursive: true, force: true });
  });
});
