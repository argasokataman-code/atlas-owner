#!/usr/bin/env node
// atlas — Product Owner graph memory CLI (modular, auto-shard).
//
// Commands:
//   atlas init [dir]                     scaffold atlas/
//   atlas record --id X --type T --status S --tags a,b --summary "..." [--conn "ID:type,ID:type"] [--file path.md] [dir]
//   atlas query "keywords" [--tags a,b] [--limit N] [dir]
//   atlas get ID [dir]
//   atlas check [dir]
//
// Structure (modular on purpose):
//   atlas/manifest.json       small meta: active_shard, node_count, updated
//   atlas/index.{n}.json      node shards, auto-split at MAX_NODES_PER_SHARD
//   atlas/tags_index.json     tag -> [node ids]
//   atlas/nodes/{ID}.md       optional detail, MAX_MD_LINES enforced
//   atlas/PROTOCOL.md         always-in-context retrieval rules
//
// Token rule: AI must call `atlas query/get`, never read atlas/*.json raw.
import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const TYPES = ['requirement', 'feature', 'task', 'bug', 'decision', 'positive', 'negative', 'edge', 'pitfall']
const CONN_TYPES = ['fixes', 'caused', 'led_to', 'relates', 'blocks', 'depends', 'contradicts', 'example_of', 'implements', 'satisfies']
const STATUSES = ['active', 'done', 'fixed', 'open', 'archived']

export const LIMITS = {
  MAX_NODES_PER_SHARD: Number(process.env.ATLAS_MAX_SHARD) || 300,
  MAX_SUMMARY_CHARS: 140,
  MAX_MD_LINES: 200,
}

const PROTOCOL = `# Atlas Protocol

Graph memory for Product Owner behavior. Read before work, follow after work.

## Retrieval — Wajib lewat CLI. JANGAN baca atlas/*.json langsung.
node <atlas> query "keywords" [--tags a,b] [--limit 5]
node <atlas> get ID

## Record — tiap kerja signifikan, langsung di command yang sama.
node <atlas> record --id TASK-003 --type task --status done --tags a,b --summary "max 140 char" --conn "BUG-001:fixes,DEC-002:led_to"
node <atlas> record --id REQ-001 --type requirement --status active --tags core --summary "..." --conn "FEAT-001:relates" --file nodes/REQ-001.md

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
- Modular: nodes live in index.{n}.json shards (auto-split at ${LIMITS.MAX_NODES_PER_SHARD} default; ATLAS_MAX_SHARD overrides). tags_index.json maps tag -> ids.
- Never read atlas/*.json raw. Use the CLI: query, get, record.
- summary <= ${LIMITS.MAX_SUMMARY_CHARS} chars. node files <= ${LIMITS.MAX_MD_LINES} lines.

## Types: ${TYPES.join(', ')}
## Status: ${STATUSES.join(', ')}
## Connections: ${CONN_TYPES.join(', ')}
`

const README = `# Atlas — Product Owner Graph Memory

- manifest.json + index.{n}.json (shards) + tags_index.json + nodes/*.md
- Read via CLI (query/get/record), never raw JSON.
- Record every significant requirement, feature, decision, bug, task, gotcha.
`

function today() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
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

async function loadShard(dir, n) {
  const f = join(dir, `index.${n}.json`)
  if (!existsSync(f)) return { shard: n, nodes: [] }
  return JSON.parse(await readFile(f, 'utf8'))
}

async function loadManifest(dir) {
  const f = join(dir, 'manifest.json')
  if (!existsSync(f)) return null
  return JSON.parse(await readFile(f, 'utf8'))
}

async function saveManifest(dir, m) {
  m.updated = today()
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(m, null, 2) + '\n')
}

async function loadTags(dir) {
  const f = join(dir, 'tags_index.json')
  if (!existsSync(f)) return {}
  return JSON.parse(await readFile(f, 'utf8'))
}

async function saveTags(dir, tags) {
  await writeFile(join(dir, 'tags_index.json'), JSON.stringify(tags, null, 2) + '\n')
}

async function allNodes(dir, manifest) {
  const out = []
  for (let n = 0; n <= (manifest?.active_shard ?? 0); n++) {
    out.push(...(await loadShard(dir, n)).nodes)
  }
  return out
}

async function init(dir) {
  await mkdir(join(dir, 'nodes'), { recursive: true })
  const manifest = await loadManifest(dir)
  if (!manifest) await saveManifest(dir, { version: 1, updated: today(), active_shard: 0, node_count: 0, seed_id: null })
  if (!existsSync(join(dir, 'index.0.json'))) await writeFile(join(dir, 'index.0.json'), JSON.stringify({ shard: 0, nodes: [] }, null, 2) + '\n')
  if (!existsSync(join(dir, 'tags_index.json'))) await saveTags(dir, {})
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

function nextId(existing, prefix) {
  let max = 0
  for (const n of existing) {
    if (n.id.startsWith(prefix + '-')) {
      const num = parseInt(n.id.slice(prefix.length + 1), 10)
      if (!Number.isNaN(num) && num > max) max = num
    }
  }
  return `${prefix}-${String(max + 1).padStart(3, '0')}`
}

async function record(dir, opts) {
  const manifest = await loadManifest(dir)
  if (!manifest) { console.error('FAIL: atlas/ not initialized. Run: atlas init'); process.exitCode = 1; return }
  const nodes = await allNodes(dir, manifest)
  const ids = new Set(nodes.map((n) => n.id))

  let id = opts.id
  if (!id) {
    const prefix = ({ requirement: 'REQ', feature: 'FEAT', task: 'TASK', bug: 'BUG', decision: 'DEC', positive: 'POS', negative: 'NEG', edge: 'EDGE', pitfall: 'PF' })[opts.type]
    if (!prefix) { console.error('FAIL: --type required (or --id). Valid types: ' + TYPES.join(', ')); process.exitCode = 1; return }
    id = nextId(nodes, prefix)
  }
  if (ids.has(id)) { console.error(`FAIL: duplicate node id ${id}`); process.exitCode = 1; return }
  if (!TYPES.includes(opts.type)) { console.error(`FAIL: invalid --type "${opts.type}"`); process.exitCode = 1; return }
  if (!STATUSES.includes(opts.status)) { console.error(`FAIL: invalid --status "${opts.status}". Valid: ${STATUSES.join(', ')}`); process.exitCode = 1; return }
  const summary = opts.summary
  if (!summary) { console.error('FAIL: --summary required'); process.exitCode = 1; return }
  if (summary.length > LIMITS.MAX_SUMMARY_CHARS) { console.error(`FAIL: --summary ${summary.length} chars > limit ${LIMITS.MAX_SUMMARY_CHARS}`); process.exitCode = 1; return }
  const tags = opts.tags ? opts.tags.split(',').map((t) => t.trim()).filter(Boolean) : []
  const conn = parseConn(opts.conn)
  // First node seeds the graph and is allowed to have no edges yet.
  if (conn.length === 0 && nodes.length > 0) { console.error('FAIL: --conn required (>= 1 edge). Format: ID:type,ID:type'); process.exitCode = 1; return }
  for (const c of conn) {
    if (!ids.has(c.id)) { console.error(`FAIL: --conn -> unknown node ${c.id}`); process.exitCode = 1; return }
    if (!CONN_TYPES.includes(c.type)) { console.error(`FAIL: --conn type "${c.type}" invalid`); process.exitCode = 1; return }
  }
  const node = { id, type: opts.type, status: opts.status, date: today(), tags, summary, conn }
  if (opts.file) {
    const filePath = resolveNodeFile(dir, opts.file)
    if (!filePath) { console.error(`FAIL: --file not found: ${opts.file}`); process.exitCode = 1; return }
    const lines = (await readFile(filePath, 'utf8')).split('\n').length
    if (lines > LIMITS.MAX_MD_LINES) { console.error(`FAIL: node file ${lines} lines > limit ${LIMITS.MAX_MD_LINES}`); process.exitCode = 1; return }
  }

  const shardNum = manifest.active_shard
  const shard = await loadShard(dir, shardNum)
  shard.nodes.push(node)
  await writeFile(join(dir, `index.${shardNum}.json`), JSON.stringify(shard, null, 2) + '\n')
  manifest.node_count++
  if (shard.nodes.length >= LIMITS.MAX_NODES_PER_SHARD) {
    manifest.active_shard++
    await writeFile(join(dir, `index.${manifest.active_shard}.json`), JSON.stringify({ shard: manifest.active_shard, nodes: [] }, null, 2) + '\n')
  }
  await saveManifest(dir, manifest)

  const tagsIndex = await loadTags(dir)
  for (const t of tags) {
    ;(tagsIndex[t] ??= []).push(id)
  }
  await saveTags(dir, tagsIndex)
  console.log(`recorded ${id} -> index.${shardNum}.json`)
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

async function query(dir, opts) {
  const manifest = await loadManifest(dir)
  if (!manifest) { console.error('FAIL: atlas/ not initialized. Run: atlas init'); process.exitCode = 1; return }
  const nodes = await allNodes(dir, manifest)
  const words = opts._q ? opts._q.toLowerCase().split(/\s+/).filter(Boolean) : []
  const tagFilter = opts.tags ? opts.tags.split(',').map((t) => t.trim()).filter(Boolean) : []
  const limit = Math.min(parseInt(opts.limit, 10) || 5, 20)
  let matches = nodes.filter((n) => scoreNode(n, words, tagFilter) >= 0)
  if (!words.length && !tagFilter.length) matches = nodes
  matches.sort((a, b) => scoreNode(b, words, tagFilter) - scoreNode(a, words, tagFilter))
  const top = matches.slice(0, limit)
  for (const n of top) {
    const hasFile = existsSync(join(dir, 'nodes', `${n.id}.md`)) ? ' +md' : ''
    console.log(`[${n.id}] ${n.type}/${n.status} #${(n.tags || []).join('#')} — ${n.summary}${hasFile}`)
  }
  console.log(`(${top.length}/${matches.length} nodes)`)
}

async function get(dir, opts) {
  const manifest = await loadManifest(dir)
  if (!manifest) { console.error('FAIL: atlas/ not initialized. Run: atlas init'); process.exitCode = 1; return }
  const nodes = await allNodes(dir, manifest)
  const n = nodes.find((x) => x.id === opts._id)
  if (!n) { console.error(`FAIL: node ${opts._id} not found`); process.exitCode = 1; return }
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

async function check(dir) {
  const manifest = await loadManifest(dir)
  if (!manifest) {
    console.error('FAIL: atlas/manifest.json missing. Run: atlas init')
    process.exitCode = 1
    return
  }
  const errors = []
  const all = await allNodes(dir, manifest)
  const ids = new Set()
  // Exactly one node may be edge-less: the graph seed. Derive it from the data,
  // never trust manifest.seed_id (a tampered seed_id could hide orphans).
  const edgeLess = all.filter((n) => n && !(Array.isArray(n.conn) && n.conn.length > 0))
  const seedOk = edgeLess.length === 1 || all.length === 1

  for (const n of all) {
    if (!n || typeof n !== 'object' || typeof n.id !== 'string') { errors.push('node must be an object with string id'); continue }
    if (ids.has(n.id)) errors.push(`${n.id}: duplicate node id`)
    ids.add(n.id)
    if (!TYPES.includes(n.type)) errors.push(`${n.id}: unknown type "${n.type}"`)
    if (!STATUSES.includes(n.status)) errors.push(`${n.id}: invalid/missing status "${n.status}"`)
    if (!n.summary) errors.push(`${n.id}: missing summary`)
    else if (n.summary.length > LIMITS.MAX_SUMMARY_CHARS) errors.push(`${n.id}: summary ${n.summary.length} chars > ${LIMITS.MAX_SUMMARY_CHARS}`)
    if (!Array.isArray(n.conn) || n.conn.length === 0) {
      if (!seedOk) errors.push(`${n.id}: orphan node (no conn)`)
    }
    for (const c of n.conn || []) {
      if (!c || typeof c !== 'object' || typeof c.id !== 'string') { errors.push(`${n.id}: conn entry must be object with id`); continue }
      if (!ids.has(c.id) && !all.some((x) => x.id === c.id)) errors.push(`${n.id}: conn -> missing node ${c.id}`)
      if (!CONN_TYPES.includes(c.type)) errors.push(`${n.id}: conn type "${c.type}" invalid`)
    }
    if (!Array.isArray(n.tags)) errors.push(`${n.id}: tags must be array`)
  }

  const tagsIndex = await loadTags(dir)
  for (const [tag, list] of Object.entries(tagsIndex)) {
    if (!Array.isArray(list)) { errors.push(`tags_index["${tag}"] must be array`); continue }
    for (const id of list) {
      const node = all.find((n) => n && n.id === id)
      if (!node) errors.push(`tags_index["${tag}"] -> missing node ${id}`)
      else if (!(Array.isArray(node.tags) && node.tags.includes(tag))) errors.push(`node ${id} missing tag "${tag}" back-referenced in tags_index`)
    }
  }
  for (const n of all) {
    for (const t of n.tags || []) {
      if (!Array.isArray(tagsIndex[t]) || !tagsIndex[t].includes(n.id)) errors.push(`${n.id}: tag "${t}" missing from tags_index`)
    }
  }

  let nodeFiles = []
  try { nodeFiles = await readdir(join(dir, 'nodes')) } catch { /* ENOENT */ }
  for (const f of nodeFiles) {
    if (!f.endsWith('.md')) continue
    const id = f.replace(/\.md$/, '')
    if (!ids.has(id)) errors.push(`node file ${f}: id not in index`)
    const st = await stat(join(dir, 'nodes', f))
    if (st.size === 0) continue
    const lines = (await readFile(join(dir, 'nodes', f), 'utf8')).split('\n').length
    if (lines > LIMITS.MAX_MD_LINES) errors.push(`${f}: ${lines} lines > ${LIMITS.MAX_MD_LINES}`)
  }

  const activeShard = manifest.active_shard
  for (let n = 0; n <= activeShard; n++) {
    const s = await loadShard(dir, n)
    if (s.nodes.length > LIMITS.MAX_NODES_PER_SHARD) errors.push(`index.${n}.json: ${s.nodes.length} nodes > ${LIMITS.MAX_NODES_PER_SHARD}`)
  }

  if (errors.length) {
    console.error(`FAIL: ${errors.length} issue(s)`)
    for (const e of errors) console.error(`  - ${e}`)
    process.exitCode = 1
  } else {
    console.log(`OK: ${all.length} nodes across ${activeShard + 1} shard(s), ${Object.keys(tagsIndex).length} tags, ${nodeFiles.filter((f) => f.endsWith('.md')).length} node file(s)`)
  }
}

async function main() {
  const { cmd, opts, positional } = parseArgs(process.argv)
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
    case 'check': return check(atlasDir(positional[positional.length - 1] ?? '.'))
    default:
      console.error(`Usage:\n  atlas init|record|query|get|check [dir]\n\nCommands:\n  init        scaffold atlas/\n  record      add node (--id --type --status --tags --summary --conn [--file])\n  query       search ("keywords" [--tags a,b] [--limit N])\n  get ID      show node\n  check       verify integrity + limits`)
      process.exitCode = 1
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
