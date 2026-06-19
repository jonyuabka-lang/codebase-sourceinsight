import * as path from 'path';
import * as fs from 'fs';
import { DatabaseConnection } from '../src/db';
import { FingerprintOrchestrator } from '../src/fingerprint';

const ROOT = 'F:/openclaw-node-workspace/project1/kerogen/kerogen0.1';
const DB = path.join(ROOT, '.codegraph', 'fingerprint-bench.db');

const orch = new FingerprintOrchestrator(DatabaseConnection.initialize(DB).getDb());
orch.initialize();

const files: string[] = [];
function walk(dir: string) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git','.codegraph','node_modules','REFACTORED','bld','build','bld2','build2','rapidjson'].includes(e.name)) continue;
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f);
    else if (e.isFile() && ['.cpp','.c','.h','.hpp','.cxx','.hxx'].includes(path.extname(e.name)))
      files.push(path.relative(ROOT, f).replace(/\\/g, ./.));
  }
}
walk(ROOT);

// Round 2: no files changed
const t0 = performance.now();
const r = orch.sync(files, ROOT);
const ms = performance.now() - t0;

console.log(`\nRound 2 (zero changes):`);
console.log(`  Unchanged: ${r.check.unchanged}`);
console.log(`  Modified:  ${r.check.modified}`);
console.log(`  New:       ${r.check.new}`);
console.log(`  Skip rate: ${r.efficiency.fileSkipRate.toFixed(1)}%`);
console.log(`  Reindex:   ${r.filesToReindex.length} files`);
console.log(`  Duration:  ${ms.toFixed(0)}ms`);
console.log(`  Per-file:  ${(ms/files.length).toFixed(3)}ms/file`);
