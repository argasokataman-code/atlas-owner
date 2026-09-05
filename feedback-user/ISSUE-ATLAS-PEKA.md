# Issue Atlas: Tidak Kritis & Tidak Peka — 2026-09-05

> Issue buat developer atlas-owner / skill v2. Atlas sekarang = memori PASIF,
> bukan monitor AKTIF. Dia cuma tahu apa yang di-record, gak pernah "rasa"
> sendiri. Bukti nyata dari sesi 2026-09-05:
> - BUG-078 (relogin stale) → BUG-079 (captcha) relate, tapi ketemu terpisah.
> - BUG-079/080 baru di-record SETELAH user nanya "udah masuk memori belum".
> - Auto-record cuma "edited file" noise (TASK-10500-10504), zero reasoning.

---

## 1. Masalah Inti

| # | Masalah | Bukti |
|---|---------|-------|
| 1 | **Gak auto preflight** — harus setup manual (`query` sebelum kerja). Kalau agent skip, atlas diem. | Protocol bilang "query dulu", tapi gak ada yang nge-enforce. |
| 2 | **Gak auto afterflight** — harus `record` manual. Auto-record cuma tangkap "edited file", gak ada reasoning/root cause. | TASK-10500-10504 noise. BUG-079/080 manual. |
| 3 | **Bukan MCP smart** — jalan via CLI manual + skill inject, bukan server aktif yang bisa nge-hook event kerja. | Gak ada tool atlas yang otomatis kepanggil. |
| 4 | **Gak kritis/peka** — gak nangkep issue baru = ulangan issue lama. Gak dedupe, gak collide, gak cross-check sebelum edit. | BUG-078→079 relate tapi terpisah; issue ke-kali ke-N. |

## 2. Harapan (Behavior Atlas v2)

1. **Preflight otomatis** — sebelum agent edit file / run bash:
   - Atlas query otomatis "open bug / pitfall nyentuh path ini?" → warn kalau ada.
   - Hook ke opencode (plugin) biar gak butuh manual. Agent gak perlu mikir "harusnya query dulu".
2. **Afterflight otomatis** — selesai kerja (edit/test/bash sukses):
   - Record node OTOMATIS dengan reasoning yang ditangkap dari CMD/conversation, bukan cuma "edited file".
   - Auto-dedupe: kalau node mirip sudah ada (open/fixed) → collide/merge, bukan node baru.
3. **MCP server aktif** — atlas jadi MCP (kayak agent-browser/supabase), masuk daftar tools, bisa:
   - Detect overlap antar node (conn otomatis).
   - Warn agent saat mau bikin keputusan yang udah diputusin (NEG/DEC check otomatis).
   - Archive noise sendiri (prune).
4. **Kritis = nangkep sebelum rusak** — kalau ada BUG terbuka di path X, agent yang mau edit X harus tahu DULU. Bukan setelah user tanya.

## 2b. Harapan Tambahan: Kategorisasi Otomatis per Fitur (ide user 2026-09-05)

Atlas harus auto-klaster semua case berdasarkan NAMA FITUR/menu, bukan numpuk
flat per type. Tujuannya: agent gampang baca, mengurangi duplikasi + pembacaan
ulang, mapping neuron graph makin rapi.

**Struktur yang dimau:**
```
atlas/
  features/
    <nama-fitur>/          # auto-buat dari nama fitur/menu (mis. live-feed, scheduler, bot-safety)
      index.md             # ringkasan fitur + daftar case didalamnya
      BUGS.md              # semua bug fitur ini (atau bug-079.md per-case)
      EDGES.md             # edge case / pitfall
      ISSUES.md            # issue terbuka
      ... per type
```

**Cara infer nama fitur (saat `record` / preflight):**
- Dari path file yang diedit → mapping path→fitur (mis. `web/src/pages/live-feed.tsx` → `live-feed`, `cmd/api-server/brain.go` → `persona/brain`).
- Kalau path gak jelas → infer dari tags/summary keyword.
- Manifest mapping path→fitur biar konsisten (bisa dipelihara manual + auto-suggest).

**Behavior:**
- Record node baru → otomatis masuk folder fitur yang sesuai + update `index.md` (daftar case).
- Preflight query → scope ke folder fitur yang mau disentuh, bukan seluruh graph.
- Dedupe antar case dalam folder yang sama (bug yang sama gak dobel masuk).
- Kategori yang gak punya fitur jelas → folder `_uncategorized/` atau tetap flat.

## 3. Gap Teknis yang Harus Dievaluasi Developer

- Plugin auto-record sekarang cuma `tags:["auto"]` + `summary:"auto: edited <path>"`. Perlu tangkap: apa yang diubah, kenapa, hasil verify (build/test) → simpan sebagai reasoning node.
- Perlu event hook opencode (on tool call / on edit / on bash result) → trigger preflight/afterflight.
- Perlu dedupe algorithm: similarity check summary/path/tags sebelum record.
- Perlu state "peka": kalau query nemu node related, INJECT ke context agent, bukan tunggu agent nanya.

## 4. Referensi

- `atlas/EVALUASI-SKILL.md` — evaluasi skill v1 (auto-record noise 91%, parser CLI bug, dst).
- BUG-079, BUG-080 — contoh issue yang ke-record telat (manual, setelah user tanya).
- `atlas/PROTOCOL.md` — protocol manual yang harusnya jadi otomatis.