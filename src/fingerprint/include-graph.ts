/**
 * Include Graph — Header Dependency Propagation
 *
 * Implements Source Insight's dependency fan-out pattern:
 * When a .h file changes, find all files that #include it and mark them dirty.
 *
 * The include graph is a directed graph: includer → included.
 * When a header changes, we follow reverse edges to find all includers.
 *
 * Performance target:
 * - Include extraction: <1ms per file (regex-based, not AST)
 * - Fan-out query: <0.1ms for typical includes (SQLite index lookup)
 */

import { SqliteDatabase } from '../db/sqlite-adapter';
import { normalizePath } from '../utils';

// ── Types ──────────────────────────────────────────────────────────────────

export interface IncludeEdge {
  includer: string;  // file that has #include "..."
  included: string;  // file being included
  line: number;       // line number of the #include directive
  is_system: boolean; // true for <...> includes, false for "..." includes
}

// ── SQL Schema ────────────────────────────────────────────────────────────

export const INCLUDE_GRAPH_SCHEMA = `
CREATE TABLE IF NOT EXISTS include_graph (
  includer_file  TEXT NOT NULL,
  included_file  TEXT NOT NULL,
  line           INTEGER NOT NULL,
  is_system      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (includer_file, included_file)
);

-- Reverse lookup: find all includers when a header changes
CREATE INDEX IF NOT EXISTS idx_include_reverse
  ON include_graph(included_file);

-- Forward lookup: find all includes of a file
CREATE INDEX IF NOT EXISTS idx_include_forward
  ON include_graph(includer_file);

-- System includes index (for filtering)
CREATE INDEX IF NOT EXISTS idx_include_system
  ON include_graph(is_system)
  WHERE is_system = 0;
`;

// ── Include Extractor ─────────────────────────────────────────────────────

// Matches #include directives in C/C++ files
// Handles:
//   #include "foo.h"
//   #include <bar.h>
//   #include "path/to/foo.h"
//   #  include "foo.h"  (space after #)
const INCLUDE_REGEX = /^\s*#\s*include\s+([<"])([^>"]+)[>"]/gm;

/**
 * Extract #include directives from source text.
 * Uses regex for speed — not a full preprocessor.
 */
export function extractIncludes(
  source: string,
  filePath: string
): IncludeEdge[] {
  const edges: IncludeEdge[] = [];
  const lines = source.split('\n');

  // Reset regex state
  INCLUDE_REGEX.lastIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    INCLUDE_REGEX.lastIndex = 0;
    const match = INCLUDE_REGEX.exec(line);
    if (match) {
      edges.push({
        includer: filePath,
        included: match[2],
        line: i + 1,
        is_system: match[1] === '<',
      });
    }
  }

  return edges;
}

// ── Include Graph Store ───────────────────────────────────────────────────

export class IncludeGraphStore {
  private db: SqliteDatabase;

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  initialize(): void {
    this.db.exec(INCLUDE_GRAPH_SCHEMA);
  }

  // ── Write operations ────────────────────────────────────────────────

  /**
   * Replace all include edges for a file (called on re-index).
   */
  replaceIncludes(filePath: string, edges: IncludeEdge[]): void {
    this.db.prepare('DELETE FROM include_graph WHERE includer_file = ?').run(filePath);

    if (edges.length === 0) return;

    const insert = this.db.prepare(
      'INSERT OR REPLACE INTO include_graph (includer_file, included_file, line, is_system) VALUES (?, ?, ?, ?)'
    );
    for (const edge of edges) {
      insert.run(edge.includer, edge.included, edge.line, edge.is_system ? 1 : 0);
    }
  }

  /**
   * Batch replace: update include edges for many files in a single transaction.
   * Critical for first-run performance when all files are new.
   * Without explicit transaction, each INSERT is auto-committed (~1ms each).
   * With transaction, 15000 INSERTs complete in ~200ms total.
   */
  batchReplaceIncludes(allEdges: Map<string, IncludeEdge[]>): void {
    const files = [...allEdges.keys()];
    if (files.length === 0) return;

    this.db.exec('BEGIN');

    // Single DELETE for all files being replaced
    const delPlaceholders = files.map(() => '?').join(',');
    this.db.prepare(`DELETE FROM include_graph WHERE includer_file IN (${delPlaceholders})`).run(...files);

    // Bulk INSERT inside transaction
    const insert = this.db.prepare(
      'INSERT OR REPLACE INTO include_graph (includer_file, included_file, line, is_system) VALUES (?, ?, ?, ?)'
    );
    for (const [, edges] of allEdges) {
      for (const edge of edges) {
        insert.run(edge.includer, edge.included, edge.line, edge.is_system ? 1 : 0);
      }
    }

    this.db.exec('COMMIT');
  }

  /**
   * Remove all include edges for a file (called on file deletion).
   */
  removeIncludes(filePath: string): void {
    const del = this.db.prepare('DELETE FROM include_graph WHERE includer_file = ?');
    del.run(filePath);
  }

  // ── Read operations ──────────────────────────────────────────────────

  /**
   * Get all files that include a given header (reverse lookup).
   * This is the key operation for dependency propagation.
   *
   * @param headerPath - The header file that changed
   * @param projectOnly - If true, only returns project files (not system headers)
   * @returns List of file paths that include this header
   */
  getIncluders(headerPath: string): string[] {
    const stmt = this.db.prepare(
      'SELECT DISTINCT includer_file FROM include_graph WHERE included_file = ? AND is_system = 0'
    );
    const rows = stmt.all(headerPath) as { includer_file: string }[];
    return rows.map(r => r.includer_file);
  }

  /**
   * Fan-out: given a changed file, return all files that need re-indexing
   * due to transitive include dependencies.
   *
   * @param changedFile - The file that changed
   * @returns Set of all files affected (including the changed file itself)
   */
  getAffectedFiles(changedFile: string): Set<string> {
    const affected = new Set<string>();
    affected.add(changedFile);

    // If it's a header, find all includers
    if (changedFile.endsWith('.h') || changedFile.endsWith('.hpp') || changedFile.endsWith('.hxx')) {
      const includers = this.getIncluders(changedFile);
      for (const inc of includers) {
        affected.add(inc);
      }
    }

    return affected;
  }

  /**
   * Batch fan-out: given multiple changed files, return the full affected set.
   * Deduplicates across multiple header changes.
   *
   * Uses a single SQL query for all headers (O(N) → O(1) RTT) instead of
   * one query per file, which matters on first-run when N can be thousands.
   */
  getAffectedFilesBatch(changedFiles: string[]): Set<string> {
    const affected = new Set<string>();

    // Separate headers from non-headers
    const headers: string[] = [];
    for (const file of changedFiles) {
      affected.add(file);
      if (file.endsWith('.h') || file.endsWith('.hpp') || file.endsWith('.hxx')) {
        headers.push(file);
      }
    }

    // Single bulk query for all headers instead of one-per-header
    if (headers.length > 0) {
      const placeholders = headers.map(() => '?').join(',');
      const stmt = this.db.prepare(
        `SELECT DISTINCT includer_file, included_file
         FROM include_graph
         WHERE included_file IN (${placeholders})
           AND is_system = 0`
      );
      const rows = stmt.all(...headers) as { includer_file: string; included_file: string }[];
      for (const row of rows) {
        affected.add(row.includer_file);
      }
    }

    return affected;
  }

  // ── Statistics ──────────────────────────────────────────────────────

  getStats(): {
    totalEdges: number;
    totalIncluders: number;
    totalIncluded: number;
    topHeaders: { header: string; includerCount: number }[];
  } {
    const edges = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM include_graph'
    ).get() as { cnt: number };

    const includers = this.db.prepare(
      'SELECT COUNT(DISTINCT includer_file) as cnt FROM include_graph'
    ).get() as { cnt: number };

    const included = this.db.prepare(
      'SELECT COUNT(DISTINCT included_file) as cnt FROM include_graph WHERE is_system = 0'
    ).get() as { cnt: number };

    // Top-20 most-included headers (highest fan-out risk)
    const topHeaders = this.db.prepare(`
      SELECT included_file as header, COUNT(*) as includerCount
      FROM include_graph
      WHERE is_system = 0
      GROUP BY included_file
      ORDER BY includerCount DESC
      LIMIT 20
    `).all() as { header: string; includerCount: number }[];

    return {
      totalEdges: edges.cnt,
      totalIncluders: includers.cnt,
      totalIncluded: included.cnt,
      topHeaders,
    };
  }
}
