# SESSION LOG — Ridge Runner (make.fun flight-game bounty)

Terakhir diperbarui: 27 Nov 2026, sesi lanjutan (world upgrade).

## Status submission
- Bounty: make.fun `flight-game-bounty` → repo `flight-game`
- **Belum di-submit.** Submission lama masih utuh.
- Gate build (`main.ts`): `screenshots/` minimal 3, maksimal **4** file, tiap file **≤ 256 KB**.

---

## SESI INI: world upgrade (bangunan, jalan, laut, pabrik, waktu)

### Perbaikan akhir sesi: dua shot lemah + bug cahaya malam

**Bug: bangunan tetap putih di malam hari.** `rethemeLights` di `sky.js` hanya mengatur `sun`,
`hemi`, dan `ambient` — variabel `fill` ada di `group.userData` tapi **tidak pernah disentuh**, jadi
satu DirectionalLight kedua terus menyinari scene dari atas dengan intensitas konstan **0.42** jam
2 pagi. Lebih buruk: ambient punya bug terbalik — `sunIntensity < 1.2 ? 0.55 : 0.35`, yang **menaikkan**
ambient saat malam. Efeknya dinding plester putih kota tetap putih sepanjang malam, dan window-glow
tidak punya kontras untuk dibaca.

Fix: keduanya sekarang diskalakan `theme.lightLevel` (0..1 dari day cycle):
```
fill    = 0.06 + level * 0.36     (malam 0.06, siang 0.42 — siang tidak berubah)
ambient = 0.10 + level * 0.30     (malam 0.10, siang 0.40)
```
Floor non-nol disengaja: dinding tetap punya siluet di bawah bulan, jadi kota terbaca **gelap**, bukan
lubang hitam. Dampak: `settlement` naik dari 6/10 → **9/10** (vision: "bright and clear, good contrast
between green terrain, red roofs, grey mountains").

**Bug: `dogfight` — drone di frame tapi tak terlihat.** Bukan masalah penempatan. Probe proyeksi
membuktikan drone 0 ada di piksel (424,276), 82 m dari kamera, 6 mesh lengkap, `visible: true`.
Akar masalahnya: scene ditaruh di `(240,470,-1150)` **di dalam kanyon** — tanah di bawah kamera 507 m,
lebih tinggi dari pesawat (470 m). Chase camera punya terrain clamp yang mendorongnya naik 40 m,
hasilnya `camFwd.y = -0.694`: kamera menunduk **44°** ke tanah. Latar di belakang drone adalah dinding
tanah abu-abu yang warnanya sama dengan cat drone (`4a4f56`).

Fix: pindah ke `(-750, 470, 0)` di atas paparan pesisir datar (tinggi 58 m, relief 0 m) sehingga clamp
tidak pernah aktif. Lead drone dinaikkan 13 m di atas hidung dan didekatkan ke 34 m supaya siluetnya
terbaca terhadap langit. Hasil: 2 drone jelas + 1 ketiga sebagian, komposisi **8/10**.

**Bug: `coast` — kapal di luar frame, pelabuhan tak terbaca.** Ship 0 diproyeksikan ke piksel
(1672,839) — **di luar frame sama sekali**. Setelah dipindah ke frame kamera sendiri: 274 m, piksel
(460,594). Masalah kedua: pelabuhan berjarak 641 m sehingga crane jadi smear. Fix: lensa didekatkan ke
`target + (330,250)` pada 118 m, kapal ditempatkan di frame kamera (`ahead 175`, `lateral -96`), plus
**kapal kedua** di background. Hasil: dock, crane, coaster dengan container terbaca, **7/10**.

**Bug: `night` — kota di luar pandangan.** Pesawat terbang `th+190` dengan pitch −0.13 rad (−7°) →
kota jatuh 36° di bawah sumbu pandang, proyeksi ke piksel y=561/720: teknis masuk frame, praktis tak
terlihat. Fix: turunkan ke `th+105`, pitch −0.30 rad, cinema `back 0.58 / up 0.46`. Sekarang kota
dengan jendela hangat + lampu jalan terlihat di bawah, bintang tetap ada.

### Konsekuensi gate: maksimal 4 screenshot
`main.ts` baris 28 → `screenshots: { max: 4, max_bytes: 262144 }`. Empat yang dipilih untuk sebaran
maksimum, bukan skor individual tertinggi:

| File | Scene | Isi |
|---|---|---|
| `1-settlement.jpg` | settlement | kota + atap merah + jalan + pabrik, 9/10 |
| `2-dogfight.jpg` | dogfight | dua pesawat musuh terbaca, 8/10 |
| `3-coast.jpg` | coast | harbour + crane + coaster container, 7/10 |
| `4-night.jpg` | night | kota bercahaya + bintang + nav light, 6/10 |

`shots-final.mjs` menghapus isi `screenshots/` dulu (sisa file lama ikut dihitung ke cap 4), lalu
menulis JPEG dengan quality walk turun sampai tiap file ≤ 250 KB.

### Modul baru: `game/src/settlements.js` (~20 KB)
Lapisan permukiman 3D yang dibangun **dari heightfield**, bukan ditempel manual.

| Fitur | Isi |
|---|---|
| **Towns** | 4 kota, rumah grid mengikuti jalan, atap miring (prism), plinth batu, pita jendela per lantai, warna dinding/atap acak ter-seed |
| **Church** | Untuk kota >12 rumah: nave, atap, tower 22 m + spire kerucut |
| **Works** | Pabrik: shed 90 m dengan sawtooth roof, **2 cerobong 62 m & 48 m**, 2 cooling tower hiperboloid, 5 tangki, pipe rack |
| **Harbour** | Quay 150 m, breakwater 26 blok, **4 crane portal dengan boom**, 3 transit shed |
| **Roads** | Ribbon mengikuti terrain: trunk road + centre line kuning, spur ke tiap kota |

Prinsip teknis:
- Semua di-merge jadi **satu draw call per struktur** (`vertexColors` per-vertex, bukan material terpisah).
- **Flatness test** — kandidat situs ditolak kalau beda tinggi >30 m pada footprint; bangunan di lereng 25° terlihat salah dan tidak bisa diperbaiki dengan detail.
- Deterministik (seed `WORLD.seed ^ 0x51e77`) → screenshot reproducible.

### Modul baru: `game/src/daycycle.js` (~17 KB)
Siklus waktu yang menggerakkan **matahari, bulan, bintang, palet langit, kabut, dan lampu**.

```
hour 6.0  → alt 0.0°   dawn        light 0.50  stars 0
hour 7.4  → alt 10°    day         light 0.95
hour 12   → alt 28°    day         light 1.00  sunI 3.10
hour 17   → alt 7°     dusk        light 0.80
hour 19.5 → alt -11°   last light  light 0.05  stars 1  moon 1
hour 22   → alt -24°   night       light 0.00  sunI 0.10
```
- **Sun** naik di busur `cos(hour)`, `sunDirection()/sunAltitude()`.
- **Moon** berseberangan dengan matahari, **punya fase** yang dilukis ke canvas (crescent/quarter/gibbous), plus halo + maria.
- **Stars** 1400 titik, distribusi uniform di belahan atas, warna biru/oranye/putih, fade by `starOpacity`.
- **Palette** = fungsi elevasi matahari, bukan tabel jam → tidak ada langkah di batas.
- `isNight()`, `lightLevel()`, `phaseName()` untuk sistem lain.

### Integrasi
- `game.js`: settlements + stars + moon + dayCycle dibangun/dipasang; `round.hour` per sortie.
- Jam per round di `config.js`: **7.4 / 15.6 / 11.2 / 18.9 / 21.6** (pagi, siang, tengah hari, senja, malam).
- `haze.patchObject(settlements.group)` supaya aerial perspective kena bangunan.
- API baru: `game.dayCycle`, `game.settlements`, `game.terrain`.

### Scene screenshot baru
`dawn`, `dusk`, `night`, `settlement` — semua render bersih.

---

## Bug yang ditemukan & diperbaiki sesi ini

**1. `sun` adalah handle, bukan mesh.** `dayCycle.apply()` memanggil `sun.position.copy()` padahal `buildSun()` mengembalikan `{sprite, direction, retheme}`. → game gagal boot total. Fix: `sun.sprite.position`, `sun.direction`.
**2. `lights.retheme` tidak ada.** `buildLights` mengembalikan Group dengan `userData.sun`; fungsi yang benar `rethemeLights(group, theme, dir)` dari `sky.js`. Fix: import + panggil dengan `sun.direction`.
**3. Palette siang tidak pernah berubah.** `dayT = clamp((alt-20)/30)` tapi noon cuma 28° → `dayT` selalu 0, jadi jam 6 dan jam 17 menghasilkan warna **identik**. Fix: `dayT = clamp((alt-4)/26)`, `duskT = clamp((alt+10)/20)`, tambah `nightT`.
**4. `sunIntensity` selalu 3.1.** Blok `base[k]` menyalin nilai round menimpa nilai clock. Fix: round hanya boleh pin **weather** (`fog`/`haze`/`hazeWarm`/`hazeStrength`), bukan cahaya.
**5. Works & harbour mustahil ada.** Sampling kandidat `±size*0.36` tapi harbour butuh `edge > size*0.36` → tidak pernah lolos. Fix: sampling `±size*0.46`, harbour `edge > size*0.30`, works cari flatness dengan 12 posisi radial.
**6. Bintang tidak terlihat.** `sizeAttenuation: true` + radius 12 km → sub-piksel. Fix: `sizeAttenuation: false`, `size: 2.1` px, `renderOrder: 1`.
**7. Scene settlement terbang menjauh.** Heading salah: forward = `(sin h, 0, -cos h)` jadi heading ke delta `(dx,dz)` = `atan2(dx, -dz)`, bukan `atan2(dx,dz)+PI`.

---

## Test suite

### `dev-world.mjs` — 11/11 PASS, `WORLD OK`
```
PASS palette differs dawn vs noon    PASS towns exist
PASS palette differs dusk vs noon    PASS works exists
PASS night is dark                   PASS harbour exists
PASS noon is bright                  PASS roads exist
PASS stars only at night             PASS inhabited layer has geometry
PASS moon at night
```

### `dev-systems.mjs` — 17/17 PASS, `SYSTEMS OK`
Kit upgrade (thrust 11.5→12.535, vne 132→136.8) · hold (drift 0, bank −0.001) · course (6/6 gate, no crash) · **approach lands** (230 s, speed 0, onRunway, health 95) · pickup semua berefek (fuel +17.26, repair +16, credits +120, boost).

### `dev-approach.mjs` — 6/6 PASS, `LANDING OK`
```
LANDING: {"landed":true,"wheelsDown":true,"speed":1.35,"health":100,
          "destroyed":false,"onRunway":true,"along":527,"across":0,"headingErr":-0.002}
```

---

## Autopilot approach (sesi sebelumnya, terverifikasi)
Tiga bug diperbaiki:
1. **Salah tanda** `stepApproach` (`-halfLen - along` vs `runwayFrame` yang mengembalikan `along = -s`).
2. **Rock spire di atas runway** — `isClear()` di `obstacles.js` menghitung frame sendiri, offset lateral dilaporkan 442 m di centreline. Sekarang pakai `runwayFrame()`.
3. **Flare mustahil mendarat** — `climb = sin(pitch)×speed`, pitch positif = climb. Sekarang flare mengontrol **sink rate**.

Temuan geometri: 3° straight-in mustahil (landasan 58 m, ridge 211 m di 3 km → margin −449 m). Approach sekarang **direncanakan dari heightfield**, kedua arah runway diskor, path backward dengan batas gradien 15°.

## HUD leak fix
Kartu debrief menampilkan **917** sementara HUD di belakang menampilkan **118** — dua set angka bertentangan. Fix: `drawHud()` return + `hud.clear()` kalau `titleUi.isOpen()`; `ui` jadi setter/getter.

---

## Perintah
```bash
cd /root/flight-game
node serve.ts --port 8080              # dev server (PID 3003532)
node dev-approach.mjs                  # landing
node dev-systems.mjs                   # 17 assertion
node dev-world.mjs                     # 11 assertion (jam + settlements)
SS=2 node dev-shots.mjs /tmp/shots [scene]
# scene: start air cockpit canyon storm home title debrief dawn dusk night settlement
node main.ts                           # build → out/
```

## Lingkungan
- Playwright: `/root/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`
- Arg: `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --no-sandbox`
- SS=2 di swiftshader ~60 s/scene → **selalu background**.
- Noise `bash: /root/.cargo/env: No such file or directory` — tidak berbahaya.

## Sisa pekerjaan
- [ ] Upgrade pesawat lebih lanjut (visual + handling)
- [ ] Musuh AI lebih pintar (interceptor maneuvering)
- [ ] Regenerate 4 screenshot final (≤256 KB each) → commit → push → submit
- [ ] Hapus `dbg-*.mjs` sebelum commit (atau biarkan, tidak masuk bundle)
