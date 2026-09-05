# Evaluasi Dalam — Atlas v2 (Mengapa Atlas Kurang "Click" + Rencana Pengembangan)

> Lanjutan dari `EVALUASI-SKILL.md`. Ditulis 2026-09-02.
> Dasar: analisis source `atlas.mjs` v0.7.5 (1235 baris), plugin auto-record
> (`~/.local/share/fnm/.../node_modules/atlas-owner/plugin/index.js`), integrasi opencode.

---

## 1. Diagnosis: Kenapa Atlas "Kurang Click" sama Repo

5 akar masalah yang bikin atlas terasa nyangkut di udara, gak nyambung sama kode:

### 1.1 Auto-record buta — nyatet path, bukan makna
Plugin (`tool.execute.after` → hanya tool `edit`/`write`) nge-record `auto: edited /path/to/file.py`. Gak ada: apa yang berubah, fungsi apa, kenapa, masalah apa yang diselesaikan. → 91% graph jadi noise. **Atlas nyatet kejadian, bukan pengetahuan.**

### 1.2 Query tekstual O(n) + manual
- Tanpa `--tags`, tiap query baca SEMUA shard ke memori (`atlas.mjs:599-601`). 7 shard / 36k baris JSON tiap query.
- Scoring cuma substring: exact id +10, tag +5, kata di summary +3. Gak paham sinonim/konsep.
- **Pemicu manual:** PROTOCOL.md cuma nyuruh AI "call atlas query sebelum kerja". Gak ada auto-inject. Agent lupa → atlas gak kepake.

### 1.3 scan cuma jalanin folder — gak paham struktur kode
`scan` (default depth 1) bikin node `task`/`feature` per file/folder path. Gak ada: package map, service boundary, symbol (fungsi/class), dependency, file mana nyentuh apa. **Atlas gak tahu arsitektur repo.**

### 1.4 Detail .md nyaris kosong
78 file `nodes/*.md`, mayoritas 1 baris (auto-overflow dari summary >140 char). Yang beneran nulis panjang cuma DEC-004 (43 baris). Gak ada referensi `file:line`, gak ada fungsi. **Tampungan memori penuh gak terisi.**

### 1.5 Gak ada link ke commit/PR/kode
Schema node cuma `{id,type,status,date,time,tags,summary,conn}`. Gak ada `commit`, `loc`, `symbol`. "Kenapa ini berubah?" gak bisa di-trace ke diff/PR. **Atlas putus dari history kode.**

> **Inti masalah:** atlas = grafik teks, bukan grafik yang nyambung ke repo. Semua fix di bawah
> diarahkan ke SATU hal: **bikin tiap node punya "alasan nyata" di kode** (file, fungsi, commit, masalah).

---

## 2. Visi Atlas v2 — "Repo-Aware Graph Memory"

```
┌─────────────────────────────────────────────────────────────┐
│  SESSION START                                              │
│  plugin task.start → detect keywords → atlas_context        │
│  → inject 5 node relevan (~200 token)                       │
├─────────────────────────────────────────────────────────────┤
│  SELAMA KERJA                                               │
│  edit/write → semantic auto-record                          │
│    summary: "feat: tambah retry downloadImage di generate.go"│
│    + loc: internal/service/chatgptimage/generate.go:214      │
│    + commit hash (kalau ada)                                 │
│  scan --symbols → symbol_index (fungsi → node)               │
├─────────────────────────────────────────────────────────────┤
│  SAAT QUERY                                                 │
│  inverted index (kata → shard) → scan subset, bukan O(n)    │
│  query --deep → traverse conn 1-hop                          │
│  query --compact → hemat token                               │
└─────────────────────────────────────────────────────────────┘
```

**3 pilar:**
1. **Semantik** — node ngomong "apa & kenapa", bukan "file mana".
2. **Koneksi ke kode** — tiap node bisa ditelusuri ke file/fungsi/commit.
3. **Proaktif** — konteks datang sendiri, bukan nunggu agent ingat.

---

## 3. Rencana Konkret (per file, impact/effort)

### P0 — Bikin kepake (click)
| # | Item | File | Impact | Effort |
|---|------|------|--------|--------|
| A | **Auto-inject konteks**: tool MCP `atlas_context` — ekstrak keyword dari task description → query → balikin top-5 node. Plugin hook `task.start` panggil otomatis. | `mcp-server.js`, `plugin/index.js`, `atlas.mjs` (command `context`) | TINGGI — atlas gak perlu diinget | SEDANG |
| B | **Semantic auto-record**: plugin ambil diff stat + fungsi yang berubah + infer intent. Summary jadi `"change: <fungsi> di <file> — <intent>"`. Filter: gak record kalau cuma whitespace/format. | `plugin/index.js:174` | TINGGI — noise → pengetahuan | RENDAH |
| C | **Merge auto-node**: batch edit beruntun file sama (1 menit → 1 node) + skip `auto` di query default. | `plugin/index.js:162-191` | TINGGI — graph bersih | RENDAH |

### P1 — Cepat & hemat token
| # | Item | File | Impact | Effort |
|---|------|------|--------|--------|
| D | **Inverted index** `words_index.json` (kata → [{id,shard}]) — update di `record`, dipakai `query`. Query baca cuma shard relevan. | `atlas.mjs` (record/query/rebuild) | TINGGI — O(n)→O(k) | SEDANG |
| E | **Query compact** `--compact` → output `ID | summary` aja. Default verbose. Hemat token AI. | `atlas.mjs:588-608` | TINGGI — hemat token | RENDAH |
| F | **nextId counter** di manifest (bukan scan semua id tiap record). | `atlas.mjs:429-438` + `manifest.json` | SEDANG — record cepat | RENDAH |
| G | **Shard date-range** di manifest → `query --since N-hari` skip shard lama. | `manifest.json` + `atlas.mjs` | SEDANG | RENDAH |

### P2 — Nyambung ke repo
| # | Item | File | Impact | Effort |
|---|------|------|--------|--------|
| H | **`scan --symbols`**: regex AST-lite — Go `func X`, JS `function/const/export`, class. → `symbol_index.json` (simbol → node). Query cari nama fungsi. | `atlas.mjs:scan` | TINGGI — recall level kode | SEDANG |
| I | **Field `loc` + `commit`** di node schema. `get` tampilkan `file:line` clickable. Optional — backward compat. | `atlas.mjs:497` + schema | SEDANG — traceability | RENDAH |
| J | **Ingest semua `docs/**/*.md`** (bukan cuma AGENTS.md) — heading → feature node, tabel limit → decision node. | `atlas.mjs:821` | SEDANG — coverage | RENDAH |
| K | **`query --deep`**: traverse conn 1-hop, sertakan node tetangga. Satu query = konteks utuh. | `atlas.mjs:query` | SEDANG | SEDANG |

### P3 — Canggih (opsional, evaluasi dulu)
| # | Item | File | Impact | Effort |
|---|------|------|--------|--------|
| L | **Embedding search** `all-MiniLM-L6-v2` ONNX lokal (gratis). `nodes/{ID}.vec` (384 float ≈1.5KB). Cosine similarity ranking. Fallback teks. | `atlas.mjs` (embed command) | SANGAT TINGGI — paham konsep | TINGGI |
| M | **Auto-classify folderisasi** Issue/Bisnis/Teknis → `category` field + `nodes/{category}/` (dari ide sebelumnya, EVALUASI-SKILL.md §4.3). | `atlas.mjs:record` | SEDANG | SEDANG |
| N | **Node quality score** (punya .md? conn real? bukan auto? ada loc?) → ranking bagus dulu. | `atlas.mjs:scoreNode` | SEDANG | RENDAH |

---

## 4. Ekonomi Token (kenapa ini worth it)

| Skenario | Token |
|----------|-------|
| Agent nyari konteks manual (baca file, grep, nebak) | 2.000–5.000 |
| Auto-inject 5 node relevan (A) | ~200 |
| Query full-scan sekarang (D belum ada) | 1x baca 36k baris → besar |
| Query pake inverted index (D) | baca subset → kecil |

**Satu fitur A (auto-inject) ≈ hemat 10-25x token** dibanding agent nyari manual.
**D (inverted index) ≈ buang pembacaan 36k baris JSON tiap query.**

---

## 5. Roadmap

| Fase | Isi | Target |
|------|-----|--------|
| Fase 1 (dulu) | A + B + C — auto-inject, semantic record, merge noise | Atlas kepake, graph bermakna |
| Fase 2 | D + E + F + G — inverted index, compact, counter, date-range | Query cepat, hemat token |
| Fase 3 | H + I + J + K — symbol index, loc/commit, docs ingest, deep query | Nyambung ke kode |
| Fase 4 | L + M + N — embedding, folderisasi, quality score | Canggih |

---

## 6. Fakta Teknis Penting (buat dev nanti)

### Lokasi file
- Skill: `~/.config/opencode/skills/atlas-owner/` (SKILL.md + scripts/atlas.mjs)
- Plugin (sumber auto-record): `~/.local/share/fnm/node-versions/v24.16.0/installation/lib/node_modules/atlas-owner/plugin/index.js` — hook `tool.execute.after`, bucket `ISO-minute|filePath`, cuma tool `edit`/`write` (bash sengaja gak di-track)
- MCP: `opencode.json` baris 37-44 (in-process, ~1ms/call)
- PROTOCOL.md: di-inject via `config.instructions` (plugin baris 100-158)

### Algoritma yang udah ada (jangan rombak kalau gak perlu)
- `scoreNode` (atlas.mjs:535-608): id +10, id-kata +6, tag +5, kata-summary +3, prefix +1, 0 → buang
- `allNodes` (atlas.mjs:234-243): baca semua shard — hot path query/recent
- `tagCandidates` (atlas.mjs:557-584): pake tags_index → shard relevan (fallback allNodes kalau legacy)
- `nextId` (atlas.mjs:429-438): scan semua id cari max — O(n)
- auto-shard (atlas.mjs:504-507): 300 node → index.{n+1}.json
- file lock `.lock` stale-steal 5s (atlas.mjs:268-285)
- summary >140 → auto-truncate + simpan ke `nodes/{ID}.md`

### ⚠️ Bug yang udah terbukti
- `--tags a,b` (comma) bikin `--status` salah kebaca → pakai tag tunggal. Parser butuh audit (lihat EVALUASI-SKILL.md §3.2).
- Gak ada bulk archive → konsolidasi butuh script external (`tools/atlas-consolidate.mjs` di repo).

---

## 7. Ukuran Keberhasilan

Atlas v2 dianggap "nyambung" kalau:
1. **Tiap sesi** agent dapat konteks relevan otomatis tanpa disuruh.
2. **Auto-record** bikin node yang bisa dibaca manusia (intent, bukan path).
3. **Query** bisa cari fungsi/simbol/commit, bukan cuma keyword.
4. **Scan** paham arsitektur repo (package, service, dependency).
5. **Load cepat**: query tanpa tags gak baca semua shard.
6. **Token hemat**: inject 200 token ganti manual-search 2-5k token.