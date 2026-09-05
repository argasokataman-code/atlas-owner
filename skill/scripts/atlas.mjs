#!/usr/bin/env node
// atlas — Product Owner graph memory CLI (modular, auto-shard).
//
// Commands:
//   atlas init [dir]                     scaffold atlas/
//   atlas record --id X --type T --status S --tags a,b --summary "..." [--conn "ID:type,..."] [--file path.md] [--loc file:line] [--commit hash] [dir]
//   atlas query "keywords" [--tags a,b] [--limit N] [--all] [--compact] [--since N] [--feature F] [dir]
//   atlas feature <name> [--paths a,b] [--remove-path p] [dir]   maintain path-prefix -> feature map
//   atlas context <filepath> [dir]      preflight: infer feature from a path, list its nodes (open first)
//   atlas get ID [dir]
//   atlas recent [--limit N] [dir]       newest nodes
//   atlas stat [dir]                     one-line counts by type/status
//   atlas rebuild [dir]                  rebuild id_map.json + tags_index.json + words_index.json
//   atlas scan [dir] [--target X] [--depth N] [--symbols]   map repo structure as feature/task nodes
//   atlas check [dir]
//
// Structure (modular on purpose):
//   atlas/manifest.json       small meta: active_shard, node_count, updated
//   atlas/index.{n}.json      node shards, auto-split at MAX_NODES_PER_SHARD
//   atlas/id_map.json         id -> shard (O(1) get, dup/conn checks)
//   atlas/tags_index.json     tag -> [{id, shard}] (legacy: plain id strings)
//   atlas/words_index.json    word -> [{id, shard}] (query candidate hint)
//   atlas/nodes/{ID}.md       optional detail, MAX_MD_LINES enforced
//   atlas/PROTOCOL.md         always-in-context retrieval rules
//
// Token rule: AI must call `atlas query/get`, never read atlas/*.json raw.
import { open, mkdir, readFile, writeFile, readdir, rm, stat as statFile } from 'node:fs/promises'
import { existsSync, readFileSync, realpathSync, cpSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve, sep, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Single source of truth for the CLI version. Keep in sync with
// package.json — the preversion script updates it on `npm version`.
const VERSION = '0.8.0'

// Data-schema version, separate from the package VERSION. Bump when the
// atlas/ JSON structure changes; MIGRATIONS carry the upgrade steps.
export const SCHEMA_VERSION = 5

// Ordered migration steps, each applied once when manifest.schema_version
// (or legacy .version) is < mig.from. Additive + idempotent: re-running a
// migration is a no-op because loadManifest gates on schema_version.
const MIGRATIONS = [
  {
    from: 1,
    to: 2,
    // v1 -> v2: stamp schema_version + migrated_at, ensure nodes/ exists.
    // Additive only — no data touched, no folders pre-created (that's M6/M9).
    up: async (dir, manifest) => {
      await mkdir(join(dir, 'nodes'), { recursive: true })
      manifest.path_features = manifest.path_features || {}
      manifest.schema_version = 2
      manifest.migrated_at = today()
    },
  },
  {
    from: 2,
    to: 3,
    // v2 -> v3: create empty words_index.json + backfill next_seq from ids.
    // words_index stays {} until `atlas rebuild` populates it; query treats an
    // empty index as inactive (falls back to allNodes), so partial data never
    // regresses. next_seq = max numeric suffix across all ids, single scan.
    up: async (dir, manifest) => {
      const f = join(dir, 'words_index.json')
      if (!existsSync(f)) await writeFile(f, '{}' + '\n')
      let max = 0
      for (let n = 0; n <= (manifest.active_shard ?? 0); n++) {
        const s = await loadShard(dir, n)
        if (s.corrupt) continue
        for (const node of s.nodes) {
          if (!node || !node.id) continue
          const num = parseInt(node.id.slice(node.id.lastIndexOf('-') + 1), 10)
          if (!Number.isNaN(num) && num > max) max = num
        }
      }
      manifest.next_seq = max
      manifest.schema_version = 3
    },
  },
  {
    from: 3,
    to: 4,
    // v3 -> v4: create empty symbol_index.json (repo-aware lookup). Additive +
    // idempotent: if already present (e.g. via scan --symbols) leave it alone.
    up: async (dir, manifest) => {
      const f = join(dir, 'symbol_index.json')
      if (!existsSync(f)) await writeFile(f, '{}\n')
      manifest.schema_version = 4
    },
  },
  {
    from: 4,
    to: 5,
    // v4 -> v5: create features/ placeholder for per-feature case files
    // (M6a). Additive + idempotent. path_features mapping is optional — it is
    // created lazily by `atlas feature`, so don't force it here.
    up: async (dir, manifest) => {
      await mkdir(join(dir, 'features'), { recursive: true })
      manifest.schema_version = 5
    },
  },
]

const TYPES = ['requirement', 'feature', 'task', 'bug', 'decision', 'business', 'positive', 'negative', 'edge', 'pitfall']
const CONN_TYPES = ['fixes', 'caused', 'led_to', 'relates', 'blocks', 'depends', 'contradicts', 'example_of', 'implements', 'satisfies']
const STATUSES = ['active', 'done', 'fixed', 'open', 'archived']
const PREFIX = { requirement: 'REQ', feature: 'FEAT', task: 'TASK', bug: 'BUG', decision: 'DEC', business: 'BUS', positive: 'POS', negative: 'NEG', edge: 'EDGE', pitfall: 'PF' }

export const LIMITS = {
  MAX_NODES_PER_SHARD: Number(process.env.ATLAS_MAX_SHARD) || 300,
  MAX_SUMMARY_CHARS: 140,
  MAX_MD_LINES: 200,
}

// IDs are {PREFIX}-{NNN}; the strict shape doubles as a path-traversal guard.
const ID_RE = /^[A-Z]{2,}-\d{3,}$/
const isValidId = (id) => typeof id === 'string' && ID_RE.test(id)

// ponytail: duplicated with plugin/index.js PROTOCOL. Keep in sync.
const PROTOCOL = `# Atlas Protocol

Graph memory for Product Owner behavior. Read before work, follow after work.

## Skill — load otomatis
Kalau skill "atlas-owner" tersedia, load dulu (skill({ name: "atlas-owner" }))
sebelum pakai atlas — itu berisi aturan lengkap PO behavior + protocol.

## Pertama kali di project — scan dulu
Kalau atlas/ baru dibuat (atau query kosong), jalankan scan sekali buat peta
struktur repo, baru kerja:
node <atlas> scan [--depth 2] [--symbols]

## Retrieval — pakai MCP tools kalau ada (atlas_query/atlas_get/...), selain itu CLI:
node <atlas> query "keywords" [--tags a,b] [--limit N] [--compact] [--all] [--since N] [--feature F] [--features]
node <atlas> recent [--limit 10]    # node terbaru
node <atlas> get ID
node <atlas> context <filepath>     # infer feature from file, list nodes
node <atlas> feature <nama> --paths a,b,c   # map path-prefix -> feature
node <atlas> cluster                # group active nodes by topic
# <atlas> diisi path absolut ke atlas.mjs oleh installer — jangan diganti manual.

## Record — tiap kerja signifikan, langsung di command yang sama.
node <atlas> record --id TASK-003 --type task --status done --tags a,b --summary "max 140 char" --conn "BUG-001:fixes,DEC-002:led_to" [--loc file:line] [--commit hash]
node <atlas> record --id REQ-001 --type requirement --status active --tags core --summary "..." --conn "FEAT-001:relates" --file nodes/REQ-001.md

## Auto-record minimal — WAJIB setelah kerja signifikan
Selesai implement/analisa/fix? Record MINIMAL 1 node di command yang sama.
Kerja besar (banyak file)? Pecah jadi beberapa node per fitur/keputusan.
Keputusan arsitektur/kerangka -> type decision. Ketemu bug -> bug.
Bisnis berubah -> business + archive yang lama (led_to chain).
Ragu antara 2 tipe -> tanya user, jangan nebak.
# Plugin juga auto-record node tag "auto" setelah edit/bash — boleh kamu rapiin
# jadi tipe/summary yang tepat lewat update.

## Bisnis — Atlas paham produknya juga. Track perubahan bisnis.
node <atlas> record --id BUS-001 --type business --status active --tags biz,model --summary "keadaan bisnis sekarang" --conn "DEC-002:relates"
# bisnis berubah? archive yang lama, record yang baru (chain led_to = timeline)
node <atlas> update BUS-001 --status archived
node <atlas> record --id BUS-002 --type business --status active --tags biz,model --summary "keadaan baru" --conn "BUS-001:led_to"

## Maintenance — bulk, prune, schema
node <atlas> update|delete --filter "type=task&status=done&tags=auto" [--dry-run]  # bulk by filter
node <atlas> prune [--days N] [--dry-run] [--force]    # archive old/done/auto noise
node <atlas> migrate | edit ID | export --stats | verify   # schema / edit / dump / integrity

## Limits (dienforce oleh check)
- summary <= 140 chars (auto-truncate ke nodes/{ID}.md kalau lebih panjang — gak ada yang hilang)
- node detail file <= 200 lines
- 1 shard <= 300 nodes (auto-split saat record)
- >= 1 conn per node. No orphan.

## PO behavior
Never re-propose what a NEG- or DEC- node already settled. Check the graph
via \`atlas query\` before proposing requirements, features, or changes.
Uncertain about a flow or insight (business OR technical)? Ask the user
before recording a node. Never guess a fact.
`

const RULES = `# Atlas Rules

- Every fact = one node. No orphan nodes: each node has >= 1 conn edge.
- Modular: nodes live in index.{n}.json shards (auto-split at ${LIMITS.MAX_NODES_PER_SHARD} default; ATLAS_MAX_SHARD overrides). id_map.json maps id -> shard; tags_index.json maps tag -> [{id, shard}]; words_index.json maps word -> [{id, shard}].
- Never read atlas/*.json raw. Use the CLI: query, recent, get, record, update.
- summary <= ${LIMITS.MAX_SUMMARY_CHARS} chars. node files <= ${LIMITS.MAX_MD_LINES} lines.

## Types: ${TYPES.join(', ')}
## Status: ${STATUSES.join(', ')}
## Connections: ${CONN_TYPES.join(', ')}

## Classification — choose one type:
- business: market/pricing/value-proposition state
- decision: a choice made (with reason)
- positive/negative: what worked / what failed
- edge: boundary case worth remembering
- pitfall: a trap to avoid (not just a failure)
- requirement/feature/task/bug: standard dev backlog
`

const README = `# Atlas — Product Owner Graph Memory

- manifest.json + index.{n}.json (shards) + id_map.json + tags_index.json + words_index.json + nodes/*.md
- Read via CLI (query/recent/get/record), never raw JSON.
- Record every significant requirement, feature, decision, bug, task, gotcha.
`

const usage = () => `Usage:
  atlas setup|init|ingest|record|query|get|update|delete|edit|recent|stat|scan|export|cluster|feature|context|verify|rebuild|migrate|prune|check [dir]

Commands:
  setup       auto-install MCP + plugin ke opencode config (global)
  init        scaffold atlas/
  ingest      read AGENTS.md + docs/**/*.md + root *.md -> knowledge nodes
  record      add node (--id --type --status --tags --summary --conn [--file] [--loc] [--commit])
  query       search ("keywords" [--tags a,b] [--limit N] [--all] [--compact] [--since N] [--feature F] [--features] [file:path])
  feature     map path-prefix -> feature (--paths a,b | --remove-path p)
  context     infer feature from file path; list its nodes, open first (top 10)
  get ID      show node
  update ID|--filter F  change node(s) (--status/--summary/--tags [--dry-run])
  delete ID|--filter F  remove node(s) (--force for referenced; --dry-run)
  prune       archive old/done/auto noise (--days N default 90; --dry-run; --force)
  edit ID      open node detail file in $EDITOR (creates nodes/{ID}.md if absent)
  --filter F  AND of key=val (& separated): type,status,tags,id,prefix
  recent      newest nodes (--limit N, default 10)
  export      dump full graph as JSON (stdout or --file path; --stats for counts by type/status)
  cluster     group active nodes by topic (count + first 5 node ids)
  stat        one-line counts by type/status
  scan        map repo structure (--target path, --depth N, --symbols; code-walk, idempotent)
  rebuild     rebuild id_map.json + tags_index.json + words_index.json (fixes drift)
  migrate     run pending schema migrations (+ backup)
  doctor      check installed versions across npm/global/skill/MCP
  check       verify integrity + limits
  verify      check + connector-integrity (dangling conn refs; exit 1 if any)`

const fail = (msg) => { console.error(msg); process.exitCode = 1 }

function today() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function nowTime() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function tryParseJson(text) {
  try { return JSON.parse(text) } catch { return null }
}

// Flags that take no value: their presence alone is the signal. Without this a
// trailing positional (the atlas dir, e.g. `--dry-run atv2`) would be swallowed
// as the flag's value and the dir lost.
const NO_VALUE_FLAGS = new Set(['force', 'dry-run', 'all', 'compact', 'symbols', 'stats', 'features'])

function parseArgs(argv) {
  const args = argv.slice(2)
  const cmd = args[0]
  const opts = {}
  const positional = []
  for (let i = 1; i < args.length; i++) {
    const a = args[i]
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      const key = eq !== -1 ? a.slice(2, eq) : a.slice(2)
      if (NO_VALUE_FLAGS.has(key)) { opts[key] = true; continue }
      if (eq !== -1) {
        // --flag=value: supports values that start with '--' (e.g. --summary "--x")
        // and empty values (--flag=)
        opts[key] = a.slice(eq + 1)
        continue
      }
      const next = args[i + 1]
      const val = next !== undefined && !next.startsWith('--') ? args[++i] : ''
      opts[key] = val
    } else {
      positional.push(a)
    }
  }
  return { cmd, opts, positional }
}

const atlasDir = (p) => join(resolve(p), 'atlas')

// Resolve a node file path. Project-relative first (so a file inside the
// project wins over a same-named file in CWD), then atlas-relative, then cwd.
function resolveNodeFile(dir, p) {
  const cands = [join(dirname(dir), p), join(dir, p), resolve(p)]
  return cands.find((c) => existsSync(c)) ?? null
}

// Last positional that exists on disk is treated as the target directory.
// Otherwise default to "." and treat all positionals as the command payload.
function splitPos(positional) {
  let dirArg = '.'
  const rest = [...positional]
  // A lone positional that is an existing directory is the atlas target (e.g.
  // `atlas update --filter X atv2`), not a payload id.
  if (rest.length === 1 && existsSync(resolve(rest[0]))) dirArg = rest.pop()
  else if (rest.length > 1 && existsSync(resolve(rest[rest.length - 1]))) dirArg = rest.pop()
  return { dirArg, rest }
}

// Resolve the effective data-schema version of a manifest. schema_version
// wins; else legacy .version (v1); else a manifest carrying node_count/seed_id
// is legacy v1; else assume v1 (safe, migrations are additive).
function schemaOf(m) {
  if (typeof m.schema_version === 'number') return m.schema_version
  if (typeof m.version === 'number') return m.version
  if (m.node_count !== undefined || m.seed_id !== undefined) return 1
  return 1
}

// Snapshot the whole atlas/ dir before any migration runs. Only called when a
// migration actually executes (never on a plain load). Node 18 has fs.cpSync.
async function backupAtlas(dir) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = join(dirname(dir), `atlas-backup-${ts}`)
  cpSync(dir, dest, { recursive: true })
  console.log(`backup: ${dest}`)
}

// Run all pending migrations on a manifest. Must be called under the lock.
// Additive + idempotent: if already at SCHEMA_VERSION, no-op (no backup).
async function applyMigrations(dir, m) {
  const from = schemaOf(m)
  if (from >= SCHEMA_VERSION) return { from, to: from, applied: false }
  await backupAtlas(dir)
  let cur = from
  for (const mig of MIGRATIONS) {
    if (cur !== mig.from) continue
    await mig.up(dir, m)
    cur = mig.to
  }
  m.schema_version = SCHEMA_VERSION
  if (!m.migrated_at) m.migrated_at = today()
  delete m.version // legacy field, cleaned after migration (idempotent)
  await saveManifest(dir, m)
  return { from, to: cur, applied: true }
}

async function loadManifest(dir) {
  const f = join(dir, 'manifest.json')
  if (!existsSync(f)) return null
  const m = tryParseJson(await readFile(f, 'utf8'))
  if (!m || typeof m !== 'object') return null
  const schema = schemaOf(m)
  if (schema > SCHEMA_VERSION) {
    console.warn(`atlas schema ${schema} is newer than this CLI (${SCHEMA_VERSION}) — data may be from a newer version`)
    return m
  }
  if (schema < SCHEMA_VERSION) {
    // Migrate under the lock to avoid concurrent write. If already locked
    // (e.g. called from inside withLock), migrate directly — no re-lock.
    if (_locked) { await applyMigrations(dir, m); return m }
    return await withLock(dir, async () => {
      const mm = tryParseJson(await readFile(f, 'utf8'))
      if (!mm || typeof mm !== 'object') return m
      await applyMigrations(dir, mm)
      return mm
    })
  }
  return m
}

async function saveManifest(dir, m) {
  m.updated = today()
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(m, null, 2) + '\n')
}

async function loadTags(dir) {
  const f = join(dir, 'tags_index.json')
  if (!existsSync(f)) return {}
  return tryParseJson(await readFile(f, 'utf8')) || {}
}

async function saveTags(dir, tags) {
  await writeFile(join(dir, 'tags_index.json'), JSON.stringify(tags, null, 2) + '\n')
}

// Words index: word -> [{id, shard}]. Missing file returns null (query falls
// back to allNodes); an empty {} means "not rebuilt yet" (inactive).
async function loadWordsIndex(dir) {
  const f = join(dir, 'words_index.json')
  if (!existsSync(f)) return null
  return tryParseJson(await readFile(f, 'utf8')) || {}
}

async function saveWordsIndex(dir, index) {
  await writeFile(join(dir, 'words_index.json'), JSON.stringify(index, null, 2) + '\n')
}

// shard entry: { shard, nodes, corrupt? }
async function loadShard(dir, n) {
  const f = join(dir, `index.${n}.json`)
  if (!existsSync(f)) return { shard: n, nodes: [] }
  const data = tryParseJson(await readFile(f, 'utf8'))
  if (!data || !Array.isArray(data.nodes)) return { shard: n, nodes: [], corrupt: f }
  return { shard: n, nodes: data.nodes }
}

async function allNodes(dir, manifest) {
  const out = []
  const corrupt = []
  for (let n = 0; n <= (manifest?.active_shard ?? 0); n++) {
    const s = await loadShard(dir, n)
    if (s.corrupt) { corrupt.push(s.corrupt); continue }
    out.push(...s.nodes)
  }
  return { nodes: out, corrupt }
}

async function loadIdMap(dir) {
  const f = join(dir, 'id_map.json')
  if (!existsSync(f)) return null
  const m = tryParseJson(await readFile(f, 'utf8'))
  return m && typeof m === 'object' ? m : {}
}

async function buildIdMap(dir, manifest) {
  const m = {}
  for (let n = 0; n <= (manifest?.active_shard ?? 0); n++) {
    const s = await loadShard(dir, n)
    if (s.corrupt) continue
    for (const node of s.nodes) if (node && node.id) m[node.id] = s.shard
  }
  return m
}

async function saveIdMap(dir, m) {
  await writeFile(join(dir, 'id_map.json'), JSON.stringify(m, null, 2) + '\n')
}

// Serialize writers: record + rebuild take the lock so two AIs can't lose each
// other's updates. Stale lock (older than 5s) is stolen.
let _locked = false
async function withLock(dir, fn) {
  const lock = join(dir, '.lock')
  for (let i = 0; i < 20; i++) {
    try {
      const h = await open(lock, 'wx')
      await h.close()
      _locked = true
      try { return await fn() } finally { _locked = false; await rm(lock, { force: true }) }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      try {
        const st = await statFile(lock)
        if (Date.now() - st.mtimeMs > 5000) { await rm(lock, { force: true }); continue }
      } catch { continue }
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  fail('FAIL: could not acquire write lock (another writer busy)')
}

async function init(dir) {
  await mkdir(join(dir, 'nodes'), { recursive: true })
  await mkdir(join(dir, 'features'), { recursive: true })
  const manifest = await loadManifest(dir)
  if (!manifest) await saveManifest(dir, { schema_version: SCHEMA_VERSION, updated: today(), active_shard: 0, node_count: 0, seed_id: null, path_features: {} })
  if (!existsSync(join(dir, 'index.0.json'))) await writeFile(join(dir, 'index.0.json'), JSON.stringify({ shard: 0, nodes: [] }, null, 2) + '\n')
  if (!existsSync(join(dir, 'tags_index.json'))) await saveTags(dir, {})
  if (!existsSync(join(dir, 'id_map.json'))) await saveIdMap(dir, {})
  if (!existsSync(join(dir, 'words_index.json'))) await saveWordsIndex(dir, {})
  if (!existsSync(join(dir, 'symbol_index.json'))) await writeFile(join(dir, 'symbol_index.json'), '{}\n')
  const cliPath = fileURLToPath(import.meta.url)
  for (const [f, c] of [['PROTOCOL.md', PROTOCOL.replaceAll('<atlas>', cliPath)], ['rules.md', RULES], ['README.md', README]]) {
    if (!existsSync(join(dir, f))) await writeFile(join(dir, f), c)
  }
  console.log(`Atlas initialized at ${dir}`)
  await check(dir)
}

// Find the package root by walking up until a package.json named
// atlas-owner is found. Works whether this file runs from the repo
// (skill/scripts/), the npm install (skill/scripts/), or a skill copy
// (scripts/ inside skills/atlas-owner) — "../../" alone is wrong for
// skill copies and would point plugin/ at a nonexistent path.
function findPkgRoot(from = dirname(fileURLToPath(import.meta.url))) {
  let d = from
  while (d && d !== dirname(d)) {
    const pkg = join(d, 'package.json')
    if (existsSync(pkg)) {
      try { if ((JSON.parse(readFileSync(pkg, 'utf8')).name || '') === 'atlas-owner') return d } catch { /* keep walking */ }
    }
    d = dirname(d)
  }
  return from
}

// Auto-install: register atlas MCP server + enforce plugin in the global
// opencode config so a fresh session has both without manual editing.
async function setup() {
  const home = process.env.HOME || ''
  const cfgPath = join(home, '.config', 'opencode', 'opencode.json')
  const cfg = existsSync(cfgPath) ? (tryParseJson(await readFile(cfgPath, 'utf8')) || {}) : {}
  const root = findPkgRoot()
  if (root === dirname(fileURLToPath(import.meta.url)) || !existsSync(join(root, 'plugin', 'index.js'))) {
    console.error('FAIL: atlas setup must run from a repo/npm install, not a skill copy.')
    return
  }
  const pluginPath = join(root, 'plugin', 'index.js')
  const mcpServerPath = join(root, 'plugin', 'mcp-server.js')
  let changed = false

  if (!Array.isArray(cfg.plugin)) cfg.plugin = []
  if (!cfg.plugin.some((p) => p && p.includes('atlas-owner/plugin/index.js'))) {
    cfg.plugin.push(pluginPath)
    changed = true
  }

  if (!cfg.mcp) cfg.mcp = {}
  const existing = cfg.mcp.atlas
  const entry = { type: 'local', command: ['node', mcpServerPath], enabled: true }
  const isSame = existing && existing.type === 'local'
    && Array.isArray(existing.command) && existing.command[0] === 'node' && existing.command[1] === mcpServerPath
  if (!isSame) {
    cfg.mcp.atlas = entry
    changed = true
  }

  await mkdir(dirname(cfgPath), { recursive: true })
  await writeFile(cfgPath, JSON.stringify(cfg, null, 2) + '\n')
  if (changed) console.log(`atlas installed into ${cfgPath}\n  plugin: ${pluginPath}\n  mcp:    ${mcpServerPath}\nRestart opencode for it to take effect.`)
  else console.log(`atlas already installed in ${cfgPath} (no change)`)
}

// Read the "version" field of a package.json without requiring it (file may
// not be a valid module). Returns null on any failure.
function pkgVersion(pkgPath) {
  try { return JSON.parse(readFileSync(pkgPath, 'utf8')).version ?? null } catch { return null }
}

// Best-effort shell command; returns stdout trimmed or null.
function sh(cmd, args) {
  try { return spawnSync(cmd, args, { encoding: 'utf8', timeout: 10000 }).stdout.trim() || null } catch { return null }
}

// Compare versions of every installed atlas: the copy this CLI is running
// from, the npm global install, the opencode skill copy, and the path wired
// into the opencode MCP config. Prints a table + what to run to fix drift.
async function doctor() {
  const home = process.env.HOME || ''
  const thisRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const mine = pkgVersion(join(thisRoot, 'package.json'))
  const rows = [['where', 'version', 'status']]

  const skill = join(home, '.config', 'opencode', 'skills', 'atlas-owner', 'scripts', 'atlas.mjs')
  // Skill copy has no package.json of its own; report whether its atlas.mjs
  // matches the CLI running right now, which is the thing that matters.
  let skillV = null, skillSync = false
  if (existsSync(skill)) {
    const mine = readFileSync(fileURLToPath(import.meta.url), 'utf8')
    const copy = readFileSync(skill, 'utf8')
    skillSync = mine === copy
    skillV = skillSync ? pkgVersion(join(thisRoot, 'package.json')) : 'drifted'
  }

  const cfgPath = join(home, '.config', 'opencode', 'opencode.json')
  const cfg = existsSync(cfgPath) ? tryParseJson(readFileSync(cfgPath, 'utf8')) : null
  const mcpPath = cfg?.mcp?.atlas?.command?.[1] || null
  const mcpV = mcpPath && existsSync(mcpPath)
    ? pkgVersion(join(dirname(mcpPath), '..', 'package.json'))
    : null

  const globalRoot = sh('npm', ['root', '-g'])
  const globalV = globalRoot ? pkgVersion(join(globalRoot, 'atlas-owner', 'package.json')) : null

  const latest = sh('npm', ['view', 'atlas-owner', 'version']) || '?'

  const pushes = []
  const push = (where, v, flag, note) => {
    rows.push([where, v ?? 'missing', flag, note || ''])
    if (flag !== 'ok') pushes.push(note)
  }

  push('this CLI', mine, mine === latest ? 'ok' : (mine ? 'outdated' : 'missing'), mine === latest ? '' : `publish + install ${latest}`)
  push('npm global', globalV, globalV === latest ? 'ok' : (globalV ? 'outdated' : 'missing'), globalV === latest ? '' : `npm install -g atlas-owner@${latest}`)
  push('skill copy', skillV, skillSync ? 'ok' : (skillV ? 'outdated' : 'missing'), skillSync ? '' : `re-copy skill/ -> ~/.config/opencode/skills/atlas-owner`)
  push('MCP config', mcpV, mcpV === latest ? 'ok' : (mcpV ? 'outdated' : 'missing'), mcpV === latest ? '' : `re-run: atlas setup`)

  const w = Math.max(...rows.map((r) => r[0].length), 6)
  console.log('atlas install status (latest on npm: ' + latest + '):')
  for (const [a, b, c, d] of rows) {
    console.log(`  ${a.padEnd(w)}  ${(b ?? '').padEnd(9)}  ${c.padEnd(8)}${d ? '→ ' + d : ''}`)
  }
  console.log('  Note: opencode loads MCP/plugin at session start. After updating, restart opencode.')
  if (pushes.length) console.log('\nFix:\n  ' + pushes.join('\n  '))
}

function parseConn(raw) {
  if (!raw) return []
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const parts = s.split(':')
    const id = (parts[0] || '').trim()
    const type = ((parts[1] || 'relates').trim() || 'relates').trim()
    return { id, type, raw: s }
  })
}

// Generate the next id for a prefix. Uses the global next_seq counter when
// present (migration backfills it to >= max existing suffix, so auto-ids never
// collide); falls back to scanning ids (legacy) if next_seq is missing.
function nextId(man, prefix, ids) {
  if (typeof man.next_seq === 'number') {
    const seq = man.next_seq + 1
    man.next_seq = seq
    return `${prefix}-${String(seq).padStart(3, '0')}`
  }
  let max = 0
  for (const id of ids || []) {
    if (id.startsWith(prefix + '-')) {
      const num = parseInt(id.slice(prefix.length + 1), 10)
      if (!Number.isNaN(num) && num > max) max = num
    }
  }
  return `${prefix}-${String(max + 1).padStart(3, '0')}`
}

async function record(dir, opts) {
  const manifest = await loadManifest(dir)
  if (!manifest) { fail('FAIL: atlas/ not initialized. Run: atlas init'); return }
  if (opts.id && !isValidId(opts.id)) { fail(`FAIL: invalid --id "${opts.id}" (expected e.g. BUG-001)`); return }
  if (!TYPES.includes(opts.type)) { fail(`FAIL: invalid --type "${opts.type}". Valid: ${TYPES.join(', ')}`); return }
  if (!STATUSES.includes(opts.status)) { fail(`FAIL: invalid --status "${opts.status}". Valid: ${STATUSES.join(', ')}`); return }
  const summary = opts.summary
  if (!summary || !summary.trim()) { fail('FAIL: --summary required (non-empty)'); return }
  const tags = opts.tags ? [...new Set(opts.tags.split(',').map((t) => t.trim()).filter(Boolean))] : []
  const conn = parseConn(opts.conn)
  // Over-long summary: don't drop it. Store the full text in nodes/{ID}.md and
  // keep a truncated summary in the node so nothing is lost.
  let overflow = null
  if (summary.length > LIMITS.MAX_SUMMARY_CHARS) overflow = summary
  let filePath = null
  if (opts.file) {
    filePath = resolveNodeFile(dir, opts.file)
    if (!filePath) { fail(`FAIL: --file not found: ${opts.file}`); return }
    // Trust boundary: the detail file must stay inside the project root.
    const root = resolve(dirname(dir)) + sep
    if (!filePath.startsWith(root)) { fail(`FAIL: --file outside project: ${opts.file}`); return }
    const text = await readFile(filePath, 'utf8')
    const lines = text.trimEnd().split('\n').length
    if (lines > LIMITS.MAX_MD_LINES) { fail(`FAIL: node file ${lines} lines > limit ${LIMITS.MAX_MD_LINES}`); return }
  }

  await withLock(dir, async () => {
    const man = await loadManifest(dir)
    if (!man) { fail('FAIL: atlas/ not initialized. Run: atlas init'); return }
    const idMap = await loadIdMap(dir)
    const scanNodes = () => allNodes(dir, man).then((r) => r.nodes)
    const ids = idMap ? Object.keys(idMap) : null

    let id = opts.id
    if (!id) {
      const prefix = PREFIX[opts.type]
      id = nextId(man, prefix, ids ?? (await scanNodes()).map((n) => n.id))
    } else if ((idMap && idMap[id] !== undefined) || (!idMap && (await scanNodes()).some((n) => n.id === id))) {
      fail(`FAIL: duplicate node id ${id}`); return
    }
    if (!isValidId(id)) { fail(`FAIL: invalid --id "${id}" (expected e.g. BUG-001)`); return }
    // Keep next_seq as the global max suffix so a later auto-id never collides
    // with an explicit --id that used a higher number.
    if (typeof man.next_seq !== 'number') man.next_seq = 0
    const idSuffix = parseInt(id.slice(id.lastIndexOf('-') + 1), 10)
    if (idSuffix > man.next_seq) man.next_seq = idSuffix

    const emptyGraph = idMap ? Object.keys(idMap).length === 0 : (await scanNodes()).length === 0
    if (conn.length === 0 && !emptyGraph) { fail('FAIL: --conn required (>= 1 edge). Format: ID:type,ID:type'); return }
    const seen = new Set()
    for (const c of conn) {
      if (c.raw && c.raw.split(':').length > 2) { fail(`FAIL: --conn format invalid "${c.raw}" (expected ID:type)`); return }
      if (!isValidId(c.id)) { fail(`FAIL: --conn id invalid "${c.id}" (expected e.g. BUG-001)`); return }
      if (c.id === id) { fail(`FAIL: --conn self-loop ${c.id} -> itself`); return }
      if (!CONN_TYPES.includes(c.type)) { fail(`FAIL: --conn type "${c.type}" invalid`); return }
      const exists = idMap ? idMap[c.id] !== undefined : (await scanNodes()).some((n) => n.id === c.id)
      if (!exists) { fail(`FAIL: --conn -> unknown node ${c.id}`); return }
      const key = `${c.id}:${c.type}`
      if (seen.has(key)) { fail(`FAIL: --conn duplicate ${key}`); return }
      seen.add(key)
    }

    const node = { id, type: opts.type, status: opts.status, date: today(), time: nowTime(), tags, summary: overflow ? summary.slice(0, LIMITS.MAX_SUMMARY_CHARS) : summary, conn }
    if (opts.loc) node.loc = opts.loc
    if (opts.commit) node.commit = opts.commit
    const shardNum = man.active_shard
    const shard = await loadShard(dir, shardNum)
    if (shard.corrupt) { fail(`FAIL: active shard corrupt: ${shard.corrupt}. Run: atlas check`); return }
    shard.nodes.push(node)
    await writeFile(join(dir, `index.${shardNum}.json`), JSON.stringify(shard, null, 2) + '\n')
    man.node_count++
    if (shard.nodes.length >= LIMITS.MAX_NODES_PER_SHARD) {
      man.active_shard++
      await writeFile(join(dir, `index.${man.active_shard}.json`), JSON.stringify({ shard: man.active_shard, nodes: [] }, null, 2) + '\n')
    }
    await saveManifest(dir, man)

    if (idMap) { idMap[id] = shardNum; await saveIdMap(dir, idMap) }

    const tagsIndex = await loadTags(dir)
    for (const t of tags) {
      ;(tagsIndex[t] ??= []).push({ id, shard: shardNum })
    }
    await saveTags(dir, tagsIndex)

    // Maintain words_index incrementally when it has been rebuilt (active).
    const wIdx = await loadWordsIndex(dir)
    if (wIdx && Object.keys(wIdx).length) {
      indexNodeWords(wIdx, node, shardNum)
      await saveWordsIndex(dir, wIdx)
    }

    // Over-long summary: store the full text as the node's detail file so
    // nothing is lost. Truncate the stored summary so check stays green.
    if (overflow) {
      await mkdir(join(dir, 'nodes'), { recursive: true })
      await writeFile(join(dir, 'nodes', `${id}.md`), overflow + '\n')
    }

    // Copy the detail file into nodes/{ID}.md so `get` can show it. The file
    // may live outside atlas/ (project root) but never outside the project.
    if (filePath) {
      await mkdir(join(dir, 'nodes'), { recursive: true })
      await writeFile(join(dir, 'nodes', `${id}.md`), await readFile(filePath, 'utf8'))
    }

    // M6a: append the node to its feature case files when it resolved via a
    // path mapping (loc or --file). Inferred/tag features stay flat, so a node
    // without a path mapping never creates stray feature files.
    const fh = filePath ? relative(resolve(dirname(dir)), filePath) : null
    const fr = inferFeature(node, man, fh)
    if (fr.source === 'path' && fr.feature !== '_uncategorized') await writeFeatureFiles(dir, fr.feature, node)
    console.log(`recorded ${id} -> index.${shardNum}.json`)
  })
}

// M6a: per-feature case folders. A node's "feature" is derived deterministically:
// loc/path -> path_features mapping (longest prefix wins), else tags[0] (if not
// 'auto'), else first summary word, else _uncategorized. Feature files are only
// written when the node resolved via a path mapping — tag/summary-inferred
// features exist for query/context grouping only (keeps _uncategorized flat).
function featureFromLoc(path, pf) {
  if (!path || !pf || typeof pf !== 'object') return null
  let best = null
  let bestLen = -1
  for (const [prefix, feature] of Object.entries(pf)) {
    if (!prefix || typeof feature !== 'string') continue
    const pr = prefix.replace(/[/\\]+$/, '')
    if (path === pr || path.startsWith(pr + '/') || path.startsWith(pr + '\\')) {
      if (pr.length > bestLen) { best = feature; bestLen = pr.length }
    }
  }
  return best
}

function inferFeature(node, manifest, hint) {
  const pf = (manifest && manifest.path_features) || {}
  const path = node?.loc ? node.loc.split(':')[0] : (hint || '')
  if (path) {
    const f = featureFromLoc(path, pf)
    if (f) return { feature: f, source: 'path' }
    return { feature: '_uncategorized', source: 'uncategorized' }
  }
  const tag = (node?.tags || []).find((t) => t && t !== 'auto')
  if (tag) return { feature: String(tag), source: 'tags' }
  const first = String(node?.summary || '').trim().split(/\s+/)[0]
  if (first && !STOPWORDS.has(first.toLowerCase())) return { feature: first.toLowerCase(), source: 'tags' }
  return { feature: '_uncategorized', source: 'uncategorized' }
}

// ponytail: append-only. If the feature file already holds this node id, skip
// (idempotent); else append the one-liner. No rewrite of prior lines.
async function appendFeatureLine(fp, line, id) {
  const marker = `- ${id} (`
  let body = ''
  if (existsSync(fp)) {
    body = await readFile(fp, 'utf8')
    if (body.includes(marker)) return
  }
  await writeFile(fp, body.replace(/\n+$/, '') + (body ? '\n' : '') + line + '\n')
}

// Ensure a feature file exists (with a header on first create) then append the
// node line to every applicable case file. Unmapped/_uncategorized is skipped by
// the caller, so no stray files are created for non-feature nodes.
async function writeFeatureFiles(dir, feature, node) {
  const featDir = join(dir, 'features', feature)
  await mkdir(featDir, { recursive: true })
  const line = `- ${node.id} (${node.type}/${node.status}): ${node.summary}`
  const ensure = async (name, header) => {
    const fp = join(featDir, name)
    if (!existsSync(fp)) await writeFile(fp, header + '\n')
    await appendFeatureLine(fp, line, node.id)
  }
  await ensure('index.md', `# ${feature} feature cases`)
  if (['bug', 'negative', 'pitfall'].includes(node.type)) await ensure('BUGS.md', `# ${feature} bugs`)
  if (node.type === 'edge') await ensure('EDGES.md', `# ${feature} edge cases`)
  if (node.status === 'open' && ['bug', 'pitfall', 'edge', 'negative'].includes(node.type)) await ensure('ISSUES.md', `# ${feature} open issues`)
}

// `atlas feature <name> --paths a,b | --remove-path p [dir]`: maintain the
// path-prefix -> feature mapping in manifest.path_features.
async function featureCmd(dir, opts) {
  const manifest = await loadManifest(dir)
  if (!manifest) { fail('FAIL: atlas/ not initialized. Run: atlas init'); return }
  const name = String(opts._name || '').trim()
  if (!name) { fail('FAIL: atlas feature <name> required'); return }
  if (!opts.paths && !opts['remove-path']) { fail('FAIL: feature needs --paths or --remove-path'); return }
  await withLock(dir, async () => {
    const man = await loadManifest(dir)
    if (!man.path_features || typeof man.path_features !== 'object') man.path_features = {}
    const pf = man.path_features
    if (opts['remove-path']) {
      for (const p of opts['remove-path'].split(',').map((s) => s.trim()).filter(Boolean)) {
        if (pf[p] === undefined) { console.log(`path not mapped: ${p}`); continue }
        delete pf[p]
        console.log(`removed ${p} (was ${name})`)
      }
    } else {
      const added = []
      for (const p of opts.paths.split(',').map((s) => s.trim()).filter(Boolean)) {
        const existing = pf[p]
        if (existing && existing !== name) { fail(`FAIL: path ${p} already mapped to ${existing}`); return }
        pf[p] = name
        added.push(p)
        console.log(`mapped ${p} -> ${name}`)
      }
      // Backfill feature files for nodes recorded before this mapping existed.
      // ponytail: linear scan over all nodes, only writes for loc matching the
      // newly-mapped paths; appendFeatureLine is idempotent per id.
      const { nodes: all } = await allNodes(dir, man)
      let backfilled = 0
      for (const n of all) {
        if (!n.loc) continue
        const path = n.loc.split(':')[0]
        const matched = added.some((p) => {
          const pr = p.replace(/[/\\]+$/, '')
          return path === pr || path.startsWith(pr + '/') || path.startsWith(pr + '\\')
        })
        if (!matched) continue
        await writeFeatureFiles(dir, name, n)
        backfilled++
      }
      if (backfilled) console.log(`backfilled ${backfilled} node(s) into features/${name}/`)
    }
    await saveManifest(dir, man)
  })
}

// `atlas context <filepath> [dir]`: preflight enabler for M6b — infer the
// feature from a path and list its nodes, open bugs/issues first, top 10.
async function contextCmd(dir, opts) {
  const manifest = await loadManifest(dir)
  if (!manifest) { fail('FAIL: atlas/ not initialized. Run: atlas init'); return }
  const p = String(opts._path || '').trim()
  if (!p) { fail('FAIL: atlas context <filepath> required'); return }
  const feat = featureFromLoc(p, manifest.path_features) || '_uncategorized'
  const { nodes } = await allNodes(dir, manifest)
  const score = (n) => (n.status === 'open' ? 10 : 0) + (['bug', 'pitfall', 'edge', 'negative'].includes(n.type) ? 5 : 0)
  const list = nodes
    .filter((n) => n.status !== 'archived' && inferFeature(n, manifest).feature === feat)
    .sort((a, b) => score(b) - score(a))
  const top = list.slice(0, 10)
  console.log(`context ${p}: feature=${feat}${list.length ? ` (${list.length} nodes)` : ''}`)
  if (!top.length) { console.log('  (no nodes)'); return }
  for (const n of top) printNode(dir, n)
}

function scoreNode(node, words, tagFilter) {
  const summary = (node.summary || '').toLowerCase()
  const tags = (node.tags || []).map((t) => t.toLowerCase())
  const id = (node.id || '').toLowerCase()
  if (tagFilter.length) {
    if (!tagFilter.some((tf) => tags.includes(tf.toLowerCase()))) return -1
  }
  let score = 0
  for (const w of words) {
    if (id === w) score += 10
    else if (id.includes(w)) score += 6
    if (tags.includes(w)) score += 5
    if (summary.includes(w)) score += 3
    else if (summary.includes(w.slice(0, 4))) score += 1
  }
  // Tag-only queries match on tags alone; wordless + tagless matches nothing.
  if (score === 0 && words.length > 0) return -1
  return score
}

// ponytail: `file:` query matches node.loc prefix. A bare file name (no dir)
// also matches any loc ending with that name, so "file:feed.ts" hits
// "src/feed.ts:1". No parser — string prefix is enough for a lookup hint.
function fileLocMatch(loc, path) {
  if (!loc) return false
  if (loc === path) return true
  if (loc.startsWith(path + ':')) return true
  if (!path.includes('/') && !path.includes('\\')) {
    const base = loc.split(':')[0]
    if (base === path || base.endsWith('/' + path)) return true
  }
  return false
}

// Narrow to the shards that actually hold tagged nodes when --tags is given.
// tags_index v2 entries are {id, shard}; legacy entries are plain id strings.
async function tagCandidates(dir, manifest, tagFilter) {
  const tagsIndex = await loadTags(dir)
  const folded = {}
  for (const [k, v] of Object.entries(tagsIndex)) folded[k.toLowerCase()] = v
  const shards = new Set()
  const ids = new Set()
  for (const tf of tagFilter) {
    const list = folded[tf.toLowerCase()]
    if (!list) continue
    for (const e of list) {
      if (typeof e === 'string') ids.add(e)
      else { ids.add(e.id); if (typeof e.shard === 'number') shards.add(e.shard) }
    }
  }
  if (!ids.size) return { nodes: [], corrupt: [] }
  if (shards.size) {
    const nodes = []
    const corrupt = []
    for (const s of shards) {
      const sh = await loadShard(dir, s)
      if (sh.corrupt) corrupt.push(sh.corrupt)
      else nodes.push(...sh.nodes)
    }
    return { nodes, corrupt }
  }
  const { nodes, corrupt } = await allNodes(dir, manifest)
  return { nodes: nodes.filter((n) => ids.has(n.id)), corrupt }
}

// Build the inverted words index (word -> [{id, shard}]) from summary + tags
// + id. Mutates the passed index object (idempotent per node id).
function indexNodeWords(index, node, shard) {
  const add = (w) => {
    const key = String(w).toLowerCase()
    if (!key) return
    let list = index[key]
    if (!list) list = index[key] = []
    if (!list.some((e) => e.id === node.id)) list.push({ id: node.id, shard })
  }
  for (const w of (node.summary || '').split(/\s+/)) add(w)
  for (const t of node.tags || []) add(t)
  add(node.id)
}

function removeNodeFromWords(index, nodeId) {
  for (const k of Object.keys(index)) {
    index[k] = index[k].filter((e) => (typeof e === 'string' ? e : e.id) !== nodeId)
    if (!index[k].length) delete index[k]
  }
}

async function rebuildWordsIndex(dir, manifest, idMap) {
  const { nodes } = await allNodes(dir, manifest)
  const index = {}
  for (const n of nodes) indexNodeWords(index, n, idMap?.[n.id])
  await saveWordsIndex(dir, index)
  return index
}

// ponytail: index is a HINT — union candidate ids across query words, then
// score full nodes from only those shards. Wordless queries fall back to
// allNodes so an empty/blank query still lists everything.
async function wordCandidates(dir, manifest, words, index) {
  if (!words.length) return allNodes(dir, manifest)
  const ids = new Set()
  const shards = new Set()
  for (const w of words) {
    const list = index[w.toLowerCase()]
    if (!list) continue
    for (const e of list) {
      if (typeof e === 'string') ids.add(e)
      else { ids.add(e.id); if (typeof e.shard === 'number') shards.add(e.shard) }
    }
  }
  if (!ids.size) return { nodes: [], corrupt: [] }
  if (shards.size) {
    const nodes = []
    const corrupt = []
    for (const s of shards) {
      const sh = await loadShard(dir, s)
      if (sh.corrupt) corrupt.push(sh.corrupt)
      else nodes.push(...sh.nodes.filter((n) => ids.has(n.id)))
    }
    return { nodes, corrupt }
  }
  const { nodes, corrupt } = await allNodes(dir, manifest)
  return { nodes: nodes.filter((n) => ids.has(n.id)), corrupt }
}

const clampLimit = (raw, def, max) => Math.max(0, Math.min(parseInt(raw, 10) || def, max))

function printNode(dir, n) {
  const hasFile = existsSync(join(dir, 'nodes', `${n.id}.md`)) ? ' +md' : ''
  console.log(`[${n.id}] ${n.type}/${n.status} #${(n.tags || []).join('#')} — ${n.summary}${hasFile}`)
}

async function query(dir, opts) {
  const manifest = await loadManifest(dir)
  if (!manifest) { fail('FAIL: atlas/ not initialized. Run: atlas init'); return }
  if (opts.features) {
    const { nodes } = await allNodes(dir, manifest)
    const counts = {}
    for (const n of nodes) {
      if (n.status === 'archived' && !opts.all) continue
      const f = inferFeature(n, manifest).feature
      counts[f] = (counts[f] || 0) + 1
    }
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    console.log(`features: ${entries.length}`)
    if (!entries.length) { console.log('  (no nodes)'); return }
    for (const [f, c] of entries) console.log(`  ${String(c).padStart(3)}  ${f}`)
    return
  }
  const words = opts._q ? opts._q.toLowerCase().split(/\s+/).filter(Boolean) : []
  const tagFilter = opts.tags ? opts.tags.split(',').map((t) => t.trim()).filter(Boolean) : []
  const limit = clampLimit(opts.limit, 5, 20)

  let since = null
  if (opts.since) {
    const n = parseInt(opts.since, 10)
    if (!Number.isFinite(n)) { fail('FAIL: --since needs a number of days'); return }
    const d = new Date()
    d.setDate(d.getDate() - n)
    const p = (x) => String(x).padStart(2, '0')
    since = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }

  const fileQuery = words.find((w) => w.startsWith('file:'))
  let source
  if (fileQuery) {
    // file: prefix bypasses the word index — matches on node.loc, not summary.
    source = await allNodes(dir, manifest)
  } else if (tagFilter.length) {
    source = await tagCandidates(dir, manifest, tagFilter)
  } else {
    const wIdx = await loadWordsIndex(dir)
    // ponytail: index active only when rebuilt (has keys); empty/missing index
    // falls back to allNodes so partial data never regresses.
    source = (wIdx && Object.keys(wIdx).length)
      ? await wordCandidates(dir, manifest, words, wIdx)
      : await allNodes(dir, manifest)
  }
  if (source.corrupt.length) console.error(`WARN: skipping corrupt shard file(s): ${source.corrupt.join(', ')}. Run: atlas check`)

  let nodes = source.nodes
  if (!opts.all) nodes = nodes.filter((n) => n.status !== 'archived')
  if (since) nodes = nodes.filter((n) => (n.date || '') >= since)
  if (opts.feature) nodes = nodes.filter((n) => inferFeature(n, manifest).feature === String(opts.feature).trim())

  let matches
  if (fileQuery) {
    const path = fileQuery.slice(5)
    matches = nodes.filter((n) => fileLocMatch(n.loc, path))
  } else {
    matches = nodes.filter((n) => scoreNode(n, words, tagFilter) >= 0)
  }
  if (!words.length && !tagFilter.length) matches = nodes
  matches.sort((a, b) => scoreNode(b, words, tagFilter) - scoreNode(a, words, tagFilter))
  const top = matches.slice(0, limit)
  if (opts.compact) {
    for (const n of top) console.log(`${n.id} | ${n.summary}`)
  } else {
    for (const n of top) printNode(dir, n)
  }
  console.log(`(${top.length}/${matches.length} nodes)`)
}

async function get(dir, opts) {
  const manifest = await loadManifest(dir)
  if (!manifest) { fail('FAIL: atlas/ not initialized. Run: atlas init'); return }
  const id = opts._id
  if (!isValidId(id)) { fail(`FAIL: invalid id "${id}" (expected e.g. BUG-001)`); return }
  const idMap = await loadIdMap(dir)
  let n = null
  let corrupt = []
  if (idMap) {
    const sh = idMap[id]
    if (sh !== undefined) {
      const s = await loadShard(dir, sh)
      if (s.corrupt) corrupt = [s.corrupt]
      else n = s.nodes.find((x) => x.id === id)
    }
  } else {
    const r = await allNodes(dir, manifest)
    corrupt = r.corrupt
    n = r.nodes.find((x) => x.id === id)
  }
  if (corrupt.length) console.error(`WARN: skipping corrupt shard file(s): ${corrupt.join(', ')}. Run: atlas check`)
  if (!n) { fail(`FAIL: node ${id} not found`); return }
  console.log(`id:      ${n.id}`)
  console.log(`type:    ${n.type}`)
  console.log(`status:  ${n.status}`)
  console.log(`date:    ${n.date}${n.time ? ' ' + n.time : ''}`)
  console.log(`tags:    ${(n.tags || []).join(', ')}`)
  console.log(`summary: ${n.summary}`)
  console.log(`conn:    ${(n.conn || []).map((c) => `${c.id}:${c.type}`).join(', ')}`)
  if (n.loc) console.log(`loc:     ${n.loc}`)
  if (n.commit) console.log(`commit:  ${n.commit}`)
  const f = join(dir, 'nodes', `${n.id}.md`)
  if (existsSync(f)) {
    console.log(`\n--- nodes/${n.id}.md ---`)
    console.log((await readFile(f, 'utf8')).trim())
  }
}

async function recent(dir, opts) {
  const manifest = await loadManifest(dir)
  if (!manifest) { fail('FAIL: atlas/ not initialized. Run: atlas init'); return }
  const limit = Math.max(1, clampLimit(opts.limit, 10, 50))
  const { nodes, corrupt } = await allNodes(dir, manifest)
  if (corrupt.length) console.error(`WARN: skipping corrupt shard file(s): ${corrupt.join(', ')}. Run: atlas check`)
  const stamp = (n) => `${n.date || ''} ${n.time || ''}`
  const newest = nodes.filter((n) => n.status !== 'archived').sort((a, b) => stamp(b).localeCompare(stamp(a))).slice(0, limit)
  if (!newest.length) { console.log('(no nodes)'); return }
  for (const n of newest) printNode(dir, n)
  console.log(`(${newest.length}/${manifest.node_count} nodes)`)
}

async function stat(dir) {  const manifest = await loadManifest(dir)
  if (!manifest) { fail('FAIL: atlas/ not initialized. Run: atlas init'); return }
  const { nodes, corrupt } = await allNodes(dir, manifest)
  if (corrupt.length) console.error(`WARN: ${corrupt.length} corrupt shard(s) skipped. Run: atlas check`)
  const byType = {}
  const byStatus = {}
  for (const n of nodes) {
    byType[n.type] = (byType[n.type] || 0) + 1
    byStatus[n.status] = (byStatus[n.status] || 0) + 1
  }
  const t = Object.entries(byType).map(([k, v]) => `${k}=${v}`).join(' ')
  const s = Object.entries(byStatus).map(([k, v]) => `${k}=${v}`).join(' ')
  console.log(`total=${nodes.length} shards=${(manifest.active_shard ?? 0) + 1} ${t} | ${s}`)
}

async function rebuild(dir) {
  const manifest = await loadManifest(dir)
  if (!manifest) { fail('FAIL: atlas/ not initialized. Run: atlas init'); return }
  await withLock(dir, async () => {
    const man = await loadManifest(dir)
    const { nodes, corrupt } = await allNodes(dir, man)
    if (corrupt.length) { fail(`FAIL: cannot rebuild with corrupt shard(s): ${corrupt.join(', ')}`); return }
    const idMap = await buildIdMap(dir, man)
    await saveIdMap(dir, idMap)
    const tags = {}
    for (const n of nodes) for (const t of n.tags || []) (tags[t] ??= []).push({ id: n.id, shard: idMap[n.id] })
    await saveTags(dir, tags)
    const wordsIndex = await rebuildWordsIndex(dir, man, idMap)
    man.node_count = nodes.length
    await saveManifest(dir, man)
    console.log(`rebuilt id_map.json (${Object.keys(idMap).length} ids) + tags_index.json (${Object.keys(tags).length} tags) + words_index.json (${Object.keys(wordsIndex).length} words)`)
  })
}

// ponytail: regex AST-lite — no parser, matches common declaration shapes.
// The index is a lookup hint, not a guarantee; false positives are tolerated.
const JS_SYMBOL_RE = [
  /^[ \t]*(?:export\s+)?function\s+([A-Za-z_$][\w$]*)/,
  /^[ \t]*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/,
  /^[ \t]*class\s+([A-Za-z_$][\w$]*)/,
  /^[ \t]*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\([^)]*\)\s*=>/,
]
const GO_SYMBOL_RE = [
  /^[ \t]*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
]
const PY_SYMBOL_RE = [
  /^[ \t]*def\s+([A-Za-z_]\w*)/,
  /^[ \t]*class\s+([A-Za-z_]\w*)/,
]
const SYMBOL_EXT = {}
for (const e of ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs']) SYMBOL_EXT[e] = JS_SYMBOL_RE
SYMBOL_EXT.go = GO_SYMBOL_RE
SYMBOL_EXT.py = PY_SYMBOL_RE
const SYMBOL_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.cache', '.bun', '.venv', 'venv', '.yarn'])

// M9: index repo symbols (function/class/const names) into symbol_index.json.
// Idempotent — re-running just rewrites the file. Uses --depth/--target.
async function scanSymbols(dir, opts) {
  const manifest = await loadManifest(dir)
  if (!manifest) { fail('FAIL: atlas/ not initialized. Run: atlas init'); return }
  const root = resolve(dirname(dir))
  const rootReal = existsSync(root) ? realpathSync(root) : root
  const depth = Math.max(1, parseInt(opts.depth, 10) || 1)
  const targetArg = opts.target ? resolve(root, opts.target) : root
  const targetReal = existsSync(targetArg) ? realpathSync(targetArg) : targetArg
  if (targetReal !== rootReal && !targetReal.startsWith(rootReal + sep)) { fail(`FAIL: --target outside project: ${opts.target}`); return }

  const index = {}
  let fileCount = 0
  async function walk(p, d) {
    if (d > depth) return
    let entries
    try { entries = await readdir(p, { withFileTypes: true }) } catch { return }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const e of entries) {
      const rel = relative(root, join(p, e.name))
      if (rel === 'atlas') continue
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) {
        if (SYMBOL_SKIP_DIRS.has(e.name)) continue
        if (d < depth) await walk(join(p, e.name), d + 1)
        continue
      }
      const ext = e.name.split('.').pop().toLowerCase()
      const res = SYMBOL_EXT[ext]
      if (!res) continue
      const fp = join(p, e.name)
      try {
        const st = await statFile(fp)
        if (st.size > 1 * 1024 * 1024) continue
        const lines = (await readFile(fp, 'utf8')).split('\n')
        fileCount++
        for (let i = 0; i < lines.length; i++) {
          for (const r of res) {
            const m = r.exec(lines[i])
            if (m) {
              const name = m[1]
              const key = `${rel}:${i + 1}`
              if (!index[name]) index[name] = new Set()
              index[name].add(key)
            }
          }
        }
      } catch { /* unreadable, skip */ }
    }
  }
  await walk(targetArg, 1)

  const out = {}
  for (const [sym, set] of Object.entries(index)) out[sym] = [...set].sort()
  await writeFile(join(dir, 'symbol_index.json'), JSON.stringify(out, null, 2) + '\n')
  console.log(`symbols indexed: ${Object.keys(out).length} symbols in ${fileCount} files`)
}

// Walk the repo by code (not by AI guesswork) and record structure as nodes.
// Directories -> feature, files -> task. Skips vcs/deps/build dirs + atlas/.
// Idempotent: already-recorded paths are skipped, so re-running just fills gaps.
async function scan(dir, opts) {
  const manifest = await loadManifest(dir)
  if (!manifest) { fail('FAIL: atlas/ not initialized. Run: atlas init'); return }
  if (opts.symbols) { await scanSymbols(dir, opts); return }
  const root = resolve(dirname(dir))
  const rootReal = existsSync(root) ? realpathSync(root) : root
  const depth = Math.max(1, parseInt(opts.depth, 10) || 1)
  const targetArg = opts.target ? resolve(root, opts.target) : root
  const targetReal = existsSync(targetArg) ? realpathSync(targetArg) : targetArg
  if (targetReal !== rootReal && !targetReal.startsWith(rootReal + sep)) { fail(`FAIL: --target outside project: ${opts.target}`); return }

  const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.cache', '.bun', '.venv', 'venv', '.yarn'])
  const SKIP_FILES = new Set(['package-lock.json', 'yarn.lock', 'bun.lockb', '.DS_Store'])
  // Secrets / env never become graph nodes.
  const SKIP_NAMES_RE = /(^\.env|[-_.]env[-_.]|token|secret|\.pem$|\.key$|credentials|telemetry-|\.env\.)/
  const hits = []

  async function walk(p, d) {
    if (d > depth) return
    let entries
    try { entries = await readdir(p, { withFileTypes: true }) } catch { return }
    entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))
    for (const e of entries) {
      const rel = relative(root, join(p, e.name))
      if (rel === 'atlas') continue
      if (e.isSymbolicLink()) continue
      if (SKIP_NAMES_RE.test(e.name)) continue
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        hits.push({ rel, type: 'feature', status: 'active', tags: ['scan'] })
        if (d < depth) await walk(join(p, e.name), d + 1)
      } else if (!SKIP_FILES.has(e.name)) {
        const isMd = e.name.endsWith('.md')
        // Docs already carry a title: read the first heading so the node is
        // searchable by meaning (e.g. "PRD"), not just by path. Skip huge
        // files (guarded by stat) so a multi-MB dump can't eat the scan.
        let desc = rel
        if (isMd) {
          try {
            const st = await statFile(join(p, e.name))
            if (st.size > 1 * 1024 * 1024) { desc = `${rel} — (large file, unread)` }
            else {
              const head = (await readFile(join(p, e.name), 'utf8')).split('\n').find((l) => /^#\s/.test(l))
              if (head) desc = `${rel} — ${head.replace(/^#\s*/, '').trim()}`
            }
          } catch { /* unreadable, keep path */ }
        }
        hits.push({ rel, type: isMd ? 'feature' : 'task', status: 'active', tags: ['scan'], desc })
      }
    }
  }
  await walk(targetArg, 1)

  if (!hits.length) { console.log('scan: nothing to map'); return }

  // Reconcile: match by bare path across ALL nodes so a file already mapped
  // by ingest (tag #ingest) isn't re-created as a duplicate scan node. Only
  // #scan nodes get their summary updated, so ingest summaries survive.
  const { nodes } = await allNodes(dir, manifest)
  const byPath = new Map()
  for (const n of nodes) {
    if (!n.summary) continue
    const key = n.summary.split(' — ')[0]
    if (!byPath.has(key)) byPath.set(key, n)
  }
  const fresh = hits.filter((h) => !byPath.has(h.rel))
  const dirty = hits.filter((h) => {
    const old = byPath.get(h.rel)
    return old && (old.tags || []).includes('scan') && old.summary !== (h.desc || h.rel).slice(0, LIMITS.MAX_SUMMARY_CHARS)
  })
  if (!fresh.length && !dirty.length) { console.log(`scan: up to date (${byPath.size} paths already mapped)`); return }

  // Anchor: prefer an existing scan node so the map tree stays coherent; else
  // any existing node. If the graph is empty the first fresh node is the seed
  // (only edge-less node), rest connect to it.
  const anchor = nodes.find((n) => (n.tags || []).includes('scan'))?.id ?? nodes[0]?.id ?? null

  await withLock(dir, async () => {
    const man = await loadManifest(dir)
    const idMap = await loadIdMap(dir)
    const ids = idMap ? Object.keys(idMap) : null
    // Update summaries of existing nodes whose heading changed.
    for (const h of dirty) {
      const old = byPath.get(h.rel)
      if (!old || !idMap || idMap[old.id] === undefined) continue
      const shardNum = idMap[old.id]
      const s = await loadShard(dir, shardNum)
      const idx = s.nodes.findIndex((x) => x.id === old.id)
      if (idx === -1) continue
      s.nodes[idx] = { ...s.nodes[idx], summary: (h.desc || h.rel).slice(0, LIMITS.MAX_SUMMARY_CHARS) }
      await writeFile(join(dir, `index.${shardNum}.json`), JSON.stringify(s, null, 2) + '\n')
      console.log(`updated ${old.id} summary: ${(h.desc || h.rel).slice(0, LIMITS.MAX_SUMMARY_CHARS)}`)
    }
    let firstId = null
    for (let i = 0; i < fresh.length; i++) {
      const h = fresh[i]
      const prefix = PREFIX[h.type]
      const id = nextId(man, prefix, ids)
      if (ids) ids.push(id)
      if (firstId === null) firstId = id
      const conn = anchor
        ? [{ id: anchor, type: 'relates' }]
        : i === 0 ? [] : [{ id: firstId, type: 'relates' }]
      const node = { id, type: h.type, status: h.status, date: today(), time: nowTime(), tags: h.tags, summary: (h.desc || h.rel).slice(0, LIMITS.MAX_SUMMARY_CHARS), conn }
      const shardNum = man.active_shard
      const shard = await loadShard(dir, shardNum)
      shard.nodes.push(node)
      await writeFile(join(dir, `index.${shardNum}.json`), JSON.stringify(shard, null, 2) + '\n')
      man.node_count++
      if (shard.nodes.length >= LIMITS.MAX_NODES_PER_SHARD) {
        man.active_shard++
        await writeFile(join(dir, `index.${man.active_shard}.json`), JSON.stringify({ shard: man.active_shard, nodes: [] }, null, 2) + '\n')
      }
      if (idMap) { idMap[id] = shardNum; await saveIdMap(dir, idMap) }
      const tagsIndex = await loadTags(dir)
      for (const t of h.tags) (tagsIndex[t] ??= []).push({ id, shard: shardNum })
      await saveTags(dir, tagsIndex)
      console.log(`scanned ${id} [${h.type}] ${h.rel}`)
    }
    await saveManifest(dir, man)
  })
}

// Read AGENTS.md / CLAUDE.md (and any markdown doc) and turn their headings
// and structured lines into knowledge nodes. Idempotent by summary, so
// re-running after editing the docs fills gaps without duplicating.
async function ingest(dir, opts) {
  const manifest = await loadManifest(dir)
  if (!manifest) { fail('FAIL: atlas/ not initialized. Run: atlas init'); return }
  const root = resolve(dirname(dir))
  // Root *.md (AGENTS.md, CLAUDE.md, README.md, ...) + docs/**/*.md, recursive.
  const files = new Set()
  try {
    for (const e of await readdir(root, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.md')) files.add(join(root, e.name))
    }
  } catch { /* unreadable root */ }
  const docsDir = join(root, 'docs')
  async function walkDocs(p) {
    let entries
    try { entries = await readdir(p, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const f = join(p, e.name)
      if (e.isDirectory()) await walkDocs(f)
      else if (e.name.endsWith('.md')) files.add(f)
    }
  }
  if (existsSync(docsDir)) await walkDocs(docsDir)
  if (!files.size) { console.log('ingest: no AGENTS.md/CLAUDE.md/docs found'); return }

  // Gather candidate knowledge lines: headings + structured rule lines.
  const hits = [] // { rel, type, summary, tags }
  const envRe = /[A-Z][A-Z0-9_]{2,}/
  const banRe = /\b(dilarang|jangan|never|must not|do not|forbidden|DILARANG|JANGAN)\b/i
  for (const f of files) {
    const rel = relative(root, f)
    const text = await readFile(f, 'utf8')
    const lines = text.split('\n')
    let inCode = false
    for (const line of lines) {
      if (/^\s*```/.test(line)) { inCode = !inCode; continue }
      if (inCode) continue
      const t = line.trim()
      if (!t) continue
      if (/^#{1,3}\s/.test(t)) {
        hits.push({ rel, type: 'feature', tags: ['ingest'], summary: `${rel} — ${t.replace(/^#{1,3}\s*/, '')}` })
      } else if (/^[-*]\s+/.test(t) && (envRe.test(t) || banRe.test(t))) {
        const isBan = banRe.test(t)
        hits.push({ rel, type: isBan ? 'negative' : 'decision', tags: ['ingest'], summary: `${rel}: ${t.replace(/^[-*]\s+/, '')}` })
      }
    }
  }

  if (!hits.length) { console.log('ingest: nothing to extract'); return }

  // Dedup by summary; reuse existing nodes (idempotent).
  await withLock(dir, async () => {
    const man = await loadManifest(dir)
    const idMap = await loadIdMap(dir)
    const ids = idMap ? Object.keys(idMap) : null
    const { nodes } = await allNodes(dir, man)
    const seen = new Set(nodes.map((n) => n.summary))
    const fresh = hits.filter((h) => !seen.has(h.summary))
    if (!fresh.length) { console.log(`ingest: up to date (${seen.size} knowledge nodes already mapped)`); return }
    // Anchor to an existing node (or the first fresh node becomes the seed).
    const anchor = nodes.find((n) => (n.tags || []).includes('ingest'))?.id ?? nodes[0]?.id ?? null
    let firstId = null
    for (let i = 0; i < fresh.length; i++) {
      const h = fresh[i]
      const prefix = PREFIX[h.type]
      const id = nextId(man, prefix, ids)
      if (ids) ids.push(id)
      if (firstId === null) firstId = id
      const conn = anchor
        ? [{ id: anchor, type: 'relates' }]
        : i === 0 ? [] : [{ id: firstId, type: 'relates' }]
      const node = { id, type: h.type, status: 'active', date: today(), time: nowTime(), tags: h.tags, summary: h.summary.slice(0, LIMITS.MAX_SUMMARY_CHARS), conn }
      const shardNum = man.active_shard
      const shard = await loadShard(dir, shardNum)
      shard.nodes.push(node)
      await writeFile(join(dir, `index.${shardNum}.json`), JSON.stringify(shard, null, 2) + '\n')
      man.node_count++
      if (shard.nodes.length >= LIMITS.MAX_NODES_PER_SHARD) {
        man.active_shard++
        await writeFile(join(dir, `index.${man.active_shard}.json`), JSON.stringify({ shard: man.active_shard, nodes: [] }, null, 2) + '\n')
      }
      if (idMap) { idMap[id] = shardNum; await saveIdMap(dir, idMap) }
      const tagsIndex = await loadTags(dir)
      for (const t of h.tags) (tagsIndex[t] ??= []).push({ id, shard: shardNum })
      await saveTags(dir, tagsIndex)
      console.log(`ingested ${id} [${h.type}] ${h.summary}`)
    }
    await saveManifest(dir, man)
  })
}

// Parse --filter "type=task&status=done&tags=auto" into an AND predicate.
// Supported keys: type, status, id, prefix, tags (node must have ALL tags).
function parseFilter(raw) {
  if (!raw) return null
  const out = {}
  for (const part of String(raw).split('&')) {
    const sep = part.indexOf('=')
    if (sep === -1) continue
    const k = part.slice(0, sep).trim()
    const v = part.slice(sep + 1).trim()
    if (!k || !v) continue
    if (k === 'tags') out.tags = v.split(',').map((t) => t.trim()).filter(Boolean)
    else out[k] = v
  }
  return Object.keys(out).length ? out : null
}

// ponytail: linear scan over all shard nodes for filter matching — fine for ≤10k nodes.
function matchFilter(node, f) {
  if (!f) return true
  if (f.type && node.type !== f.type) return false
  if (f.status && node.status !== f.status) return false
  if (f.id && node.id !== f.id) return false
  if (f.prefix && !node.id.startsWith(f.prefix)) return false
  if (f.tags) {
    const have = new Set(node.tags || [])
    if (!f.tags.every((t) => have.has(t))) return false
  }
  return true
}

// Find the shard holding a node; prefer id_map (but verify), else scan all shards.
async function locateShard(dir, man, id, idMap) {
  const cand = idMap?.[id]
  if (cand !== undefined) {
    const s = await loadShard(dir, cand)
    if (!s.corrupt && s.nodes.some((x) => x.id === id)) return cand
  }
  for (let n = 0; n <= man.active_shard; n++) {
    const s = await loadShard(dir, n)
    if (s.corrupt) continue
    if (s.nodes.some((x) => x.id === id)) return n
  }
  return null
}

async function update(dir, opts) {
  const manifest = await loadManifest(dir)
  if (!manifest) { fail('FAIL: atlas/ not initialized. Run: atlas init'); return }
  const filter = parseFilter(opts.filter)
  const id = opts._id
  if (!(filter || id)) { fail('FAIL: need --filter or an id (e.g. atlas update REQ-001 --status active)'); return }
  if (id && !isValidId(id)) { fail(`FAIL: invalid id "${id}" (expected e.g. BUS-001)`); return }
  if (opts.status && !STATUSES.includes(opts.status)) { fail(`FAIL: invalid --status "${opts.status}". Valid: ${STATUSES.join(', ')}`); return }
  if (!opts.status && !opts.summary && !opts.tags && !opts.dryRun) { fail('FAIL: nothing to update (--status/--summary/--tags required)'); return }
  if (opts.summary && opts.summary.length > LIMITS.MAX_SUMMARY_CHARS) { fail(`FAIL: --summary ${opts.summary.length} chars > limit ${LIMITS.MAX_SUMMARY_CHARS}`); return }
  const newTags = opts.tags ? [...new Set(opts.tags.split(',').map((t) => t.trim()).filter(Boolean))] : null

  await withLock(dir, async () => {
    const man = await loadManifest(dir)
    const idMap = await loadIdMap(dir)
    const { nodes: all } = await allNodes(dir, man)
    const targets = filter
      ? all.filter((n) => matchFilter(n, filter)).map((n) => ({ node: n, shardNum: null }))
      : all.filter((n) => n.id === id).map((n) => ({ node: n, shardNum: null }))
    if (opts.dryRun) {
      console.log(`dry-run: ${targets.length} node(s) match`)
      for (const t of targets.slice(0, 5)) console.log(`  ${t.node.id}`)
      return
    }
    if (!targets.length) {
      if (filter) { console.log('no nodes match filter'); return }
      fail(`FAIL: node ${id} not found`); return
    }
    for (const t of targets) t.shardNum = await locateShard(dir, man, t.node.id, idMap)
    const wIdx = await loadWordsIndex(dir)
    const wordsActive = !!(wIdx && Object.keys(wIdx).length)

    for (const t of targets) {
      if (opts.status) t.node.status = opts.status
      if (opts.summary) t.node.summary = opts.summary
      if (newTags) {
        const removed = (t.node.tags || []).filter((x) => !newTags.includes(x))
        const added = newTags.filter((x) => !(t.node.tags || []).includes(x))
        t.node.tags = newTags
        t._removed = removed
        t._added = added
      }
      if (wordsActive && (opts.summary || newTags)) {
        removeNodeFromWords(wIdx, t.node.id)
        indexNodeWords(wIdx, t.node, t.shardNum)
      }
    }

    const byShard = new Map()
    for (const t of targets) {
      if (t.shardNum === null) continue
      const list = byShard.get(t.shardNum) || []
      list.push(t)
      byShard.set(t.shardNum, list)
    }
    for (const [shardNum, list] of byShard) {
      const s = await loadShard(dir, shardNum)
      if (s.corrupt) continue
      for (const t of list) {
        const idx = s.nodes.findIndex((x) => x.id === t.node.id)
        if (idx !== -1) s.nodes[idx] = t.node
      }
      await writeFile(join(dir, `index.${shardNum}.json`), JSON.stringify(s, null, 2) + '\n')
    }

    if (newTags) {
      const tagsIndex = await loadTags(dir)
      for (const t of targets) {
        for (const tag of t._removed || []) {
          tagsIndex[tag] = (tagsIndex[tag] || []).filter((e) => (typeof e === 'string' ? e : e.id) !== t.node.id)
          if (!tagsIndex[tag].length) delete tagsIndex[tag]
        }
        for (const tag of t._added || []) {
          ;(tagsIndex[tag] ??= []).push({ id: t.node.id, shard: t.shardNum })
        }
      }
      await saveTags(dir, tagsIndex)
    }

    if (wordsActive && (opts.summary || newTags)) await saveWordsIndex(dir, wIdx)

    for (const t of targets) console.log(`updated ${t.node.id} (status=${opts.status || '-'}${newTags ? `, tags=${newTags.join(',')}` : ''})`)
  })
}

// Remove a node: drop it from its shard, id_map, tags_index, and nodes/*.md.
// Refuses when other nodes still reference it unless --force.
async function deleteNode(dir, opts) {
  const manifest = await loadManifest(dir)
  if (!manifest) { fail('FAIL: atlas/ not initialized. Run: atlas init'); return }
  const filter = parseFilter(opts.filter)
  const id = opts._id
  if (!(filter || id)) { fail('FAIL: need --filter or an id (e.g. atlas delete TASK-001 --force)'); return }
  if (id && !isValidId(id)) { fail(`FAIL: invalid id "${id}" (expected e.g. BUG-001)`); return }
  await withLock(dir, async () => {
    const man = await loadManifest(dir)
    const idMap = await loadIdMap(dir)
    const wIdx = await loadWordsIndex(dir)
    const wordsActive = !!(wIdx && Object.keys(wIdx).length)
    const { nodes: all } = await allNodes(dir, man)
    const targets = filter
      ? all.filter((n) => matchFilter(n, filter)).map((n) => n.id)
      : all.filter((n) => n.id === id).map((n) => n.id)
    if (opts.dryRun) {
      console.log(`dry-run: ${targets.length} node(s) match`)
      for (const t of targets.slice(0, 5)) console.log(`  ${t}`)
      return
    }
    if (!targets.length) {
      if (filter) { console.log('no nodes match filter'); return }
      fail(`FAIL: node ${id} not found`); return
    }
    const targetSet = new Set(targets)
    const refs = all.filter((n) => !targetSet.has(n.id) && (n.conn || []).some((c) => targetSet.has(c.id)))
    if (refs.length && !opts.force) {
      fail(`FAIL: ${targets.join(', ')} referenced by ${refs.map((r) => r.id).join(', ')}. Use --force to delete anyway.`)
      return
    }
    // With --force, strip the deleted ids from other nodes' edges so the
    // graph stays consistent (no dangling refs that trip `check`).
    if (refs.length && opts.force) {
      for (let n = 0; n <= man.active_shard; n++) {
        const s = await loadShard(dir, n)
        if (s.corrupt) continue
        let dirty = false
        for (const x of s.nodes) {
          if (targetSet.has(x.id)) continue
          const before = (x.conn || []).length
          x.conn = (x.conn || []).filter((c) => !targetSet.has(c.id))
          if (x.conn.length !== before) dirty = true
        }
        if (dirty) await writeFile(join(dir, `index.${n}.json`), JSON.stringify(s, null, 2) + '\n')
      }
    }
    // ponytail: warn-only. delete --force intentionally orphans any node whose
    // only conn(s) pointed at the deleted node(s). Not a bug — user asked for
    // it. Just flag so they can re-link manually (check will fail until then).
    const orphaned = all.filter((n) => !targetSet.has(n.id) && (n.conn || []).length > 0 && (n.conn || []).every((c) => targetSet.has(c.id)))
    if (orphaned.length) {
      console.log(`WARN: delete --force left ${orphaned.length} orphan node(s) (0 conn, not seed): ${orphaned.map((n) => n.id).join(', ')}. Re-link or archive manually; atlas check will fail.`)
    }
    // Remove from shards.
    for (let n = 0; n <= man.active_shard; n++) {
      const s = await loadShard(dir, n)
      if (s.corrupt) continue
      const before = s.nodes.length
      s.nodes = s.nodes.filter((x) => !targetSet.has(x.id))
      if (s.nodes.length !== before) await writeFile(join(dir, `index.${n}.json`), JSON.stringify(s, null, 2) + '\n')
    }
    // Remove from id_map.
    if (idMap) {
      for (const t of targets) delete idMap[t]
      await saveIdMap(dir, idMap)
    }
    // Remove from tags_index.
    const tagsIndex = await loadTags(dir)
    for (const t of Object.keys(tagsIndex)) {
      tagsIndex[t] = tagsIndex[t].filter((e) => !targetSet.has(typeof e === 'string' ? e : e.id))
      if (!tagsIndex[t].length) delete tagsIndex[t]
    }
    await saveTags(dir, tagsIndex)
    // Remove from words_index (only when active/rebuilt).
    if (wordsActive) {
      for (const t of targets) removeNodeFromWords(wIdx, t)
      await saveWordsIndex(dir, wIdx)
    }
    // Remove detail files.
    for (const t of targets) await rm(join(dir, 'nodes', `${t}.md`), { force: true })
    // Fix node_count.
    man.node_count = Math.max(0, man.node_count - targets.length)
    await saveManifest(dir, man)
    for (const t of targets) console.log(`deleted ${t}`)
  })
}

// M4: prune noise. Archive (status -> archived), never delete. Only touches
// type=task + status=done + leaf (nothing references it) nodes that are either
// old (>= --days, default 90) or pure #auto noise. Never archives the seed node.
// ponytail: linear scan, fine for <=10k nodes. --force bypasses seed guard.
async function prune(dir, opts) {
  const manifest = await loadManifest(dir)
  if (!manifest) { fail('FAIL: atlas/ not initialized. Run: atlas init'); return }
  const days = Number.isFinite(parseInt(opts.days, 10)) ? parseInt(opts.days, 10) : 90
  await withLock(dir, async () => {
    const man = await loadManifest(dir)
    const { nodes: all, corrupt } = await allNodes(dir, man)
    if (corrupt.length) console.error(`WARN: skipping corrupt shard file(s): ${corrupt.join(', ')}. Run: atlas check`)
    const referencedBy = new Set()
    for (const n of all) for (const c of n.conn || []) referencedBy.add(c.id)
    const edgeLessCount = all.filter((n) => !(Array.isArray(n.conn) && n.conn.length > 0)).length
    const daysBetween = (d) => Math.floor((new Date(today() + 'T00:00:00') - new Date(d + 'T00:00:00')) / 86400000)
    const isOld = (n) => daysBetween(n.date) >= days
    const isAutoOnly = (n) => Array.isArray(n.tags) && n.tags.length === 1 && n.tags[0] === 'auto'
    const isLeaf = (n) => !referencedBy.has(n.id)
    const isSeed = (n) => (n.conn || []).length === 0 && edgeLessCount === 1

    const targets = []
    let aCount = 0, bCount = 0
    for (const n of all) {
      if (n.type !== 'task' || n.status !== 'done') continue
      if (!isLeaf(n)) continue
      if (isSeed(n) && !opts.force) continue
      // M4: two independent criteria — (a) old task-done-leaf, (b) auto-only
      // done-leaf with NO age requirement. Either one archives.
      const critA = isOld(n)
      const critB = isAutoOnly(n)
      if (!critA && !critB) continue
      if (critA) aCount++
      if (critB) bCount++
      targets.push(n)
    }

    if (opts.dryRun) {
      console.log(`dry-run: would archive ${targets.length} node(s)`)
      for (const t of targets) console.log(`  ${t.id} [${t.type}/${t.status}] ${t.summary}`)
      console.log(`prune plan: ${targets.length} nodes (a: ${aCount} task-done-old, b: ${bCount} auto-noise). dry-run: no changes written`)
      return
    }

    if (!targets.length) { console.log('prune: nothing to archive'); return }

    const idMap = await loadIdMap(dir)
    const byShard = new Map()
    for (const t of targets) {
      const sh = await locateShard(dir, man, t.id, idMap)
      if (sh === null) continue
      const list = byShard.get(sh) || []
      list.push(t.id)
      byShard.set(sh, list)
    }
    for (const [shardNum, ids] of byShard) {
      const s = await loadShard(dir, shardNum)
      if (s.corrupt) continue
      for (const x of s.nodes) if (ids.includes(x.id)) x.status = 'archived'
      await writeFile(join(dir, `index.${shardNum}.json`), JSON.stringify(s, null, 2) + '\n')
    }
    // ponytail: keep words_index in sync so query doesn't surface archived nodes
    const wordsIndex = await loadWordsIndex(dir)
    if (wordsIndex && Object.keys(wordsIndex).length > 0) {
      for (const t of targets) removeNodeFromWords(wordsIndex, t.id)
      await saveWordsIndex(dir, wordsIndex)
    }
    man.pruned_count = (man.pruned_count || 0) + targets.length
    man.last_prune_at = today()
    await saveManifest(dir, man)
    console.log(`pruned ${targets.length} nodes (a: ${aCount} task-done-old, b: ${bCount} auto-noise)`)
  })
}

// Edit a node's detail file in $EDITOR. Creates nodes/{ID}.md if absent
// (seeded with the node summary), opens the editor, then enforces the line
// limit. ponytail: spawnSync blocking is fine for a CLI editor — no async.
async function edit(dir, opts) {
  const manifest = await loadManifest(dir)
  if (!manifest) { fail('FAIL: atlas/ not initialized. Run: atlas init'); return }
  const id = opts._id
  if (!isValidId(id)) { fail(`FAIL: invalid id "${id}" (expected e.g. BUG-001)`); return }
  const { nodes } = await allNodes(dir, manifest)
  const node = nodes.find((x) => x.id === id)
  if (!node) { fail(`FAIL: node ${id} not found`); return }
  const filePath = join(dir, 'nodes', `${id}.md`)
  await mkdir(join(dir, 'nodes'), { recursive: true })
  if (!existsSync(filePath)) {
    await writeFile(filePath, `# ${id}\n\n${node.summary}\n`)
  }
  const editor = process.env.EDITOR || (existsSync('/usr/bin/vi') ? 'vi' : 'nano')
  const r = spawnSync(editor, [filePath], { stdio: 'inherit' })
  if (r.status !== 0) { fail(`FAIL: editor exited with status ${r.status}`); return }
  const text = await readFile(filePath, 'utf8')
  const lines = text.trimEnd().split('\n').length
  if (lines > LIMITS.MAX_MD_LINES) { fail(`FAIL: node file ${lines} lines > limit ${LIMITS.MAX_MD_LINES}`); return }
  console.log(`edited ${id} (${lines} lines)`)
}

// M10: cluster active (non-archived) nodes by topic. Topic = best tag
// (node.tags[0]) else first summary word stripped of stopwords. Read-only.
// ponytail: naive clustering — one key per node, no merge/similarity. Fine for
// <1k nodes; upgrade to a real topic model if the grouping stops being useful.
const STOPWORDS = new Set(['the', 'a', 'an', 'for', 'with', 'auto'])
async function cluster(dir) {
  const manifest = await loadManifest(dir)
  if (!manifest) { fail('FAIL: atlas/ not initialized. Run: atlas init'); return }
  const { nodes, corrupt } = await allNodes(dir, manifest)
  if (corrupt.length) console.error(`WARN: skipping corrupt shard file(s): ${corrupt.join(', ')}. Run: atlas check`)
  const active = nodes.filter((n) => n.status !== 'archived')
  const topics = new Map()
  for (const n of active) {
    let topic
    if (Array.isArray(n.tags) && n.tags.length && n.tags[0]) topic = String(n.tags[0])
    else {
      const first = String(n.summary || '').trim().split(/\s+/)[0].toLowerCase()
      topic = STOPWORDS.has(first) ? 'other' : (first || 'other')
    }
    if (!topics.has(topic)) topics.set(topic, [])
    topics.get(topic).push(n.id)
  }
  if (!topics.size) { console.log('cluster: no active nodes'); return }
  const sorted = [...topics.entries()].sort((a, b) => b[1].length - a[1].length)
  console.log(`cluster: ${active.length} active nodes / ${sorted.length} topic(s)`)
  const w = Math.max(...sorted.map(([t]) => t.length), 10)
  for (const [topic, ids] of sorted) {
    console.log(`  ${String(ids.length).padStart(3)}  ${topic.padEnd(w)} ${ids.slice(0, 5).join(', ')}${ids.length > 5 ? ` +${ids.length - 5}` : ''}`)
  }
}

// Dump the whole graph as one JSON document (backup / portability).
async function exportGraph(dir, opts) {
  const manifest = await loadManifest(dir)
  if (!manifest) { fail('FAIL: atlas/ not initialized. Run: atlas init'); return }
  const { nodes, corrupt } = await allNodes(dir, manifest)
  if (corrupt.length) { fail(`FAIL: cannot export with corrupt shard(s): ${corrupt.join(', ')}. Run: atlas check`); return }
  if (opts.stats) {
    const byType = {}
    const byStatus = {}
    for (const n of nodes) {
      byType[n.type] = (byType[n.type] || 0) + 1
      byStatus[n.status] = (byStatus[n.status] || 0) + 1
    }
    const fmt = (o) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join(' ')
    console.log(`total=${nodes.length} shards=${(manifest.active_shard ?? 0) + 1}`)
    console.log(`by-type:   ${fmt(byType)}`)
    console.log(`by-status: ${fmt(byStatus)}`)
    return
  }
  const out = JSON.stringify({ version: 1, exported: new Date().toISOString(), manifest, nodes }, null, 2) + '\n'
  if (opts.file) {
    await writeFile(opts.file, out)
    console.log(`exported ${nodes.length} nodes to ${opts.file}`)
  } else {
    process.stdout.write(out)
  }
}

// Explicit migration runner: `atlas migrate [dir]`. Reads manifest raw (not
// via loadManifest, which would auto-migrate and hide the from->to), runs
// pending migrations under the lock, prints progress.
async function migrate(dir) {
  const f = join(dir, 'manifest.json')
  if (!existsSync(f)) { fail('FAIL: atlas/manifest.json missing. Run: atlas init'); return }
  const m = tryParseJson(await readFile(f, 'utf8'))
  if (!m || typeof m !== 'object') { fail('FAIL: atlas/manifest.json unparsable'); return }
  if (schemaOf(m) >= SCHEMA_VERSION) { console.log(`schema up to date (${schemaOf(m)})`); return }
  await withLock(dir, async () => {
    const mm = tryParseJson(await readFile(f, 'utf8'))
    if (!mm || typeof mm !== 'object') return
    const r = await applyMigrations(dir, mm)
    console.log(`schema ${r.from} → ${r.to}`)
  })
}

async function check(dir) {
  const manifest = await loadManifest(dir)
  if (!manifest) { fail('FAIL: atlas/manifest.json missing. Run: atlas init'); return }
  const errors = []
  const corrupt = []
  const all = []
  const expectedMap = {}
  for (let n = 0; n <= manifest.active_shard; n++) {
    const f = join(dir, `index.${n}.json`)
    if (!existsSync(f)) { errors.push(`index.${n}.json missing (manifest.active_shard=${manifest.active_shard}). Run: atlas rebuild`); continue }
    const s = await loadShard(dir, n)
    if (s.corrupt) { corrupt.push(f); errors.push(`${f}: unparsable JSON`); continue }
    all.push(...s.nodes)
    for (const node of s.nodes) if (node && node.id) expectedMap[node.id] = n
  }
  const diskFiles = await readdir(dir)
  for (const f of diskFiles) {
    const m = /^index\.(\d+)\.json$/.exec(f)
    if (m && Number(m[1]) > manifest.active_shard) errors.push(`${f}: orphan shard beyond active_shard. Run: atlas rebuild`)
  }
  if (corrupt.length) console.error(`WARN: ${corrupt.length} corrupt shard(s), skipped from node checks`)

  const ids = new Set()
  const edgeLess = all.filter((n) => n && !(Array.isArray(n.conn) && n.conn.length > 0))
  const seedOk = edgeLess.length === 1 || all.length === 1

  for (const n of all) {
    if (!n || typeof n !== 'object' || typeof n.id !== 'string') { errors.push('node must be an object with string id'); continue }
    if (ids.has(n.id)) errors.push(`${n.id}: duplicate node id`)
    ids.add(n.id)
    if (!isValidId(n.id)) errors.push(`${n.id}: invalid id format (expected e.g. REQ-001)`)
    if (!TYPES.includes(n.type)) errors.push(`${n.id}: unknown type "${n.type}"`)
    if (!STATUSES.includes(n.status)) errors.push(`${n.id}: invalid/missing status "${n.status}"`)
    if (!n.date || !/^\d{4}-\d{2}-\d{2}$/.test(n.date)) errors.push(`${n.id}: missing/invalid date "${n.date}"`)
    if (n.time !== undefined && !/^\d{2}:\d{2}:\d{2}$/.test(n.time)) errors.push(`${n.id}: invalid time "${n.time}"`)
    if (!n.summary) errors.push(`${n.id}: missing summary`)
    else if (n.summary.length > LIMITS.MAX_SUMMARY_CHARS) errors.push(`${n.id}: summary ${n.summary.length} chars > ${LIMITS.MAX_SUMMARY_CHARS}`)
    if (!Array.isArray(n.conn) || n.conn.length === 0) {
      if (!seedOk) errors.push(`${n.id}: orphan node (no conn)`)
    }
    const seen = new Set()
    for (const c of n.conn || []) {
      if (!c || typeof c !== 'object' || typeof c.id !== 'string') { errors.push(`${n.id}: conn entry must be object with id`); continue }
      if (c.id === n.id) errors.push(`${n.id}: self-loop conn -> itself`)
      const key = `${c.id}:${c.type}`
      if (seen.has(key)) errors.push(`${n.id}: duplicate conn -> ${key}`)
      seen.add(key)
      if (!ids.has(c.id) && !all.some((x) => x.id === c.id)) errors.push(`${n.id}: conn -> missing node ${c.id}`)
      if (!CONN_TYPES.includes(c.type)) errors.push(`${n.id}: conn type "${c.type}" invalid`)
    }
    if (!Array.isArray(n.tags)) errors.push(`${n.id}: tags must be array`)
  }

  const tagsIndex = await loadTags(dir)
  const tagEntries = (e) => (typeof e === 'string' ? { id: e } : e)
  for (const [tag, list] of Object.entries(tagsIndex)) {
    if (!Array.isArray(list)) { errors.push(`tags_index["${tag}"] must be array`); continue }
    for (const e of list) {
      const { id } = tagEntries(e)
      const node = all.find((x) => x && x.id === id)
      if (!node) errors.push(`tags_index["${tag}"] -> missing node ${id}`)
      else if (!(Array.isArray(node.tags) && node.tags.includes(tag))) errors.push(`node ${id} missing tag "${tag}" back-referenced in tags_index`)
    }
  }
  for (const n of all) {
    for (const t of n.tags || []) {
      if (!Array.isArray(tagsIndex[t]) || !tagsIndex[t].some((e) => tagEntries(e).id === n.id)) errors.push(`${n.id}: tag "${t}" missing from tags_index`)
    }
  }

  const idMap = await loadIdMap(dir)
  if (idMap === null) errors.push('id_map.json missing. Run: atlas rebuild')
  else {
    for (const [id, sh] of Object.entries(idMap)) {
      if (expectedMap[id] === undefined) errors.push(`id_map: ${id} -> missing node`)
      else if (expectedMap[id] !== sh) errors.push(`id_map: ${id} -> shard ${sh}, actual ${expectedMap[id]}. Run: atlas rebuild`)
    }
    for (const [id, sh] of Object.entries(expectedMap)) {
      if (idMap[id] === undefined) errors.push(`id_map: missing ${id} (shard ${sh}). Run: atlas rebuild`)
    }
  }

  if (manifest.node_count !== all.length) errors.push(`manifest.node_count=${manifest.node_count}, actual ${all.length}. Run: atlas rebuild`)

  let nodeFiles = []
  try { nodeFiles = await readdir(join(dir, 'nodes')) } catch { /* ENOENT */ }
  for (const f of nodeFiles) {
    if (!f.endsWith('.md')) continue
    const id = f.replace(/\.md$/, '')
    if (!ids.has(id)) errors.push(`node file ${f}: id not in index`)
    const st = await statFile(join(dir, 'nodes', f))
    if (st.size === 0) continue
    const lines = (await readFile(join(dir, 'nodes', f), 'utf8')).trimEnd().split('\n').length
    if (lines > LIMITS.MAX_MD_LINES) errors.push(`${f}: ${lines} lines > ${LIMITS.MAX_MD_LINES}`)
  }

  for (let n = 0; n <= manifest.active_shard; n++) {
    const s = await loadShard(dir, n)
    if (s.nodes.length > LIMITS.MAX_NODES_PER_SHARD) errors.push(`index.${n}.json: ${s.nodes.length} nodes > ${LIMITS.MAX_NODES_PER_SHARD}`)
  }

  if (errors.length) {
    console.error(`FAIL: ${errors.length} issue(s)`)
    for (const e of errors) console.error(`  - ${e}`)
    process.exitCode = 1
  } else {
    console.log(`OK: ${all.length} nodes across ${manifest.active_shard + 1} shard(s), ${Object.keys(tagsIndex).length} tags, ${nodeFiles.filter((f) => f.endsWith('.md')).length} node file(s), schema=${schemaOf(manifest)}`)
  }
}

// M10: verify = check + connector-integrity. Every conn {id,type} must point to
// an existing node id. Reports dangling refs count + example ids; exit 1 if any.
// Read-only.
async function verify(dir) {
  await check(dir)
  const manifest = await loadManifest(dir)
  if (!manifest) { fail('FAIL: atlas/manifest.json missing. Run: atlas init'); return }
  const { nodes, corrupt } = await allNodes(dir, manifest)
  if (corrupt.length) { fail(`FAIL: cannot verify with corrupt shard(s): ${corrupt.join(', ')}. Run: atlas check`); return }
  const ids = new Set(nodes.map((n) => n.id))
  const dangling = []
  for (const n of nodes) {
    for (const c of n.conn || []) {
      if (c && c.id && !ids.has(c.id)) dangling.push({ from: n.id, to: c.id, type: c.type })
    }
  }
  if (dangling.length) {
    const examples = [...new Set(dangling.map((d) => d.to))].slice(0, 5)
    console.error(`FAIL: ${dangling.length} dangling connector(s)`)
    console.error(`  dangling id(s): ${examples.join(', ')}`)
    process.exitCode = 1
  } else {
    console.log(`connector integrity: OK (${nodes.length} nodes, 0 dangling)`)
  }
}

async function main(argv = process.argv) {
  const { cmd, opts, positional } = parseArgs(argv)
  if (cmd === '--version' || cmd === '-v') {
    // Prefer the embedded VERSION (works even from a bare skill copy with no
    // package.json); fall back to package.json if it disagrees.
    try {
      const root = findPkgRoot()
      const pkgV = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
      if (pkgV && pkgV !== VERSION) { console.log(pkgV); return }
    } catch { /* embedded VERSION below */ }
    console.log(VERSION)
    return
  }
  switch (cmd) {
    case 'setup': return setup()
    case 'init': return init(atlasDir(positional[positional.length - 1] ?? '.'))
    case 'ingest': return ingest(atlasDir(positional[positional.length - 1] ?? '.'), opts)
    case 'record': return record(atlasDir(positional[positional.length - 1] ?? '.'), opts)
    case 'feature': {
      const { dirArg, rest } = splitPos(positional)
      return featureCmd(atlasDir(dirArg), { ...opts, _name: rest[0] })
    }
    case 'context': {
      const { dirArg, rest } = splitPos(positional)
      return contextCmd(atlasDir(dirArg), { ...opts, _path: rest[0] })
    }
    case 'query': {
      const { dirArg, rest } = splitPos(positional)
      opts._q = rest.join(' ') || opts.q
      return query(atlasDir(dirArg), opts)
    }
    case 'get': {
      const { dirArg, rest } = splitPos(positional)
      return get(atlasDir(dirArg), { _id: opts.id || rest[0] })
    }
    case 'update': {
      const { dirArg, rest } = splitPos(positional)
      return update(atlasDir(dirArg), { _id: opts.id || rest[0], status: opts.status, summary: opts.summary, tags: opts.tags, filter: opts.filter, dryRun: opts['dry-run'] })
    }
    case 'delete': {
      const { dirArg, rest } = splitPos(positional)
      return deleteNode(atlasDir(dirArg), { _id: opts.id || rest[0], force: opts.force, filter: opts.filter, dryRun: opts['dry-run'] })
    }
    case 'prune': {
      const { dirArg, rest } = splitPos(positional)
      return prune(atlasDir(dirArg), { days: opts.days, dryRun: opts['dry-run'], force: opts.force })
    }
    case 'edit': {
      const { dirArg, rest } = splitPos(positional)
      return edit(atlasDir(dirArg), { _id: opts.id || rest[0] })
    }
    case 'recent': return recent(atlasDir(positional[positional.length - 1] ?? '.'), opts)
    case 'stat': return stat(atlasDir(positional[positional.length - 1] ?? '.'))
    case 'scan': return scan(atlasDir(positional[positional.length - 1] ?? '.'), opts)
    case 'export': return exportGraph(atlasDir(positional[positional.length - 1] ?? '.'), opts)
    case 'cluster': return cluster(atlasDir(positional[positional.length - 1] ?? '.'))
    case 'rebuild': return rebuild(atlasDir(positional[positional.length - 1] ?? '.'))
    case 'migrate': return migrate(atlasDir(positional[positional.length - 1] ?? '.'))
    case 'doctor': return doctor()
    case 'check': return check(atlasDir(positional[positional.length - 1] ?? '.'))
    case 'verify': return verify(atlasDir(positional[positional.length - 1] ?? '.'))
    default:
      console.error(usage())
      process.exitCode = 1
  }
}

// Run only when invoked directly; when imported (MCP server) skip auto-run.
// realpathSync: argv may be a symlink (e.g. ~/.config/opencode/skills/atlas-owner)
// while import.meta.url is always the realpath — compare resolved paths.
const invokedMain = (() => {
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url
  } catch { return false }
})()
if (invokedMain) {
  main().catch((e) => { console.error(e); process.exitCode = 1 })
}

// In-process runner for the MCP server: executes a command, captures output.
export async function runCmd(argv) {
  const logs = []
  const origLog = console.log
  const origErr = console.error
  console.log = (...a) => logs.push(a.join(' '))
  console.error = (...a) => logs.push(a.join(' '))
  const origCode = process.exitCode
  process.exitCode = 0
  try {
    await main(argv)
  } catch (e) {
    logs.push(String(e && e.stack || e))
    process.exitCode = 1
  }
  const code = process.exitCode
  process.exitCode = origCode
  console.log = origLog
  console.error = origErr
  return { code, output: logs.join('\n') }
}
