#!/usr/bin/env node
// atlas — Product Owner graph memory CLI (modular, auto-shard).
//
// Commands:
//   atlas init [dir]                     scaffold atlas/
//   atlas record --id X --type T --status S --tags a,b --summary "..." [--conn "ID:type,..."] [--file path.md] [dir]
//   atlas query "keywords" [--tags a,b] [--limit N] [dir]
//   atlas get ID [dir]
//   atlas recent [--limit N] [dir]       newest nodes
//   atlas stat [dir]                     one-line counts by type/status
//   atlas rebuild [dir]                  rebuild id_map.json + tags_index.json
//   atlas scan [dir] [--target X] [--depth N]   map repo structure as feature/task nodes
//   atlas check [dir]
//
// Structure (modular on purpose):
//   atlas/manifest.json       small meta: active_shard, node_count, updated
//   atlas/index.{n}.json      node shards, auto-split at MAX_NODES_PER_SHARD
//   atlas/id_map.json         id -> shard (O(1) get, dup/conn checks)
//   atlas/tags_index.json     tag -> [{id, shard}] (legacy: plain id strings)
//   atlas/nodes/{ID}.md       optional detail, MAX_MD_LINES enforced
//   atlas/PROTOCOL.md         always-in-context retrieval rules
//
// Token rule: AI must call `atlas query/get`, never read atlas/*.json raw.
import { open, mkdir, readFile, writeFile, readdir, rm, stat as statFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve, sep, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

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

const PROTOCOL = `# Atlas Protocol

Graph memory for Product Owner behavior. Read before work, follow after work.

## Retrieval — Wajib lewat CLI. JANGAN baca atlas/*.json langsung.
node <atlas> query "keywords" [--tags a,b] [--limit 5]
node <atlas> recent [--limit 10]    # node terbaru
node <atlas> get ID
node <atlas> scan [--depth 2]       # map struktur repo (code-walk, idempotent)

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
Uncertain about a flow or insight (business OR technical)? Ask the user
before recording a node. Never guess a fact.
`

const RULES = `# Atlas Rules

- Every fact = one node. No orphan nodes: each node has >= 1 conn edge.
- Modular: nodes live in index.{n}.json shards (auto-split at ${LIMITS.MAX_NODES_PER_SHARD} default; ATLAS_MAX_SHARD overrides). id_map.json maps id -> shard; tags_index.json maps tag -> [{id, shard}].
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

- manifest.json + index.{n}.json (shards) + id_map.json + tags_index.json + nodes/*.md
- Read via CLI (query/recent/get/record), never raw JSON.
- Record every significant requirement, feature, decision, bug, task, gotcha.
`

const usage = () => `Usage:
  atlas init|record|query|get|update|recent|stat|scan|rebuild|check [dir]

Commands:
  init        scaffold atlas/
  record      add node (--id --type --status --tags --summary --conn [--file])
  query       search ("keywords" [--tags a,b] [--limit N])
  get ID      show node
  update ID   change node (--status/--summary/--tags)
  recent      newest nodes (--limit N, default 10)
  stat        one-line counts by type/status
  scan        map repo structure (--target path, --depth N; code-walk, idempotent)
  rebuild     rebuild id_map.json + tags_index.json (fixes drift)
  check       verify integrity + limits`

const fail = (msg) => { console.error(msg); process.exitCode = 1 }

function today() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function tryParseJson(text) {
  try { return JSON.parse(text) } catch { return null }
}

function parseArgs(argv) {
  const args = argv.slice(2)
  const cmd = args[0]
  const opts = {}
  const positional = []
  for (let i = 1; i < args.length; i++) {
    const a = args[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const val = args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[++i] : ''
      opts[key] = val
    } else {
      positional.push(a)
    }
  }
  return { cmd, opts, positional }
}

const atlasDir = (p) => join(resolve(p), 'atlas')

// Resolve a node file path given in any of: cwd-relative, atlas-relative, project-relative.
function resolveNodeFile(dir, p) {
  const cands = [resolve(p), join(dir, p), join(dirname(dir), p)]
  return cands.find((c) => existsSync(c)) ?? null
}

// Last positional that exists on disk is treated as the target directory.
// Otherwise default to "." and treat all positionals as the command payload.
function splitPos(positional) {
  let dirArg = '.'
  const rest = [...positional]
  if (rest.length > 1 && existsSync(resolve(rest[rest.length - 1]))) dirArg = rest.pop()
  return { dirArg, rest }
}

async function loadManifest(dir) {
  const f = join(dir, 'manifest.json')
  if (!existsSync(f)) return null
  const m = tryParseJson(await readFile(f, 'utf8'))
  if (!m || typeof m !== 'object') return null
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
async function withLock(dir, fn) {
  const lock = join(dir, '.lock')
  for (let i = 0; i < 20; i++) {
    try {
      const h = await open(lock, 'wx')
      await h.close()
      try { return await fn() } finally { await rm(lock, { force: true }) }
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
  const manifest = await loadManifest(dir)
  if (!manifest) await saveManifest(dir, { version: 1, updated: today(), active_shard: 0, node_count: 0, seed_id: null })
  if (!existsSync(join(dir, 'index.0.json'))) await writeFile(join(dir, 'index.0.json'), JSON.stringify({ shard: 0, nodes: [] }, null, 2) + '\n')
  if (!existsSync(join(dir, 'tags_index.json'))) await saveTags(dir, {})
  if (!existsSync(join(dir, 'id_map.json'))) await saveIdMap(dir, {})
  for (const [f, c] of [['PROTOCOL.md', PROTOCOL], ['rules.md', RULES], ['README.md', README]]) {
    if (!existsSync(join(dir, f))) await writeFile(join(dir, f), c)
  }
  console.log(`Atlas initialized at ${dir}`)
  await check(dir)
}

function parseConn(raw) {
  if (!raw) return []
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const [id, type] = s.split(':')
    return { id: id.trim(), type: (type || 'relates').trim() }
  })
}

function nextId(ids, prefix) {
  let max = 0
  for (const id of ids) {
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
  if (!summary) { fail('FAIL: --summary required'); return }
  if (summary.length > LIMITS.MAX_SUMMARY_CHARS) { fail(`FAIL: --summary ${summary.length} chars > limit ${LIMITS.MAX_SUMMARY_CHARS}`); return }
  const tags = opts.tags ? opts.tags.split(',').map((t) => t.trim()).filter(Boolean) : []
  const conn = parseConn(opts.conn)
  let filePath = null
  if (opts.file) {
    filePath = resolveNodeFile(dir, opts.file)
    if (!filePath) { fail(`FAIL: --file not found: ${opts.file}`); return }
    // Trust boundary: the detail file must stay inside the project root.
    const root = resolve(dirname(dir)) + sep
    if (!filePath.startsWith(root)) { fail(`FAIL: --file outside project: ${opts.file}`); return }
    const lines = (await readFile(filePath, 'utf8')).split('\n').length
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
      id = nextId(ids ?? (await scanNodes()).map((n) => n.id), prefix)
    } else if ((idMap && idMap[id] !== undefined) || (!idMap && (await scanNodes()).some((n) => n.id === id))) {
      fail(`FAIL: duplicate node id ${id}`); return
    }
    if (!isValidId(id)) { fail(`FAIL: invalid --id "${id}" (expected e.g. BUG-001)`); return }

    const emptyGraph = idMap ? Object.keys(idMap).length === 0 : (await scanNodes()).length === 0
    if (conn.length === 0 && !emptyGraph) { fail('FAIL: --conn required (>= 1 edge). Format: ID:type,ID:type'); return }
    const seen = new Set()
    for (const c of conn) {
      if (c.id === id) { fail(`FAIL: --conn self-loop ${c.id} -> itself`); return }
      if (!CONN_TYPES.includes(c.type)) { fail(`FAIL: --conn type "${c.type}" invalid`); return }
      const exists = idMap ? idMap[c.id] !== undefined : (await scanNodes()).some((n) => n.id === c.id)
      if (!exists) { fail(`FAIL: --conn -> unknown node ${c.id}`); return }
      const key = `${c.id}:${c.type}`
      if (seen.has(key)) { fail(`FAIL: --conn duplicate ${key}`); return }
      seen.add(key)
    }

    const node = { id, type: opts.type, status: opts.status, date: today(), tags, summary, conn }
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
    console.log(`recorded ${id} -> index.${shardNum}.json`)
  })
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

const clampLimit = (raw, def, max) => Math.max(0, Math.min(parseInt(raw, 10) || def, max))

function printNode(dir, n) {
  const hasFile = existsSync(join(dir, 'nodes', `${n.id}.md`)) ? ' +md' : ''
  console.log(`[${n.id}] ${n.type}/${n.status} #${(n.tags || []).join('#')} — ${n.summary}${hasFile}`)
}

async function query(dir, opts) {
  const manifest = await loadManifest(dir)
  if (!manifest) { fail('FAIL: atlas/ not initialized. Run: atlas init'); return }
  const words = opts._q ? opts._q.toLowerCase().split(/\s+/).filter(Boolean) : []
  const tagFilter = opts.tags ? opts.tags.split(',').map((t) => t.trim()).filter(Boolean) : []
  const limit = clampLimit(opts.limit, 5, 20)
  const source = tagFilter.length
    ? await tagCandidates(dir, manifest, tagFilter)
    : await allNodes(dir, manifest)
  if (source.corrupt.length) console.error(`WARN: skipping corrupt shard file(s): ${source.corrupt.join(', ')}. Run: atlas check`)
  let matches = source.nodes.filter((n) => scoreNode(n, words, tagFilter) >= 0)
  if (!words.length && !tagFilter.length) matches = source.nodes
  matches.sort((a, b) => scoreNode(b, words, tagFilter) - scoreNode(a, words, tagFilter))
  const top = matches.slice(0, limit)
  for (const n of top) printNode(dir, n)
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
  console.log(`date:    ${n.date}`)
  console.log(`tags:    ${(n.tags || []).join(', ')}`)
  console.log(`summary: ${n.summary}`)
  console.log(`conn:    ${(n.conn || []).map((c) => `${c.id}:${c.type}`).join(', ')}`)
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
  const newest = []
  for (let n = manifest.active_shard; n >= 0 && newest.length < limit; n--) {
    const s = await loadShard(dir, n)
    if (s.corrupt) { console.error(`WARN: skipping corrupt ${s.corrupt}`); continue }
    for (const node of [...s.nodes].reverse()) {
      if (newest.length >= limit) break
      newest.push(node)
    }
  }
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
    man.node_count = nodes.length
    await saveManifest(dir, man)
    console.log(`rebuilt id_map.json (${Object.keys(idMap).length} ids) + tags_index.json (${Object.keys(tags).length} tags)`)
  })
}

// Walk the repo by code (not by AI guesswork) and record structure as nodes.
// Directories -> feature, files -> task. Skips vcs/deps/build dirs + atlas/.
// Idempotent: already-recorded paths are skipped, so re-running just fills gaps.
async function scan(dir, opts) {
  const manifest = await loadManifest(dir)
  if (!manifest) { fail('FAIL: atlas/ not initialized. Run: atlas init'); return }
  const root = resolve(dirname(dir))
  const depth = Math.max(1, parseInt(opts.depth, 10) || 1)
  const targetArg = opts.target ? resolve(root, opts.target) : root
  if (targetArg !== root && !targetArg.startsWith(root + sep)) { fail(`FAIL: --target outside project: ${opts.target}`); return }

  const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.cache', '.bun', '.venv', 'venv', '.yarn'])
  const SKIP_FILES = new Set(['package-lock.json', 'yarn.lock', 'bun.lockb', '.DS_Store'])
  const hits = []

  async function walk(p, d) {
    if (d > depth) return
    let entries
    try { entries = await readdir(p, { withFileTypes: true }) } catch { return }
    entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1))
    for (const e of entries) {
      const rel = relative(root, join(p, e.name))
      if (rel === 'atlas') continue
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        hits.push({ rel, type: 'feature', status: 'active', tags: ['scan'] })
        if (d < depth) await walk(join(p, e.name), d + 1)
      } else if (!SKIP_FILES.has(e.name)) {
        hits.push({ rel, type: 'task', status: 'active', tags: ['scan'] })
      }
    }
  }
  await walk(targetArg, 1)

  if (!hits.length) { console.log('scan: nothing to map'); return }

  const existing = new Set()
  const { nodes } = await allNodes(dir, manifest)
  for (const n of nodes) if ((n.tags || []).includes('scan')) existing.add(n.summary)
  const fresh = hits.filter((h) => !existing.has(h.rel))
  if (!fresh.length) { console.log(`scan: up to date (${existing.size} paths already mapped)`); return }

  // Anchor: prefer an existing scan node so the map tree stays coherent; else
  // any existing node. If the graph is empty the first fresh node is the seed
  // (only edge-less node), rest connect to it.
  const anchor = nodes.find((n) => (n.tags || []).includes('scan'))?.id ?? nodes[0]?.id ?? null

  await withLock(dir, async () => {
    const man = await loadManifest(dir)
    const idMap = await loadIdMap(dir)
    const ids = idMap ? Object.keys(idMap) : null
    let firstId = null
    for (let i = 0; i < fresh.length; i++) {
      const h = fresh[i]
      const prefix = PREFIX[h.type]
      const id = nextId(ids ?? [], prefix)
      if (ids) ids.push(id)
      if (firstId === null) firstId = id
      const conn = anchor
        ? [{ id: anchor, type: 'relates' }]
        : i === 0 ? [] : [{ id: firstId, type: 'relates' }]
      const node = { id, type: h.type, status: h.status, date: today(), tags: h.tags, summary: h.rel.slice(0, LIMITS.MAX_SUMMARY_CHARS), conn }
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

async function update(dir, opts) {
  const manifest = await loadManifest(dir)
  if (!manifest) { fail('FAIL: atlas/ not initialized. Run: atlas init'); return }
  const id = opts._id
  if (!isValidId(id)) { fail(`FAIL: invalid id "${id}" (expected e.g. BUS-001)`); return }
  if (opts.status && !STATUSES.includes(opts.status)) { fail(`FAIL: invalid --status "${opts.status}". Valid: ${STATUSES.join(', ')}`); return }
  if (!opts.status && !opts.summary && !opts.tags) { fail('FAIL: nothing to update (--status/--summary/--tags required)'); return }
  if (opts.summary && opts.summary.length > LIMITS.MAX_SUMMARY_CHARS) { fail(`FAIL: --summary ${opts.summary.length} chars > limit ${LIMITS.MAX_SUMMARY_CHARS}`); return }
  const newTags = opts.tags ? opts.tags.split(',').map((t) => t.trim()).filter(Boolean) : null

  await withLock(dir, async () => {
    const man = await loadManifest(dir)
    const idMap = await loadIdMap(dir)
    const find = async () => {
      if (idMap && idMap[id] !== undefined) {
        const shardNum = idMap[id]
        const s = await loadShard(dir, shardNum)
        if (s.corrupt) return null
        return { node: s.nodes.find((x) => x.id === id), shardNum }
      }
      const r = await allNodes(dir, man)
      const node = r.nodes.find((x) => x.id === id)
      if (!node) return null
      for (let n = 0; n <= man.active_shard; n++) {
        const s = await loadShard(dir, n)
        if (s.corrupt) continue
        if (s.nodes.some((x) => x.id === id)) return { node, shardNum: n }
      }
      return { node, shardNum: null }
    }
    const found = await find()
    if (!found || !found.node) { fail(`FAIL: node ${id} not found`); return }

    const node = found.node
    if (opts.status) node.status = opts.status
    if (opts.summary) node.summary = opts.summary

    if (newTags) {
      const removed = (node.tags || []).filter((t) => !newTags.includes(t))
      const added = newTags.filter((t) => !(node.tags || []).includes(t))
      node.tags = newTags
      const tagsIndex = await loadTags(dir)
      for (const t of removed) {
        tagsIndex[t] = (tagsIndex[t] || []).filter((e) => (typeof e === 'string' ? e : e.id) !== id)
        if (tagsIndex[t].length === 0) delete tagsIndex[t]
      }
      for (const t of added) {
        ;(tagsIndex[t] ??= []).push({ id, shard: found.shardNum ?? idMap?.[id] })
      }
      await saveTags(dir, tagsIndex)
    }

    // Write back to its shard. If no idMap, locate by scan.
    if (found.shardNum !== null) {
      const shardNum = found.shardNum
      const s = await loadShard(dir, shardNum)
      const idx = s.nodes.findIndex((x) => x.id === id)
      s.nodes[idx] = node
      await writeFile(join(dir, `index.${shardNum}.json`), JSON.stringify(s, null, 2) + '\n')
    } else {
      for (let n = 0; n <= man.active_shard; n++) {
        const s = await loadShard(dir, n)
        if (s.corrupt) continue
        const idx = s.nodes.findIndex((x) => x.id === id)
        if (idx !== -1) {
          s.nodes[idx] = node
          await writeFile(join(dir, `index.${n}.json`), JSON.stringify(s, null, 2) + '\n')
          break
        }
      }
    }
    console.log(`updated ${id} (status=${opts.status || '-'}${newTags ? `, tags=${newTags.join(',')}` : ''})`)
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
    const lines = (await readFile(join(dir, 'nodes', f), 'utf8')).split('\n').length
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
    console.log(`OK: ${all.length} nodes across ${manifest.active_shard + 1} shard(s), ${Object.keys(tagsIndex).length} tags, ${nodeFiles.filter((f) => f.endsWith('.md')).length} node file(s)`)
  }
}

async function main(argv = process.argv) {
  const { cmd, opts, positional } = parseArgs(argv)
  switch (cmd) {
    case 'init': return init(atlasDir(positional[positional.length - 1] ?? '.'))
    case 'record': return record(atlasDir(positional[positional.length - 1] ?? '.'), opts)
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
      return update(atlasDir(dirArg), { _id: opts.id || rest[0], status: opts.status, summary: opts.summary, tags: opts.tags })
    }
    case 'recent': return recent(atlasDir(positional[positional.length - 1] ?? '.'), opts)
    case 'stat': return stat(atlasDir(positional[positional.length - 1] ?? '.'))
    case 'scan': return scan(atlasDir(positional[positional.length - 1] ?? '.'), opts)
    case 'rebuild': return rebuild(atlasDir(positional[positional.length - 1] ?? '.'))
    case 'check': return check(atlasDir(positional[positional.length - 1] ?? '.'))
    default:
      console.error(usage())
      process.exitCode = 1
  }
}

// Run only when invoked directly; when imported (MCP server) skip auto-run.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
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
