---
name: atlas-owner
description: Product Owner graph memory for any project. Turns project knowledge (requirements, features, decisions, bugs, tasks, roadmap context) into a JSON-backed graph so the AI behaves like a PO who remembers everything. Use when the project has an `atlas/` folder or when the user says "atlas", "insinyur-atlas", "atlas-owner", "graph memory", "PO knowledge", "remember this for later", or asks the AI to recall past decisions, bugs, or feature context across sessions.
---

# Atlas Owner — Product Owner Graph Memory

Atlas is a persistent graph memory built for Product Owner behavior. Every fact about a project (requirement, feature, decision, bug, task, gotcha) is one node. Nodes connect via typed edges. The graph lives in a plain `atlas/` folder, so it works in any project, any language, any AI that reads Markdown and JSON.

**Scales to 10k+ nodes** because it is modular: nodes live in auto-split shards, and the AI never reads raw index files — it always talks through the CLI, so context cost stays proportional to what you retrieve, not to the whole graph.

## Structure

```
atlas/
├── manifest.json         # meta: schema_version, active_shard, node_count, seed_id, next_seq, pruned_count, last_prune_at, path_features
├── index.{n}.json        # node shards, auto-split at 300 nodes each
├── id_map.json           # id -> shard (O(1) get, dup/conn checks)
├── tags_index.json       # tag -> [{id, shard}]
├── words_index.json      # word -> [{id, shard}] (query candidate hint)
├── symbol_index.json     # symbol -> [{id, shard}] (scan --symbols)
├── features/<fitur>/*.md # per-feature node groupings (M6a)
├── nodes/{ID}.md         # optional per-node detail (max 200 lines)
├── PROTOCOL.md           # retrieval rules (injected into context by plugin)
└── rules.md              # node/edge format rules
```

## CLI (THE ONLY way to touch the graph)

```bash
# <atlas> = path to atlas.mjs. Resolve ONCE, don't guess:
#   1. command -v atlas            # npm global bin, if installed
#   2. this skill's scripts/atlas.mjs   # skill copy (no skill/ subfolder)
#   3. <repo>/skill/scripts/atlas.mjs   # repo checkout
ATLAS=$(command -v atlas || echo "$HOME/.config/opencode/skills/atlas-owner/scripts/atlas.mjs")
node "$ATLAS" init [dir]                                   # scaffold
node "$ATLAS" record --id TASK-003 --type task --status done \
    --tags seo,router --summary "max 140 chars" \
    --conn "BUG-001:fixes,DEC-002:led_to" [--file nodes/TASK-003.md] [--loc file:line] [--commit hash] [dir]
node "$ATLAS" query "keywords" [--tags a,b] [--limit 5] [--compact] [--all] [--since N] [--feature F] [--features] [dir]
node "$ATLAS" recent [--limit 10] [dir]                    # newest nodes
node "$ATLAS" get ID [dir]
node "$ATLAS" context <filepath> [dir]                     # infer feature from file, list nodes
node "$ATLAS" feature <nama> --paths a,b,c [dir]           # map path-prefix -> feature
node "$ATLAS" update ID --status archived [dir]            # change status/summary/tags
node "$ATLAS" update|delete --filter "type=task&status=done&tags=auto" [--dry-run] [dir]  # bulk by filter
node "$ATLAS" prune [--days N] [--dry-run] [--force] [dir] # archive old/done/auto noise
node "$ATLAS" migrate [dir]                                # schema auto-migrate + backup
node "$ATLAS" edit ID [dir]                                # open detail file in $EDITOR
node "$ATLAS" cluster [dir]                                # group active nodes by topic
node "$ATLAS" export --stats [dir]                         # dump graph / counts by type
node "$ATLAS" verify [dir]                                 # check + dangling-conn integrity
node "$ATLAS" stat [dir]                                   # one-line counts
node "$ATLAS" scan [dir] [--symbols]                       # code-walk map (idempotent)
node "$ATLAS" rebuild [dir]                                # fix id_map/tags/words drift
node "$ATLAS" doctor                                       # version drift check
node "$ATLAS" check [dir]                                  # integrity + limits
```

`--id` optional: auto-generated as `{PREFIX}-{NNN}` from `--type`. The first ever node (graph seed) is allowed to have no `--conn`; every later node needs ≥ 1 edge. IDs must match `{PREFIX}-{NNN}` (blocks path traversal).

## Token discipline (IMPORTANT)

**Never read `atlas/*.json` raw.** Always:

1. `atlas query "<topic>"` → compact matches (id, type, tags, summary, +md flag).
2. `atlas get ID` → full node + detail file.
3. Walk `conn` edges via `atlas get` only if needed.

The CLI reads the files internally and returns only what you asked for. On a 10k-node graph this keeps your context at the size of the answer, not the size of the memory.

## Enforced limits

| Limit | Value | Enforced by |
|---|---|---|
| summary | ≤ 140 chars | `record` + `check` |
| node detail file | ≤ 200 lines | `record --file` + `check` |
| nodes per shard | ≤ 300 | auto-split on `record`, checked |
| conn | ≥ 1 edge (except seed) | `record` + `check` |
| conn | no self-loop / duplicate | `record` + `check` |
| id | `{PREFIX}-{NNN}` format | `record` + `get` + `check` |
| id_map / tags_index / node_count | no drift | `check` (fix: `rebuild`) |
| duplicate id / broken edge / stale tags | — | `check` |

Corrupt shard: `query`/`get`/`recent`/`stat` skip it with a WARN; `check` reports it. Writes are serialized by a lock file, so concurrent AIs can't lose each other's records.

Tuning: `ATLAS_MAX_SHARD=500` overrides the shard size.

## Node types

| Type | Prefix | When |
|---|---|---|
| requirement | `REQ-` | A product requirement / user story |
| feature | `FEAT-` | A feature or capability |
| task | `TASK-` | Significant work completed |
| bug | `BUG-` | Bug found or fixed |
| decision | `DEC-` | Important architecture/product decision |
| business | `BUS-` | Current business state; archive old + `led_to` new = business timeline |
| positive | `POS-` | What worked / good pattern |
| negative | `NEG-` | What failed / wrong step |
| edge | `EDGE-` | Edge case discovered |
| pitfall | `PF-` | Recurring trap |

## Status

`active` (still relevant) · `done` / `fixed` (completed) · `open` (bug not fixed) · `archived` (no longer relevant; skip in startup scan)

## Connection types

`fixes` · `caused` · `led_to` · `relates` · `blocks` · `depends` · `contradicts` · `example_of` · `implements` · `satisfies`

## Classification — choose one type

- `business`: market/pricing/value-proposition state
- `decision`: a choice made (with reason)
- `positive`/`negative`: what worked / what failed
- `edge`: boundary case worth remembering
- `pitfall`: a trap to avoid (not just a failure)
- `requirement`/`feature`/`task`/`bug`: standard dev backlog

## Node shape (inside shards)

```json
{
  "id": "BUG-001",
  "type": "bug",
  "status": "fixed",
  "date": "2026-08-09",
  "tags": ["seo", "router"],
  "summary": "One sentence: essence and why it matters.",
  "conn": [{ "id": "TASK-002", "type": "fixes" }]
}
```

## Protocol

### Before work
1. Does `atlas/` exist? No → `atlas init` (or plugin scaffolds it automatically).
2. Project has `AGENTS.md`/`CLAUDE.md`? Run `atlas ingest` once — it turns rules/bans/env into knowledge nodes (`NEG`/`DEC`) and reads `docs/**/*.md` + root `*.md` so existing docs are searchable without re-reading.
3. New/large project, no map yet? `atlas scan` to map repo structure (code-walk, not guesswork). Markdown docs get their heading into the node summary. Then `atlas query` the relevant paths.
4. `atlas query "<topic from the task>"` → read relevant nodes.
5. Any flow or insight unclear (business OR technical)? Ask the user before recording a node. Never guess a fact.
6. Follow `conn` only if needed.

### After significant work
Record a node in the SAME change that did the work (min 1 node per significant work):
1. `atlas record --type <type> --status <status> --tags a,b --summary "≤140 chars" --conn "ID:type,..."`.
2. Add `--file nodes/{ID}.md` when detail exceeds the summary (≤ 200 lines). A summary longer than 140 chars is auto-truncated and the full text stored in `nodes/{ID}.md` — nothing is lost.
3. Decision/architecture → `decision`. Bug found → `bug`. Business changed → archive old `BUS-` + record new with `--conn "old:led_to"`.
4. CLI keeps shards, tags_index, and auto-ID in sync. `atlas check` verifies.

### PO behavior
- Before proposing a feature or change: `atlas query` the topic. Do not re-propose what a `NEG-` or `DEC-` node already settled.
- When status changes (e.g. requirement shipped): record a `TASK-` node with `--conn "REQ-001:implements"`, keep the chain readable.

### Business tracking (PO knows the product's business too)
- Record current business state as a `BUS-` node (`--tags biz,model`, status `active`): pricing, margin, segments, KPIs, partnerships.
- When the business changes: `atlas update BUS-xxx --status archived`, then record the new state with `--conn "BUS-xxx:led_to"`. The `led_to` chain is the business timeline — `atlas query "biz" --tags biz` or `atlas recent` shows when and why it changed.
- Keep the detail file (`--file nodes/BUS-xxx.md`, ≤ 200 lines) for numbers that exceed the summary; link to source documents (e.g. Obsidian) inside it.

## Install

```bash
# scaffold the graph in any project
ATLAS=$(command -v atlas || echo "$HOME/.config/opencode/skills/atlas-owner/scripts/atlas.mjs")
node "$ATLAS" init /path/to/project
# verify integrity + limits
node "$ATLAS" check /path/to/project
```

If the atlas-owner **plugin** is installed, `atlas/` scaffolds automatically on project load and `atlas/PROTOCOL.md` is injected into project instructions — no manual init needed.

If the project has an existing legacy `memory/` graph, the plugin leaves it untouched — and skips PROTOCOL injection even if `atlas/` is also present.

## MCP (fast in-process tools)

The MCP server exposes the same commands as in-process tools — `atlas_query`, `atlas_get`, `atlas_recent`, `atlas_stat`, `atlas_scan`, `atlas_record`, `atlas_update`, `atlas_check`. One persistent node process, no per-call spawn: **~1ms/call vs ~50ms** for the CLI. Install with one command:

```bash
atlas setup   # registers MCP server + plugin in ~/.config/opencode/opencode.json
```

Or add manually to `opencode.json`:

```json
{
  "mcp": {
    "atlas": {
      "type": "local",
      "command": ["node", "<atlas-owner>/plugin/mcp-server.js"],
      "enabled": true
    }
  }
}
```

Works alongside the plugin: plugin scaffolds + injects PROTOCOL, MCP is what the agent calls during work. Both read/write the same `atlas/` graph.

## Sharing / distribution

The whole repo (`skill/` + `plugin/`) is portable and zero-dependency. Copy to another machine, or publish as a git repo / npm package. `node` ships with the runtime.

