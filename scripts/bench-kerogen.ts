import * as path from 'path';
import * as fs from 'fs';
import { DatabaseConnection } from '../src/db';
import { FingerprintOrchestrator } from '../src/fingerprint';

const ROOT = process.env.KEROGEN_ROOT || 'F:/openclaw-node-workspace/project1/kerogen/kerogen0.1';
const DB = path.join(ROOT, '.codegraph', 'fingerprint-bench.db');

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  Kerogen CodeGraph Fingerprint Benchmark');
  console.log('  Target: Source Insight parity');
  console.log('═══════════════════════════════════════════════\n');

  const round = process.argv.includes('--round2') ? 2 : 1;

  if (round === 1) {
    fs.mkdirSync(path.dirname(DB), { recursive: true });
    if (fs.existsSync(DB)) fs.unlinkSync(DB);
  }

  const db = round === 1
    ? DatabaseConnection.initialize(DB)
    : DatabaseConnection.open(DB);

  const orch = new FingerprintOrchestrator(db.getDb(), {
    enableFingerprinting: true, enableIncludeGraph: true, enableSymbolDelta: true,
  });
  orch.initialize();

  // Collect files
  const ext = new Set(['.cpp','.c','.h','.hpp','.cxx','.hxx']);
  const skip = new Set(['.git','.codegraph','.understand-anything','node_modules','REFACTORED','bld','build','bld2','build2','rapidjson']);
  const files: string[] = [];
  function walk(dir: string) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile() && ext.has(path.extname(e.name)))
        files.push(path.relative(ROOT, f).split('/').join('/'));
    }
  }
  walk(ROOT);
  console.log(`Found ${files.length} source files\n`);

  // Use unified sync() method (includes fingerprint persist)
  const t0 = performance.now();
  const r = orch.sync(files, ROOT);
  const ms = performance.now() - t0;

  console.log(`  Unchanged: ${r.check.unchanged}`);
  console.log(`  Modified:  ${r.check.modified}`);
  console.log(`  New:       ${r.check.new}`);
  console.log(`  Deleted:   ${r.check.deleted}`);
  console.log(`  Reindex:   ${r.filesToReindex.length} files`);
  console.log(`  Skipped:   ${r.filesSkipped.length} files`);
  console.log(`  Skip rate: ${r.efficiency.fileSkipRate.toFixed(1)}%`);
  console.log(`  Duration:  ${ms.toFixed(0)}ms (${(ms/files.length).toFixed(2)}ms/file)\n`);

  if (round === 2) {
    console.log('═══════════════════════════════════════════════');
    console.log('  Include Graph Summary');
    console.log('═══════════════════════════════════════════════');
    const ig = orch.includeGraphStore.getStats();
    console.log(`  Total edges:   ${ig.totalEdges}`);
    console.log(`  Unique headers: ${ig.totalIncluded}`);
    console.log('  Top-5 fan-out:');
    for (const h of ig.topHeaders.slice(0, 5))
      console.log(`    ${h.includerCount.toString().padStart(4)} -> ${h.header}`);
  }

  console.log('\n═══════════════════════════════════════════════');
  console.log(`  ${round === 1 ? 'First run complete' : 'Steady-state: ' + r.efficiency.fileSkipRate.toFixed(0) + '% skip rate, ' + ms.toFixed(0) + 'ms'}`);
  console.log('═══════════════════════════════════════════════');

  db.close();
}

main().catch(console.error);
