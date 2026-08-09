// atlas-owner plugin — enforce Atlas graph memory in any opencode project.
// On project load: scaffolds atlas/ (manifest + shards + tags_index + PROTOCOL)
// if neither atlas/ nor legacy memory/ exists, then injects PROTOCOL.md into
// project instructions so the protocol is always in context.
//
// Install: add to opencode.json "plugin" array, e.g.
//   "plugin": ["/abs/path/to/atlas-owner/plugin/index.js"]
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

// ponytail: duplicated with skill/scripts/atlas.mjs PROTOCOL. Keep in sync.
const PROTOCOL = `# Atlas Protocol

Graph memory for Product Owner behavior. Read before work, follow after work.

## Retrieval — Wajib lewat CLI. JANGAN baca atlas/*.json langsung.
node <atlas> query "keywords" [--tags a,b] [--limit 5]
node <atlas> recent [--limit 10]    # node terbaru
node <atlas> get ID

## Record — tiap kerja signifikan, langsung di command yang sama.
node <atlas> record --id TASK-003 --type task --status done --tags a,b --summary "max 140 char" --conn "BUG-001:fixes,DEC-002:led_to"
node <atlas> record --id REQ-001 --type requirement --status active --tags core --summary "..." --conn "FEAT-001:relates" --file nodes/REQ-001.md

## Bisnis — Atlas paham produknya juga. Track perubahan bisnis.
node <atlas> record --id BUS-001 --type business --status active --tags biz,model --summary "keadaan bisnis sekarang" --conn "DEC-002:relates"
# bisnis berubah? archive yang lama, record yang baru (chain led_to = timeline)
node <atlas> update BUS-001 --status archived
node <atlas> record --id BUS-002 --type business --status active --tags biz,model --summary "keadaan baru" --conn "BUS-001:led_to"

## Limits (dienforce oleh check)
- summary <= 140 chars
- node detail file <= 200 lines
- 1 shard <= 300 nodes (auto-split saat record)
- >= 1 conn per node. No orphan.

## PO behavior
Never re-propose what a NEG- or DEC- node already settled. Check the graph
via \`atlas query\` before proposing requirements, features, or changes.
`

const RULES = `# Atlas Rules

- Every fact = one node. No orphan nodes: each node has >= 1 conn edge.
- Modular: nodes live in index.{n}.json shards (auto-split at 300 default; ATLAS_MAX_SHARD overrides). id_map.json maps id -> shard; tags_index.json maps tag -> [{id, shard}].
- Never read atlas/*.json raw. Use the CLI: query, recent, get, record, update.
- summary <= 140 chars. node files <= 200 lines.

## Types: requirement, feature, task, bug, decision, business, positive, negative, edge, pitfall
## Status: active, done, fixed, open, archived
## Connections: fixes, caused, led_to, relates, blocks, depends, contradicts, example_of, implements, satisfies
`

const README = `# Atlas — Product Owner Graph Memory

- manifest.json + index.{n}.json (shards) + id_map.json + tags_index.json + nodes/*.md
- Read via CLI (query/recent/get/record), never raw JSON.
- Record every significant requirement, feature, decision, bug, task, gotcha.
`

function todayStr() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export default async ({ directory }) => {
  const root = resolve(directory || process.cwd())
  // Never scaffold into the home directory or a bare shell dir without a project marker.
  if (root === homedir()) return {}
  const atlas = join(root, 'atlas')
  const proto = join(atlas, 'PROTOCOL.md')
  const hasAtlas = existsSync(join(atlas, 'manifest.json'))
  const hasLegacy = existsSync(join(root, 'memory'))

  if (!hasAtlas && !hasLegacy) {
    mkdirSync(join(atlas, 'nodes'), { recursive: true })
    const today = todayStr()
    const manifest = `{
  "version": 1,
  "updated": "${today}",
  "active_shard": 0,
  "node_count": 0,
  "seed_id": null
}
`
    const shard = `{
  "shard": 0,
  "nodes": []
}
`
    // 'wx' = fail if file already exists (concurrent plugin load race)
    for (const [f, c] of [
      ['manifest.json', manifest],
      ['index.0.json', shard],
      ['tags_index.json', '{}\n'],
      ['id_map.json', '{}\n'],
    ]) {
      try {
        writeFileSync(join(atlas, f), c, { flag: 'wx' })
      } catch (e) {
        if (e.code !== 'EEXIST') throw e
      }
    }
    writeFileSync(proto, PROTOCOL)
    writeFileSync(join(atlas, 'rules.md'), RULES)
    writeFileSync(join(atlas, 'README.md'), README)
    console.log('[atlas-owner] scaffolded atlas/ graph memory (modular shards)')
  } else if (hasAtlas && !existsSync(proto)) {
    // Repair: atlas/ exists but protocol was lost. Only inject paths that exist.
    writeFileSync(proto, PROTOCOL)
  }

  return {
    config: (cfg) => {
      if (hasLegacy || !existsSync(proto)) return
      const instructions = cfg.instructions ?? []
      if (!instructions.includes('atlas/PROTOCOL.md')) {
        instructions.push('atlas/PROTOCOL.md')
        cfg.instructions = instructions
      }
    },
  }
}
