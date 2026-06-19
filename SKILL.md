---
name: codegraph
description: Pre-indexed code knowledge graph for Claude Code. Reduces token costs by ~25% and tool calls by ~62%. Use /codegraph to index, query, and trace code structure.
---

# CodeGraph - Code Knowledge Graph

CodeGraph provides a pre-indexed knowledge graph as an MCP server, letting agents query code structure instantly instead of scanning files.

## Commands

- `/codegraph init -i` — Initialize CodeGraph in current project
- `/codegraph index` — Index the codebase
- `/codegraph sync` — Sync with recent file changes
- `/codegraph status` — Show index status
- `/codegraph query <query>` — Query the knowledge graph

## MCP Tools (available automatically when installed)

- `codegraph_search` — Search symbols by name
- `codegraph_node` — Get details about a specific symbol
- `codegraph_callers` — Find all callers of a function/method
- `codegraph_callees` — Find all callees from a function/method
- `codegraph_trace` — Trace a call path between two symbols
- `codegraph_explore` — Explore the codebase structure
- `codegraph_context` — Get code context for a description
- `codegraph_affected` — Find affected code after changes

## Quick Start

```
cd your-project
codegraph init -i
codegraph index
```

Then ask structural questions — CodeGraph answers with instant graph queries instead of file reads.

## Source

https://github.com/colbymchenry/codegraph
