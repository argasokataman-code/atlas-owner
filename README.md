# Atlas Owner — Product Owner Graph Memory

Persistent graph memory for any project, any AI. The AI remembers requirements, features, decisions, bugs, tasks, and gotchas like a real Product Owner — across sessions. Modular + auto-sharding + CLI-first = **scales to 10k+ nodes without eating your token budget**.

## Why it doesn't blow up tokens

- Nodes live in **auto-split shards** (`index.{n}.json`, 300 nodes each). No giant single file, no re-parse of everything per query.
- The AI **never reads raw JSON**. It talks through the CLI (`query`/`get`), which reads files internally and returns only the matches. Context cost = size of the answer, not size of the memory.
- **Enforced limits**: summary ≤ 140 chars, detail files ≤ 200 lines, shard ≤ 300 nodes, no orphan nodes, tags kept in sync. `atlas check` verifies.
- **Structured query** by tags + keywords returns short one-line nodes (~30–90 tokens), not the whole graph.

## Performance

Measured on a graph of 300+ nodes, Apple Silicon, node v24:

| Operation | CLI (node spawn) | MCP in-process | Speedup |
|---|---|---|---|
| `query` | ~54 ms/call | **~1.0 ms** | ~54× |
| `get` | ~51 ms/call | **~0.8 ms** | ~64× |
| `record` | ~55 ms/call | **~2.0 ms** | ~28× |
| `scan` (100 paths) | ~70 ms | **~3 ms** | ~20× |

Per-call output: `query` ~89 tokens, `get` ~42 tokens, `recent` ~100 tokens, `stat` ~31 tokens (at 5000 nodes / 17 shards).

Why MCP is fast: the CLI spawns a fresh node process per call (~50 ms startup dominates). The MCP server keeps **one** persistent node process and runs every command in-process. This is the difference between calling a REST API and calling a local function.

## The three interfaces

| Interface | Use when | Latency |
|---|---|---|
| **CLI** (`atlas.mjs`) | scripts, cron, one-off shell | ~50 ms/call |
| **Plugin** (`plugin/index.js`) | auto-scaffold `atlas/` + inject PROTOCOL on project load | — |
| **MCP** (`plugin/mcp-server.js`) | agent tools inside opencode | ~1 ms/call |

The plugin is passive (setup + instructions). The CLI and MCP are active (read/write the graph). Plugin + MCP run together: plugin scaffolds and injects PROTOCOL, MCP is what the agent calls during work. Both read/write the same `atlas/` folder.

## What you get

```
atlas-owner/
├── skill/SKILL.md            # opencode skill (PO behavior + protocol)
├── skill/scripts/atlas.mjs   # CLI: init / record / query / get / update / scan / ...
├── plugin/index.js           # opencode enforce plugin (auto-init + protocol injection)
└── plugin/mcp-server.js      # MCP server: same commands as in-process tools
```

Installed into a project it creates:

```
your-project/
└── atlas/
    ├── manifest.json         # active_shard, node_count, seed_id
    ├── index.{n}.json        # node shards (auto-split)
    ├── id_map.json           # id -> shard (O(1) get, dup/conn checks)
    ├── tags_index.json       # tag -> [{id, shard}]
    ├── nodes/{ID}.md         # optional per-node detail
    ├── PROTOCOL.md           # always-in-context protocol
    └── rules.md
```

## Install

### 0. npm (recommended)

```bash
npm install -g atlas-owner
```

Installs the CLI to PATH. One command wires up opencode (MCP server + enforce plugin) globally:

```bash
atlas setup
# restart opencode — atlas_query/atlas_get/... appear as MCP tools
```

Or wire it manually — the plugin and MCP server live inside the package, point opencode at the installed paths instead of a repo clone:

```bash
npm root -g   # e.g. /opt/homebrew/lib/node_modules
```

```json
{
  "plugin": ["/opt/homebrew/lib/node_modules/atlas-owner/plugin/index.js"],
  "mcp": {
    "atlas": {
      "type": "local",
      "command": ["node", "/opt/homebrew/lib/node_modules/atlas-owner/plugin/mcp-server.js"],
      "enabled": true
    }
  }
}
```

### 1. Skill (instructions)

```bash
mkdir -p ~/.config/opencode/skills
ln -s "$PWD/skill" ~/.config/opencode/skills/atlas-owner
# or copy: cp -R skill ~/.config/opencode/skills/atlas-owner
```

### 2. Plugin (enforce + auto-scaffold)

Add to `~/.config/opencode/opencode.json` (or project `opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["/abs/path/to/atlas-owner/plugin/index.js"]
}
```

On project load the plugin:

- scaffolds `atlas/` automatically if neither `atlas/` nor legacy `memory/` exists,
- injects `atlas/PROTOCOL.md` into project instructions so the protocol is always in context (**skipped when a legacy `memory/` exists, even if `atlas/` is also present**),
- repairs a lost `PROTOCOL.md` when `atlas/` exists,
- never touches legacy `memory/` folders,
- never scaffolds into `$HOME`.

### 3. MCP (fast in-process tools)

Same commands as the CLI but exposed as MCP tools (`atlas_query`, `atlas_get`, `atlas_record`, `atlas_scan`, …). Add to `opencode.json` (or just run `atlas setup`):

```json
{
  "mcp": {
    "atlas": {
      "type": "local",
      "command": ["node", "/abs/path/to/atlas-owner/plugin/mcp-server.js"],
      "enabled": true
    }
  }
}
```

MCP tools: `atlas_query`, `atlas_get`, `atlas_recent`, `atlas_stat`, `atlas_scan`, `atlas_record`, `atlas_update`, `atlas_check`.

### 4. CLI (any project)

```bash
alias atlas='node /abs/path/to/atlas-owner/skill/scripts/atlas.mjs'
atlas init /path/to/project
atlas record --id BUG-001 --type bug --status fixed --tags seo,router --summary "hreflang duplikat" --conn "DEC-003:fixes" /path/to/project
atlas query "hreflang" --limit 5 /path/to/project
atlas recent /path/to/project
atlas stat /path/to/project
atlas get BUG-001 /path/to/project
atlas update BUG-001 --status archived /path/to/project
atlas scan /path/to/project            # map repo structure (code-walk, idempotent)
atlas scan /path/to/project --target src --depth 3   # deeper map of one subtree
atlas rebuild /path/to/project
atlas check /path/to/project
```

## Commands

| Command | What it does |
|---|---|
| `init` | scaffold `atlas/` (manifest, shards, indexes, PROTOCOL) |
| `ingest` | read AGENTS.md/CLAUDE.md → knowledge nodes (rules→`NEG`, env→`DEC`) |
| `record` | add a node (`--id` optional, auto `{PREFIX}-{NNN}`) |
| `query` | search by keywords + `--tags` + `--limit` (default 5, max 20) |
| `get ID` | show one node (plus `nodes/{ID}.md` if present) |
| `update ID` | change `--status` / `--summary` / `--tags` |
| `delete ID` | remove a node (`--force` strips incoming edges too) |
| `recent` | newest nodes by timestamp (`--limit`, default 10) |
| `stat` | one-line counts by type/status |
| `scan` | code-walk the repo → feature/task nodes (`--target`, `--depth`; idempotent) |
| `export` | dump full graph as JSON (backup / portability) |
| `rebuild` | rebuild `id_map.json` + `tags_index.json` (fix drift) |
| `check` | integrity + limits gate |

`--id` is optional — auto-generated as `{PREFIX}-{NNN}` from `--type`. First node (graph seed) may omit `--conn`; later nodes need ≥ 1 edge. IDs must match `{PREFIX}-{NNN}` (doubles as a path-traversal guard).

Tuning shard size: `ATLAS_MAX_SHARD=500 atlas record ...`

## Node types & classification

requirement · feature · task · bug · decision · business · positive · negative · edge · pitfall

| Type | Prefix | Use for |
|---|---|---|
| requirement | `REQ-` | product requirement / user story |
| feature | `FEAT-` | feature or capability |
| task | `TASK-` | significant work completed |
| bug | `BUG-` | bug found or fixed |
| decision | `DEC-` | architecture/product choice (with reason) |
| business | `BUS-` | market/pricing/value-proposition state |
| positive | `POS-` | what worked |
| negative | `NEG-` | what failed |
| edge | `EDGE-` | boundary case worth remembering |
| pitfall | `PF-` | trap to avoid (not just a failure) |

The AI picks the type against these criteria — and asks the user instead of guessing when a flow/insight is unclear.

`business` (`BUS-`) tracks the product's business state. When the business changes: `atlas update BUS-xxx --status archived` then record the new state with `--conn "BUS-xxx:led_to"` — the `led_to` chain is a queryable business timeline (when it changed, from what to what, why).

## Edge (conn) types

fixes · caused · led_to · relates · blocks · depends · contradicts · example_of · implements · satisfies

## Status

`active` (still relevant) · `done` / `fixed` (completed) · `open` (bug not fixed) · `archived` (no longer relevant)

## Agent workflow

```
1. On project load: plugin scaffolds atlas/ + injects PROTOCOL.
2. New/large repo, no map yet?  atlas scan          # code-walk structure
3. Before a task:               atlas query "<topic>" [--tags ...]
4. During work:                 atlas record --type <T> --status <S> --summary "..." --conn "ID:relates"
5. Business changed?            atlas update BUS-x --status archived
6. Integrity check:             atlas check
```

Rule enforced by the skill + PROTOCOL: never re-propose what a `NEG-` or `DEC-` node already settled — query before proposing.

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
| duplicates / broken edges / stale tags | — | `check` |

Corrupt shards are skipped with a WARN by `query`/`get`/`recent`/`stat` and flagged by `check`. Writes are serialized by a lock file (stale locks auto-stolen after 5s), so concurrent AIs can't lose each other's records.

## Requirements

- Node ≥ 18 (zero runtime dependencies; stdlib only)

## License

MIT
