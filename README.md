# Atlas Owner — Product Owner Graph Memory

Persistent graph memory for any project, any AI. The AI remembers requirements, features, decisions, bugs, tasks, and gotchas like a real Product Owner — across sessions. Modular + auto-sharding + CLI-first = **scales to 10k+ nodes without eating your token budget**.

## Why it doesn't blow up tokens

- Nodes live in **auto-split shards** (`index.{n}.json`, 300 nodes each). No giant single file.
- The AI **never reads raw JSON**. It talks through the CLI (`query`/`get`), which reads files internally and returns only the matches. Context cost = size of the answer, not size of the memory.
- **Enforced limits**: summary ≤ 140 chars, detail files ≤ 200 lines, shard ≤ 300 nodes, no orphan nodes, tags kept in sync. `atlas check` verifies.

## What you get

```
atlas-owner/
├── skill/SKILL.md            # opencode skill (PO behavior + protocol)
├── skill/scripts/atlas.mjs   # CLI: init / record / query / get / check
└── plugin/index.js           # opencode enforce plugin (auto-init + protocol injection)
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

### 1. Skill (instructions)

```bash
mkdir -p ~/.config/opencode/skills
ln -s "$PWD/skill" ~/.config/opencode/skills/atlas-owner
# or copy: cp -R skill ~/.config/opencode/skills/atlas-owner
```

### 2. Plugin (enforce)

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

### 3. CLI (any project)

```bash
alias atlas='node /abs/path/to/atlas-owner/skill/scripts/atlas.mjs'
atlas init /path/to/project
atlas record --id BUG-001 --type bug --status fixed --tags seo,router --summary "hreflang duplikat" --conn "DEC-003:fixes" /path/to/project
atlas query "hreflang" --limit 5 /path/to/project
atlas recent /path/to/project
atlas stat /path/to/project
atlas get BUG-001 /path/to/project
atlas rebuild /path/to/project
atlas check /path/to/project
```

`--id` is optional — auto-generated as `{PREFIX}-{NNN}` from `--type`. First node (graph seed) may omit `--conn`; later nodes need ≥ 1 edge. IDs must match `{PREFIX}-{NNN}` (blocks path traversal).

Tuning shard size: `ATLAS_MAX_SHARD=500 atlas record ...`

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

## Node types

requirement · feature · task · bug · decision · positive · negative · edge · pitfall

## Edge types

fixes · caused · led_to · relates · blocks · depends · contradicts · example_of · implements · satisfies

## License

MIT
