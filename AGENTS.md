# AGENTS.md — Atlas Owner

Atlas Owner = Product Owner graph memory for any project. Modular JSON graph (auto-split shards) + CLI + opencode enforce plugin. **Zero runtime dependencies**, Node ≥ 18.

Read this before touching the repo. If a rule here conflicts with what you were told, ask the user.

## What this repo is

| Path | Purpose |
|---|---|
| `skill/SKILL.md` | opencode skill — PO behavior + protocol. Distributed as-is. |
| `skill/scripts/atlas.mjs` | the CLI: `init` / `record` / `query` / `get` / `check`. Single source of graph logic. |
| `plugin/index.js` | opencode enforce plugin — auto-scaffolds `atlas/` in any project, injects `atlas/PROTOCOL.md` into project instructions. |
| `README.md` | user-facing install + usage docs. |

There is no build step and no test framework. Do not add dependencies.

## Hard rules (do not break)

1. **CLI-first.** The AI must never read `atlas/*.json` raw. All reads/writes go through `atlas.mjs`. This is the token-scaling guarantee.
2. **Zero deps.** stdlib only (`node:fs`, `node:path`, `node:os`). Node ≥ 18.
3. **Keep PROTOCOL in sync.** The `PROTOCOL.md` template is duplicated in `skill/scripts/atlas.mjs` and `plugin/index.js` (both marked `ponytail:`). Edit both together. It is injected into user projects — keep it short.
4. **Enforced limits** (in `atlas.mjs` `LIMITS`): summary ≤ 140 chars, node file ≤ 200 lines, shard ≤ 300 nodes (auto-split; `ATLAS_MAX_SHARD` overrides). Never raise these silently.
5. **Node types**: requirement, feature, task, bug, decision, positive, negative, edge, pitfall. **Status**: active, done, fixed, open, archived. **Conn types**: fixes, caused, led_to, relates, blocks, depends, contradicts, example_of, implements, satisfies.
6. **Seed rule**: exactly one node may be edge-less (the graph seed). Orphans are an integrity error. Seed exemption is derived from the data in `check`, never trusted from `manifest.seed_id`.

## Verify before committing

```bash
node --check skill/scripts/atlas.mjs
node --check plugin/index.js

# end-to-end smoke (uses temp dir)
cd /tmp && rm -rf atv && mkdir atv && A=<repo>/skill/scripts/atlas.mjs
node $A init atv
node $A record --id REQ-001 --type requirement --status active --tags core --summary "seed req" atv
node $A record --type feature --status active --tags seo --summary "hreflang" --conn "REQ-001:satisfies" atv
node $A check atv          # expect OK
node $A query "hreflang" atv   # expect FEAT-001 listed
```

Also run the plugin smoke (scaffold + config inject + legacy skip + home skip) with a small node one-liner like the one in plugin/index.js header comments.

## Changing behavior

- CLI behavior change → update `skill/SKILL.md`, `README.md`, and the duplicated PROTOCOL templates together. Three places, one feature.
- New node/conn type → update `TYPES` / `CONN_TYPES` in `atlas.mjs`, plus the PROTOCOL/RULES text in both files, plus `skill/SKILL.md` tables.
- `check` must stay strict: it is the only integrity gate for user data.

## Commit style

Conventional Commits, subject ≤ 50 chars. Include the `skill/`, `plugin/`, and docs changes for one logical change in the same commit.
