# Evaluasi Skill atlas-owner — 2026-09-02

> Note ini sengaja ditaruh di folder backup (snapshot `atlas-backup-2026-09-02T00-44-40-336Z/`)
> sebagai catatan evaluasi buat pengembangan skill atlas-owner selanjutnya.
> Snapshot ini = keadaan atlas SEBELUM konsolidasi: 1948 node, 1773 di antaranya auto-record noise.

---

## 1. Ringkasan Skill

**Lokasi:** `~/.config/opencode/skills/atlas-owner/` (hanya 2 file: `SKILL.md` + `scripts/atlas.mjs`)
**Fungsi:** persistent graph memory ala Product Owner. Tiap fakta project = 1 node JSON. Auto-shard, CLI-based.
**Cara pakai:** sebelum kerja → `query`; sesudah kerja → `record`. PROTOCOL.md di-inject ke agent.

### Jenis node (type)
`requirement, feature, task, bug, decision, business, positive, negative, edge, pitfall`

### Status
`active, done, fixed, open, archived`

### Jenis koneksi (conn)
`fixes, caused, led_to, relates, blocks, depends, contradicts, example_of, implements, satisfies`

### Batas keras (dienforce `check`)
| Limit | Nilai |
|-------|-------|
| MAX_SUMMARY_CHARS | 140 |
| MAX_MD_LINES (`nodes/{ID}.md`) | 200 |
| MAX_NODES_PER_SHARD | 300 (override env `ATLAS_MAX_SHARD`) |

---

## 2. Arsitektur Data (repo `atlas/`)

```
atlas/
├── manifest.json     # node_count, active_shard, seed_id
├── index.{0..6}.json # shard data: {shard, nodes:[{id,type,status,date,time,tags,summary,conn}]}
├── id_map.json       # id → shard (O(1) lookup)
├── tags_index.json   # tag → [{id, shard}]
├── nodes/*.md        # detail panjang per node (opsional, ≤200 baris)
├── rules.md          # format node/edge
├── PROTOCOL.md       # rules usage agent
└── README.md
```

### Command atlas.mjs
| Command | Fungsi |
|---------|--------|
| `init` | Scaffold atlas/ |
| `ingest` | Baca AGENTS.md/CLAUDE.md → knowledge nodes |
| `record` | Tambah node (`--id --type --status --tags --summary --conn [--file]`) |
| `query` | Search keywords/tags |
| `get` | Tampilkan 1 node |
| `update` | Ubah status/summary/tags |
| `delete` | Hapus node (`--force` override referensi) |
| `recent` | Node terbaru |
| `stat` | Count per type/status |
| `scan` | Map struktur repo |
| `export` | Dump full graph JSON |
| `rebuild` | Rebuild id_map + tags_index |
| `doctor` | Version drift check |
| `check` | Integrity + limits |

---

## 3. Temuan Audit (dari sesi konsolidasi 2026-09-02)

### 3.1 🔴 Auto-record noise = 91% graph
- Plugin auto-record bikin 1 node per file edit: `tags:["auto"]`, `summary:"auto: edited <path>"`, type `task`, status `done`.
- Sebelum konsolidasi: **1773/1948 (91%)** adalah noise ini.
- Semua conn cuma `REQ-001:relates` — zero semantic value, gak ada chain.
- **93% node = leaf** (gak ada node lain yang reference). Graph nyaris tanpa edge berguna.

### 3.2 🔴 CLI parsing bug (terbukti live)
`--tags summary,leadgen` (comma list) bikin flag `--status` kebaca salah:
```
FAIL: invalid --status "summary". Valid: active, done, fixed, open, archived
```
**Penyebab dugaan:** parser flag atlas.mjs kemungkinan salah memetakan value ketika tags berisi comma / lebih dari 1 kata.
**Workaround yang terbukti jalan:** tag TUNGGAL (`--tags summary`), tanpa comma.
**Fix yang dibutuhkan:** audit parser argumen di `atlas.mjs` — dukung comma-separated tags + multi-value.

### 3.3 🔴 Gak ada bulk operation
- `update` = per node. `delete` = per node.
- Archive 1773 node → butuh script custom (`tools/atlas-consolidate.mjs` di repo) yang edit `index.*.json` langsung (langgar rule "jangan baca json raw" — tapi terpaksa, CLI gak dukung).
- Rebuild id_map + tags_index setelahnya: `node atlas.mjs rebuild`.

### 3.4 🟡 Tags index bloat
`tags_index.json` ~10.274 baris — mayoritas tag `auto` numpuk. Setelah auto di-archive + rebuild, turun drastis ke 321 tags (verified).

### 3.5 🟡 Gak ada pruning
- Gak ada auto-archive, auto-prune, atau TTL. Status `archived` cuma manual.
- Corrupt shard: di-skip + WARN, gak auto-fix.

### 3.6 🟡 Detail file `.md` jarang dipakai
- 77 node punya `nodes/*.md`, total 140 baris. Sebagian besar node cuma summary ≤140 char.
- Limit 200 baris ada tapi gak ada penegakan otomatis "kalau panjang, WAJIB ke .md" — summary yang kepanjangan di-truncate ke file md (auto), tapi banyak info hilang karena agent malas bikin detail file.

### 3.7 🟡 Plugin auto-record gak ada di skill install
- Skill copy cuma `SKILL.md` + `scripts/atlas.mjs`.
- Plugin (`plugin/index.js`, `plugin/mcp-server.js`) ada di npm/repo root, BUKAN di `~/.config/opencode/plugins/`.
- Mesin ini auto-record-nya dari source lain (plugin terinstall terpisah). **Kalau mau kembangkan, ambil sumber plugin-nya dulu** — jangan kaget kalau skill copy gak punya.

### 3.8 🟡 ID numbering loncat
TASK-1 → TASK-10073, ada gap besar (523→601, 625→800, ...). ID gak kontinu — plugin auto-record skip sequence.

---

## 4. Rekomendasi Pengembangan (skill v2)

### 4.1 Pruning sistem biar load cepat (ide user)
**Masalah:** node numpuk → `query`/`export` makin lambat + konteks penuh.
**Solusi yang disarankan:**
- Tambah command `prune` di atlas.mjs:
  - Kriteria: type `task` + status `done` + umur > 90 hari + gak ada conn masuk (leaf) → otomatis `archived`.
  - Kriteria: node `auto` murni (`tags:["auto"]`) + status `done` + leaf → `archived`.
  - Node penting (bug/decision/requirement/business/negative) → gak disentuh.
  - Hooks: auto-prune tiap `record` (probabilistik, mis. 5% atau tiap 100 node) ATAU perintah `prune --auto`.
- Batas penskalaan: tambah `manifest.json` field `pruned_count`, `last_prune_at`.
- **Penting:** archive ≠ hapus. Data tetap di index, cuma status beda → load query default skip `archived`.

### 4.2 Full storage di file `.md` ber-line-limit (ide user)
**Masalah:** info detail banyak yang cuma di summary atau hilang.
**Solusi:**
- Enforcement di `record`: kalau `--summary` > 140 char → WAJIB simpan detail ke `nodes/{ID}.md` (auto), summary tetap ringkas.
- Kalau `--file` dikasih → tulis ke `nodes/{ID}.md` (≤200 baris), JANGAN bikin summary panjang.
- Tambah command `edit ID` — buka/tulis `nodes/{ID}.md` (append/edit aman).
- `check` harus VERIFIKASI: summary ≤140, md ≤200 baris, md gak ada orphan (ID-nya harus ada di index).
- Folder `nodes/` jadi "tampungan memori penuh" — index cuma ringkasan + lokasi.

### 4.3 Folderisasi + klasifikasi otomatis Issue/Bisnis/Teknis (ide user)
**Masalah:** node gak terstruktur, jenis campur.
**Solusi yang disarankan:**
- Klasifikasi otomatis berdasar `type` saat `record`:
  - **Issue** → `bug`, `pitfall`, `negative`, `edge`, `positive`
  - **Business** → `business`, `requirement`, `decision` (keputusan bisnis/PO)
  - **Teknis** → `task`, `feature`, `decision` (keputusan teknis/arsitektur), `test`
  - Catatan: `decision` bisa dua-duanya → butuh flag ekstra `--domain business|technical|ops`, default infer dari tags/type.
- Folderisasi file:
  - `nodes/issue/{ID}.md`, `nodes/business/{ID}.md`, `nodes/technical/{ID}.md`
  - Simpan `category` sebagai field baru di node index (`category: "issue"|"business"|"technical"`) biar query cepat tanpa baca file.
  - Migration: script geser `nodes/*.md` existing ke subfolder berdasar type.
- Backward compat: kalau subfolder gak ada → fallback ke `nodes/` root.

### 4.4 Fix parser argumen CLI (wajib, kecil)
- Audit parsing `--tags`/`--status`/`--conn` — dukung comma-separated + multi-value tanpa bikin flag lain salah.
- Tambah `--help` per command + validasi early.

### 4.5 Bulk operation (nilai besar, effort sedang)
- `update --filter "type=task&status=done&tags=auto" --status archived`
- `delete --filter ... --force`
- Implementasi: read semua shard → filter → tulis ulang → rebuild. (Pola udah ada di `tools/atlas-consolidate.mjs` — pindahkan logic-nya ke atlas.mjs biar gak perlu script eksternal.)

### 4.6 Command tambahan yang berguna
- `prune` (4.1)
- `export --stats` (ringkasan struktur graph)
- `cluster` (auto-tag topik berdasar keyword di summary — mirip SUM-00X manual)
- `verify` (versi check yang nge-verifikasi connector gak putus)

---

## 5. Prioritas Pengembangan

| Prioritas | Item | Effort | Impact |
|-----------|------|--------|--------|
| P0 | Fix parser argumen CLI (3.2) | kecil | bug aktif, bikin salah pakai |
| P0 | Bulk update filter (4.5) | sedang | konsolidasi gak perlu script custom |
| P1 | Pruning otomatis (4.1) | sedang | load cepat, graph bersih |
| P1 | Enforcement .md storage (4.2) | kecil-sedang | info detail gak hilang |
| P2 | Folderisasi + kategori (4.3) | besar | struktur rapi, klasifikasi otomatis |
| P2 | Cluster auto-tag (4.6) | sedang | ringkasan per topik otomatis |

---

## 6. Catatan Sesi Konsolidasi 2026-09-02

Yang udah dilakukan (di repo `threads-automation`, BUKAN di skill):
- `tools/atlas-consolidate.mjs` — backup + archive 1774 node auto (status → `archived`, data tetap).
- 15 node ringkasan per topik (`SUM-001..015`, active) → masing-masing conn ke node manual kunci.
- 175 node manual dibiarkan active.
- Rebuild + check clean: 1964 node, 321 tags, 7 shard.
- Backup: folder ini (`atlas-backup-2026-09-02T00-44-40-336Z/`).

**Rollback kalau salah:** `rm -rf atlas && mv atlas-backup-2026-09-02T00-44-40-336Z atlas`

---

## 7. Referensi Cepat

```bash
AT=/Users/vanviakingali/.config/opencode/skills/atlas-owner/scripts/atlas.mjs
node "$AT" query "keyword" --tags a,b --limit 5
node "$AT" get TASK-1964
node "$AT" recent --limit 10
node "$AT" stat
node "$AT" check
node "$AT" rebuild
node "$AT" record --id SUM-001 --type feature --status active --tags summary --summary "..." --conn "REQ-001:relates"
node "$AT" update SUM-001 --status archived
```

⚠️ **Gotcha:** `--tags` pake comma list bisa bikin `--status` salah kebaca (3.2). Pakai tag tunggal dulu.