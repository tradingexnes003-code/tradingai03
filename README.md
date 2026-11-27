# Trading AI Monitor (Forex + Saham AS)

## Pasang di Netlify (tanpa CLI)
1. Buat akun GitHub, buat repo baru (private), upload SEMUA isi folder ini (termasuk folder netlify dan public).
2. Netlify > Add new site > Import an existing project > pilih repo. Biarkan build command kosong.
3. Site configuration > Environment variables, isi:
   - TWELVEDATA_KEY  : key gratis dari twelvedata.com (forex, emas, saham AS)
   - GEMINI_KEY      : key gratis dari aistudio.google.com
   - ANTHROPIC_KEY   : (opsional) key Claude dari console.anthropic.com. Jika diisi, AI memakai Claude (berbayar) dan GEMINI_KEY tidak dipakai.
   - CLAUDE_MODEL    : opsional. Default claude-sonnet-5-5. Untuk lebih murah dan cepat: claude-haiku-5-5.
   - APP_PASSWORD    : password bebas buatan Anda (agar kuota tidak dipakai orang lain)
   - GEMINI_MODEL    : opsional. Default gemini-3.8-flash. Ganti jika nama model berubah.
   - GEMINI_FALLBACK_MODEL : opsional. Model cadangan (mis. gemini-3.5-flash-lite) dipakai pada percobaan ke-3 bila model utama error 503/429.
4. Deploys > Trigger deploy > Clear cache and deploy site.
5. Buka situsnya, klik tombol Password, isi APP_PASSWORD.

## Catatan kuota
Setiap simbol yang dipantau memakai 1 kredit Twelve Data per refresh (hasil di-cache 50 detik).
Saat memakai fallback Twelve Data, paket gratis dibatasi per menit dan per hari: pantau sedikit simbol. Data Exness diprioritaskan ketika MT5 aktif dan tick broker masih segar.
Saham Indonesia (IDX) tidak termasuk paket gratis Twelve Data.

## Acuan H1 + M15 (aturan perkiraan)
- H1 (candle tutup saja) menentukan tren dan sinyal alert: harga vs ALMA(9) dikonfirmasi EMA20/EMA50.
- M15 jadi pemicu entry: pullback ke EMA20 atau zona supply/demand H1, searah tren H1, candle konfirmasi.
- Zona dari swing high/low H1 (panjang 10). SL dari swing M15, TP dari zona lawan terdekat.
- Status SIAP jika tren kuat + pemicu M15 + R:R >= batas di kolom R:R (default 2.5).
- Ini BUKAN salinan script God 62 PERSONAL. ALMA periode 2 pada script asli praktis hanya candle sebelumnya, jadi dipakai ALMA(9).
- Biaya kuota: H1 di-cache 10 menit, M15 ikut interval refresh.

## Plan berbasis zona (versi 2)
- Entry adalah LIMIT di tepi zona demand (buy) atau supply (sell) dari H1, bukan harga live. Level entry, SL, dan TP tetap sama selama candle H1 belum berganti, jadi tidak berubah di setiap refresh.
- Harga live hanya mengubah STATUS: MENUNGGU, DEKAT ENTRY, DI ZONA, SIAP ENTRY (butuh candle konfirmasi M15 dan R:R minimal), RR KECIL, LEMAH, BATAL, SELESAI.
- Plan AI disimpan per simbol di browser dan tidak berubah sampai Anda menekan Analisa AI lagi. Kartu memberi tahu jika candle H1 baru sudah tutup.

## Grafik interaktif
- Tombol "Grafik" di tiap kartu membuka candlestick M15 atau H1 dengan EMA20, EMA50, ALMA9, RSI 14, zona supply/demand, serta garis Entry, SL, TP.
- Memakai pustaka TradingView Lightweight Charts (gratis, dimuat dari cdn.jsdelivr.net, versi 4.2.0).
- Grafik memakai data yang sama dengan kartu (cache server), jadi tidak menambah kredit Twelve Data.

## Analisa H1 dan M15 terpisah, timeframe bisa diatur
- Pilihan "Acuan" (1h, 2h, 4h, 1day) menentukan tren, zona, dan alert. Pilihan "Entry" (5min, 15min, 30min) menentukan timing entry.
- Kartu punya dua blok: Analisa acuan (tren, zona, plan limit) dan Analisa entry (checklist 5 syarat, entry presisi, SL ketat).
- Tombol Analisa dan kamera ada untuk masing-masing timeframe, dan plan AI disimpan terpisah.
- Pilihan timeframe tersimpan di browser. Jangan memantau terlalu banyak simbol karena tiap timeframe memakai kuota data.

## Syarat lengkap (versi 3)
Acuan (H1) punya 8 syarat. Inti: tren kuat, zona valid, ruang ke target dan R:R, pasar aktif. Tambahan: slope EMA50, struktur HL/LH, zona segar, RSI.
H1 disebut LAYAK PANTAU jika 4 syarat inti terpenuhi dan minimal 2 syarat tambahan.
Entry (M15) punya 7 syarat. Inti: harga di zona, konfirmasi kuat, R:R, volatilitas. Tambahan: break struktur mikro, EMA searah, RSI dan momentum.
SIAP ENTRY hanya jika H1 layak pantau dan semua syarat inti M15 terpenuhi. Grade A jika skor 85 ke atas.
Skor = persentase syarat terpenuhi (H1 50 persen, M15 50 persen). Centang "Hanya H1 layak" untuk menyaring pantauan.
Syarat "pasar aktif" membandingkan ATR terbaru dengan rata-rata, sehingga data datar saat pasar tutup tidak lolos.

## Control Tower (versi 4): pemantauan terjadwal, paper trading, winrate, email
Yang baru: file package.json, netlify/lib/tower.js, netlify/functions/monitor.mjs (terjadwal) dan tower.mjs (API dashboard).
Cara kerja: tiap 15 menit (menit ke 2, 17, 32, 47 UTC) fungsi monitor memeriksa simbol yang Anda pilih di dashboard. Posisi hanya SIMULASI (paper), tidak ada order ke broker.
- Email saat acuan H1 mencapai 7/8 syarat, saat inti entry M15 terpenuhi (SIAP ENTRY), saat AI membuka posisi paper, dan saat posisi kena TP, SL, atau habis waktu.
- Posisi ditutup SL lebih dulu jika SL dan TP tersentuh di candle yang sama (hitungan konservatif). Posisi habis waktu setelah 96 candle entry.
- Winrate dihitung TP dibanding SL. Kurva R memakai hasil dalam satuan R (jarak entry ke SL).
Variabel Netlify tambahan: RESEND_KEY (dari resend.com), EMAIL_TO (satu atau beberapa alamat, pisah koma), EMAIL_FROM (wajib berupa domain terverifikasi di Resend bila mengirim ke alamat selain email pemilik akun Resend).
Pemantauan hanya berjalan di deploy produksi. Jika jadwal tidak berjalan di akun Anda, pakai layanan cron gratis (mis. cron-job.org) untuk memanggil alamat-situs/.netlify/functions/tower?run=1 tiap 15 menit dengan header x-app-key berisi APP_PASSWORD.
Data posisi dan riwayat disimpan di Netlify Blobs.

## Email tingkat syarat M15 (versi 4.1)
Email dikirim saat syarat entry M15 naik ke 6/7 dan saat naik ke 7/7. Email berisi syarat yang belum terpenuhi. Hanya terkirim saat melewati ambang (tidak berulang selama tetap di level yang sama). Jika langsung loncat ke 7/7, hanya email 7/7 yang dikirim. Bisa dimatikan lewat kotak centang "Email saat entry 6/7 dan 7/7".

## Modal dan reward dalam rupiah (versi 4.2)
Modal awal default Rp2.000.000 dan risiko per trade default 1 persen, bisa diubah di panel Control Tower (tombol Terapkan modal).
Ukuran risiko tiap posisi = saldo saat dibuka dikali persen risiko. Hasil = R dikali risiko (rupiah), jadi tidak butuh kurs. Saldo bertambah atau berkurang tiap posisi ditutup (majemuk).
Dashboard menampilkan saldo, profit, risiko per trade, max drawdown, kurva saldo, serta risiko dan potensi TP1 untuk tiap plan dan posisi. Email posisi memuat nilai rupiah.
Catatan: simulasi mengasumsikan ukuran posisi bisa persis sesuai risiko. Di broker nyata lot minimum bisa membuat risiko sebenarnya lebih besar dari persen yang dipilih, apalagi untuk modal kecil dan instrumen seperti emas.

## Sumber data Exness (versi 6)
Lihat exness/PANDUAN_EXNESS.md. File baru: netlify/functions/ingest.mjs dan exness/ExnessBridge.mq5. Variabel Netlify baru: DATA_SOURCE, EA_KEY, EXNESS_SUFFIX.


## AI Exness MT5 execution bridge (versi awal, demo-first)
Proyek ini mempertahankan dashboard/analisis yang ada dan menambahkan panel AI Exness MT5, antrean pending LIMIT, endpoint status, dan EA baru `exness/AI_Exness_Bot.mq5`. EA lama `ExnessBridge.mq5` tetap hanya mengirim candle.

### Environment variables tambahan
- `APP_PASSWORD`: password dashboard (wajib untuk endpoint kontrol).
- `EA_KEY`: rahasia acak khusus EA, berbeda dari password Exness.
- `MT5_ORDERS_ENABLED`: default `false`; jangan ubah sebelum EA diuji di akun DEMO.
- `MT5_ALLOW_LIVE`: default `false`; server-side live gate. Tidak ada alasan mengaktifkannya pada tahap uji.
- `GEMINI_KEY` atau `ANTHROPIC_KEY`: untuk analisis AI.
- `TWELVEDATA_KEY`: diperlukan untuk mode `auto` sebagai fallback, atau `twelve`.
- `DATA_SOURCE=auto`: gunakan Exness MT5 saat tick broker segar dan candle lengkap; otomatis fallback ke Twelve Data saat MT5/quote tidak aktif.
- `EA_STALE_MIN=2`: batas umur tick broker sebelum fallback ke Twelve Data (menit).

### Cara kerja order bridge
1. Dashboard meminta analisis AI; hasilnya harus diperiksa manusia.
2. Tombol antre order mengirim pending BUY LIMIT/SELL LIMIT dengan entry, SL, TP, dan risiko (0,05%–5%, mode uji).
3. `mt5-command.mjs` hanya melayani EA yang menyertakan `x-ea-key`. EA mengambil satu perintah dan mengirim ACK.
4. EA menghitung volume berdasarkan equity, entry, SL, tick value melalui `OrderCalcProfit`, dan membulatkan lot ke bawah. Jika lot minimum broker melampaui budget risiko, order ditolak.
5. EA default `EnableExecution=false` dan `AllowLiveAccount=false`; akun non-demo ditolak kecuali input EA sengaja diubah.

### Setup Netlify baru
Import repo GitHub baru (private), deploy folder proyek ini, lalu isi environment variables. Untuk tahap pertama biarkan `MT5_ORDERS_ENABLED=false` dan `MT5_ALLOW_LIVE=false`. Deploy ulang setelah menambah variabel.

### Setup EA
1. Login ke akun Exness MT5 yang sudah ada di komputer Windows. Pastikan akun demo dipakai untuk pengujian.
2. MT5 > File > Open Data Folder > MQL5 > Experts. Salin `AI_Exness_Bot.mq5`, buka di MetaEditor (F4), Compile (F7).
3. Tools > Options > Expert Advisors > Allow WebRequest for listed URL. Tambahkan domain Netlify baru, misalnya `https://nama-site.netlify.app`.
4. Pasang EA pada chart mana saja. Isi `ServerBaseUrl` dengan `https://nama-site.netlify.app/.netlify/functions`, `EaKey` sama dengan `EA_KEY`.
5. Pastikan `EnableExecution=false`, `AllowLiveAccount=false`. Periksa tab Experts dan panel status dashboard.
6. Setelah tes koneksi berhasil, untuk demo saja: set `MT5_ORDERS_ENABLED=true` di Netlify, deploy ulang, lalu ubah `EnableExecution=true` di EA pada akun DEMO. Jangan aktifkan live.

### Batasan dan pengujian wajib
- Versi ini adalah tahap eksekusi terkontrol: AI menganalisis dan pengguna meninjau lalu mengantrekan pending order. Belum ada auto-trading tanpa pengawasan/loop AI berkelanjutan.
- EA memerlukan MT5 desktop, komputer menyala, internet aktif, Algo Trading diizinkan, dan simbol persis seperti Market Watch.
- Protokol perintah memakai polling HTTPS. Satu perintah pending aktif pada satu waktu dan kedaluwarsa setelah 2 menit. EA menggunakan Global Variable terminal sebagai pengaman duplikasi.
- Uji di Strategy Tester untuk logika strategi (WebRequest tidak tersedia di Strategy Tester), lalu uji koneksi dan eksekusi di akun demo. Verifikasi hasil lot dan stop level untuk simbol akun.
- Perangkat lunak ini tidak menjamin profit. Jangan gunakan akun real sebelum audit dan forward-test demo yang memadai.


### Pengaman order MT5 (v4)
Sebelum pending order dikirim, EA memvalidasi quote MT5 terbaru (maksimal 30 detik), spread, jarak entry, stop/freeze level, urutan SL/TP, dan R:R minimum 1,2. Perintah berlaku 60 detik dan ditolak bila terminal MT5 offline/laporan akun basi. Pengaman ini harus diuji pada akun demo; tidak mengaktifkan trading otomatis AI dan tidak menjamin hasil trading.


## Konfigurasi Gold Exness XAUUSD (pembaruan)
- Simbol chart utama: `XAU/USD` di daftar aplikasi, dipetakan ke `XAUUSD` pada EA MT5.
- `EXNESS_SUFFIX` dikosongkan karena nama simbol Market Watch yang dikonfirmasi pengguna adalah `XAUUSD` (tanpa akhiran).
- EA `ExnessBridge.mq5`: `SymbolList=XAUUSD`, `TimeframeList=M5,M15,H1,H4`, `FullBars=300`, `IntervalSec=5`.
- Dashboard refresh default 5 detik. Ini pembaruan polling mendekati real-time; bukan streaming tick tanpa jeda. Data chart bersumber dari Exness ketika tick/candle MT5 segar dan lengkap; `DATA_SOURCE=auto` dapat memakai Twelve Data sebagai fallback.
- EA bridge ini hanya mengirim data, tidak mengeksekusi transaksi. Eksekusi real tetap terkunci dan memerlukan pengujian terpisah.


## Patch v5.1 — daftar simbol terpadu
- Pilihan simbol Control Tower dan Scanner kini disinkronkan ke satu daftar aktif.
- Simbol yang tidak dipilih dinonaktifkan pada watchlist scanner saat konfigurasi Control Tower tersinkron.
- Scanner memproses hanya simbol aktif (maksimal 6) dari seluruh kategori, bukan hanya tab yang sedang dibuka.
- Endpoint candles dan Control Tower menghapus simbol duplikat sebelum diproses.
- Riwayat log lama tidak otomatis dihapus; gunakan Reset jika ingin mengosongkan statistik/log paper trading.

## Eksekusi otomatis ke MT5 dengan pengaman (versi 6)
Fitur ini mengirim order pending LIMIT ke MT5 secara otomatis saat aturan entry Control Tower terpenuhi (skor 70 dan M15 6/7 dengan R:R memenuhi), tanpa persetujuan dan tanpa analisa AI. Semua pengaman di bawah aktif secara bawaan dan berlapis.

Lapisan pengaman:
1. Gerbang server (Netlify): AUTO_TRADE_ENABLED=true, MT5_ORDERS_ENABLED=true, dan untuk akun real MT5_ALLOW_LIVE=true. Jika salah satu tidak true, tidak ada order yang diantrekan.
2. Saklar dashboard: Aktifkan, serta Dry-run (bawaan hidup) yang hanya mencatat order yang akan dikirim.
3. Kill switch: tombol HENTIKAN SEMUA di dashboard, berlaku juga untuk perintah yang sudah antre.
4. Batas rugi harian (bawaan 3 persen dari ekuitas awal hari UTC), dicek di server dan di EA.
5. Batas posisi atau order aktif (bawaan 1), dicek di server dan di EA. Satu perintah pada satu waktu, jeda 120 menit per simbol.
6. Risiko per order dibatasi 0,05 sampai 5 persen ekuitas (mode uji; semula 0,5). EA menghitung lot dan MENOLAK order jika lot minimum broker melebihi anggaran risiko.
7. EA: EnableExecution=false dan AllowLiveAccount=false bawaan, DryRun=true bawaan (validasi penuh tanpa kirim order), pending kedaluwarsa 2 jam, cek spread, umur quote, jarak entry, dan R:R minimum.

Tahap uji yang disarankan di akun real:
A. Dry-run server: Aktifkan + Dry-run di dashboard. Cek log Control Tower (baris AUTO) selama beberapa hari. EA tidak menerima apa pun.
B. Dry-run EA: matikan Dry-run di dashboard, pasang EA dengan EnableExecution=true, AllowLiveAccount=true, DryRun=true. EA memvalidasi dan membalas DRYRUN tanpa order. Cek pesan di tab Experts.
C. Live: hanya setelah A dan B terbukti benar, set DryRun=false di EA. Mulai dengan risiko 0,05 sampai 0,1 persen.
Kode EA belum dikompilasi atau diuji di MT5 oleh penyusun paket ini. Kompilasi sendiri dan periksa hasilnya.

### Brain AI pada eksekusi otomatis (versi 6.1)
Tiap order otomatis diperiksa Brain (Gemini atau Claude) tanpa klik apa pun. Brain hanya bisa menahan order yang sudah lolos semua aturan dan pengaman, dan tidak pernah membuka order sendiri.
Gagal berarti ditahan: jika kunci AI kosong, model tidak tersedia, jaringan error, atau jawabannya bukan JSON yang jelas dengan buka=true, order TIDAK dikirim.
AI hanya dipanggil setelah semua pemeriksaan lain lolos, jadi pemakaian kuota kecil. Dry-run tetap memanggil Brain agar Anda bisa menilai keputusannya.
Pastikan GEMINI_MODEL berisi model yang tersedia (mis. gemini-3.8-flash), kalau tidak semua order akan ditahan.
Brain bisa dimatikan lewat kotak centang di panel Eksekusi otomatis.

## Trading Desk dan gerbang Judge (versi 6.2)
Panel Trading Desk di Control Tower menampilkan empat peran:
- THE EYES: kerucut volatilitas 16 candle ke depan (400 simulasi dari pergerakan candle terakhir) dengan P(naik). Ini gambaran ketidakpastian, bukan prediksi arah.
- THE BRAIN: BUY, SELL, atau HOLD untuk simbol terpilih, tabel suara dari syarat H1 dan M15, serta alasan AI terakhir.
- THE JUDGE: gerbang uang nyata. Order LIVE hanya dikirim jika rekam jejak paper (aturan dan Brain yang sama) lolos semua uji setelah biaya 0,1R per trade: minimal 30 trade, ekspektasi positif, profit factor minimal 1,2, drawdown maksimal 8R, dan tetap positif tanpa trade terbaik.
- THE MEMORY: jumlah candle dibaca, keputusan Brain, eksekusi, winrate, dan deretan hasil trade.
Gerbang Judge menyala bawaan dan dicek di server, bukan hanya di tampilan. Dry-run tidak terkena gerbang. Mematikannya lewat kotak centang "Gerbang Judge" butuh konfirmasi dan ditandai merah di panel.
Agar rekam jejak terkumpul, biarkan "AI memantau" menyala dan "AI boleh open posisi (paper)" tercentang.

## Mode order otomatis (patch risk5-loss25)
Di panel "Eksekusi otomatis ke MT5" ada pilihan **Mode order**:
- **Dekat harga (near)**: perilaku asli. Order dikirim saat syarat inti M15 terpenuhi (SIAP ENTRY). Entry sedikit di bawah/atas harga, SL ketat M15, TP1 dari plan H1.
- **Plan H1 (plan)**: LIMIT dipasang persis di entry/SL/TP1 plan H1 selagi harga belum masuk zona (status MENUNGGU atau DEKAT ENTRY, H1 layak pantau, R:R memenuhi batas). Tidak menunggu konfirmasi M15. Satu plan hanya dievaluasi sekali per status dry-run.
- Di EA v1.30, mode plan memakai `PlanMaxDistancePoints` (default 0 = tanpa batas jarak) dan `PlanExpirySeconds` (default 14400 = 4 jam). Pemeriksaan lain tetap berlaku: quote segar, spread, sisi LIMIT terhadap Ask/Bid, stop/freeze level, R:R minimum, risiko, lot minimum, batas rugi harian, jumlah posisi aktif.
- Catatan: bukti rekam jejak Judge berasal dari paper trade mode near. Mode plan belum punya rekam jejak sendiri.

## Kelas syarat dan AI opsional (patch modes2)
- **Kelas syarat** (panel Eksekusi otomatis): Rendah = H1 minimal 5/8 dan M15 4/7; Sedang = 6/8 dan 5/7; Tinggi = 7/8 dan 6/7 (default); Skor = skor minimal (kolom "Skor min", default 70).
- Kelas berlaku untuk mode "dekat harga" dan posisi paper (H1 dan M15 sama-sama dinilai). Di mode "Plan H1" hanya H1 yang dinilai karena LIMIT dipasang sebelum harga masuk zona; pada kelas Skor, skor dihitung dari H1 saja (H1 ok / 8 x 100).
- **Brain AI tidak lagi memblokir order saat AI gagal.** Jika kunci AI kosong atau panggilan gagal (HTTP error, timeout, balasan bukan JSON), order lanjut sesuai aturan dan alasan kegagalan ditulis di log (baris BRN). AI hanya menahan order bila benar-benar menjawab "tolak". Untuk mematikan AI sepenuhnya, hapus centang "Brain AI menyetujui tiap order" lalu Terapkan.
- Mengganti kelas mengubah populasi trade paper yang dinilai Judge; riwayat lama tidak direset.

## Pembaruan v14c

- **Dashboard = Control Tower.** Keduanya kini menghitung M15 dari candle yang SUDAH TUTUP (candle berjalan dibuang), dan dashboard ikut memakai pengaturan "Entry M15 N/7" dari Control Tower. Sebelumnya dashboard memakai candle berjalan dan selalu minta 6/7 di server, sehingga angkanya (5/7) berbeda dari Control Tower (4/7) dan entry tidak pernah terkunci.
- **Entry terkunci dibiarkan terbuka.** Saat syarat M15 terpenuhi, entry/SL/TP dikunci dan tetap tampil (🔒) sampai ada plan H1 baru, kena SL/TP, atau arah berbalik. Syarat yang menghilang di candle berikutnya tidak mencabut kunci.
- **Opsi baru "Saat M15 siap → Langsung masuk (market)".** Paper: posisi dibuka di harga sinyal. Real: perintah MARKET ke EA. Satu kali per entri (tidak masuk ulang karena syarat berkedip); setelah posisi selesai TP/SL boleh masuk lagi di plan yang sama bila syarat M15 terpenuhi lagi. Semua gerbang real tetap berlaku (AUTO_TRADE_ENABLED, MT5_ORDERS_ENABLED, dry-run, kill switch, batas rugi harian, Judge, Brain).
- **EA v1.50 wajib dipasang ulang** agar mengerti perintah MARKET. Input baru `MarketMaxDriftPoints` (0 = nonaktif).

## Pembaruan v14d: mode risiko "biaya SL"

- Eksekusi otomatis punya pilihan **Mode risiko**: `% ekuitas` (lot dihitung, perilaku lama) atau `biaya SL` (lot minimum broker).
- Mode biaya SL: order boleh masuk selama kerugian jika SL kena (jarak SL x nilai per poin x lot minimum) tidak melebihi **Maks biaya SL % ekuitas** (default dan maksimum 50). Persentase "Risiko %/order" tidak dipakai di mode ini.
- Tabel "Cek lot per simbol" menampilkan hitungan lengkap: biaya SL per posisi, ekuitas, ekuitas yang dibutuhkan, dan **kurang berapa** untuk bisa open.
- Brain AI tetap menilai kualitas setup, tetapi tidak menolak hanya karena besar biaya SL.
- Pengaman yang tetap ada: Judge gate, dry-run, kill switch, batas rugi harian, cek margin bebas di EA, dan batas spread EA (`MaxSpreadPctOfSL`).
- EA v1.60: pasang ulang. Input baru `MaxSlCostPct` (plafon keras di sisi EA, default 50).

## Pembaruan v14f: paper ikut mode biaya SL

- Control Tower punya pilihan **Risiko paper**: `% saldo` (lama) atau `biaya SL` (sama dengan real).
- Mode biaya SL di paper: lot minimum dari spesifikasi EA, biaya SL = jarak SL x nilai per poin x lot min, dibandingkan dengan saldo simulasi. Trade dilewati bila melebihi **Maks biaya SL % saldo** (maks 50). Untung/rugi paper dihitung dari biaya SL itu (1R = biaya SL), bukan dari persen risiko.
- Butuh EA online (spesifikasi simbol dikirim EA). Tanpa itu paper di mode ini dilewati dengan pesan jelas.
- Untuk meniru akun real, set modal simulasi sama dengan ekuitas MT5.

## Pembaruan v14g: paper "Samakan dengan real"

- Control Tower punya pilihan **Paper → Samakan dengan real**. Saat aktif, paper memakai pengaturan eksekusi real: mode order, kelas syarat, skor minimum, mode risiko (% atau biaya SL), plafon biaya SL, risiko %/order, dan maks posisi.
- Aturan lot dan risiko meniru EA: lot dibulatkan ke bawah sesuai anggaran, lot minimum hanya boleh jika risikonya di bawah plafon, dan trade ditolak bila spread > 15% dari SL.
- Saldo simulasi dimulai dari ekuitas MT5 saat opsi ini pertama kali diaktifkan (kecuali Anda sudah mengubah kolom Modal awal pada saat yang sama). Modal awal tetap bisa diedit kapan saja.
- Perbedaan yang tetap ada: paper tidak mensimulasikan spread/slippage saat terisi, dan tidak terkena kill switch, Judge, Brain real, batas rugi harian, atau cek margin.

## Pembaruan v14i

- Mode "M15 siap → langsung masuk" tidak lagi dimintai persetujuan Brain AI (paper dan real). Ambang N/7 M15 adalah aturan pemilik; syarat "inti" atau sentuhan zona H1 tidak dipakai sebagai alasan menolak. Gerbang lain tetap berlaku: kelas syarat, biaya SL dan lot, spread, Judge, dry-run, kill switch, batas rugi harian.
- Di mode M15 tanpa "langsung masuk", Brain tetap dipakai tetapi diberi tahu aturan N/7 itu.

## Pembaruan v14j: akses pemilik vs pengunjung

- **Pengunjung (tanpa password):** dashboard, harga, analisa kode, dan simulasi (paper) bisa dilihat. Simulasi tetap berjalan otomatis lewat jadwal. Semua yang berkaitan dengan akun real disembunyikan: panel MT5, eksekusi otomatis, ekuitas/saldo MT5, order real, dan baris log yang menyangkut real/MT5/auto.
- **Pemilik (APP_PASSWORD):** semua fitur: ubah pengaturan, jalankan AI, Analisa AI, kontrol akun real, kill switch. Klik tombol Password di dashboard.
- Tanpa APP_PASSWORD terkonfigurasi tidak ada pemilik: semua kontrol tertutup.
- `PUBLIC_VIEW=false` di Netlify menutup juga tampilan untuk pengunjung (semua wajib password).
- Penguncian proses: Control Tower tidak berjalan dua kali bersamaan (mencegah order ganda saat jadwal dan klik manual bertumpuk).

## Pembaruan v14k: email

- EMAIL_TO boleh berisi beberapa alamat (pisah koma). Tiap alamat dikirim terpisah.
- Tombol Tes email menampilkan alasan sebenarnya dari Resend, dan log memuat "email gagal: ..." bila pengiriman otomatis gagal.
- Pengirim bawaan Resend (onboarding@resend.dev) hanya bisa mengirim ke email pemilik akun Resend. Untuk alamat lain: verifikasi domain di resend.com/domains, lalu isi EMAIL_FROM.

## Pembaruan v14l: syarat H1 dan M15 DIGANTI dengan komponen God 62 PERSONAL

Sumber script tidak bisa dibuka; dasarnya INPUT dari screenshot (ALMA 2/5/0.85, TIMEFRAME 15m, Multiplier 8, Swing 10, Box Width 2.5, S/R Strength 2, BOTH). Pemetaan syarat ke komponen adalah tafsiran. Ukuran order 10% ekuitas God 62 tidak dipakai.
- ARAH plan = sinyal God 62 (ALMA2 close vs open, TF 15m x8 = 2 jam, candle tutup). EMA20/50 dan RSI tidak lagi dipakai sebagai syarat.
- Zona supply/demand: swing 10, tebal = ATR(50) x 2.5/10, batal saat CLOSE menembus (BOS).
- H1 (8): arah God 62, zona valid, ruang/R:R, pasar aktif, BOS searah, struktur HL/LH, zona segar, level S/R di zona.
- M15 (7): harga di zona H1, sinyal God 62 searah baru berbalik (maks 2 bucket), R:R, volatilitas, BOS M15, warna bar God 62 M15, level S/R dekat harga.
- Jumlah syarat tetap 8 dan 7 agar ambang N/7, kelas syarat, dan UI tetap jalan. Konstanta ada di `G62` pada core.js.
- `node tools/backtest.js data_M15.csv` membandingkan acuan H1 + entry M15 dengan acuan H4 + entry H1 dan pembanding God 62 murni. Perlu data MT5 asli.

### v14l: keluar mengikuti God 62 (stop-and-reverse)
- God 62 memakai Initial SL = 0 dan Initial TP = 0; posisi ditutup saat sinyal berlawanan muncul. Aplikasi sekarang meniru ini (env `EXIT_G62`, default aktif; isi `false` untuk kembali ke TP zona).
- Paper: posisi ditutup di harga candle tutup saat arah God 62 berbalik (hasil bertanda `G62`). Batas waktu 96 candle dinonaktifkan (pengaman 1000 candle). Win rate menghitung keluar G62 sebagai menang bila R > 0.
- Real: server mengirim perintah `CLOSE` ke EA saat arah berbalik (diulang tiap 10 menit bila belum tertutup). Pending order yang belum terisi tetap dibatalkan saat arah berbalik (jalur lama).
- SL tetap pelindung di balik zona (rumus lama, pelebaran 2x). EA mewajibkan TP, jadi TP dipasang jauh = `G62_TP_FAR_R` x jarak SL (default 10) sebagai pengaman. Level TP zona asli ada di `tpRef` dan tetap dipakai untuk R:R, jadi angka R:R di dashboard adalah ke zona, bukan ke TP jauh.
- EA v1.70 (WAJIB dipasang ulang dan di-compile): perintah CLOSE menutup posisi bermagic number EA untuk simbol itu. Dengan `DryRun=true` hanya validasi. Kode EA belum dikompilasi/diuji di MT5 oleh penyusun paket ini.
- `node tools/backtest.js data.csv` mengikuti aturan keluar ini; `--exit=tp` untuk membandingkan dengan TP zona.

## Pembaruan v14m: spesifikasi simbol dari EA

- EA v1.71 melaporkan spesifikasi lot untuk simbol di `SpecSymbols` DAN semua simbol yang tampil di Market Watch (maks 40). Simbol baru yang dipantau (mis. GBPUSDm, USDJPYm) tidak perlu lagi didaftarkan manual.
- Server menampung hingga 40 spesifikasi (sebelumnya 12).
- Pesan "dilewati" sekarang menyebut simbol yang dicari, simbol apa saja yang benar-benar dilaporkan EA, dan umur laporan terakhir.

## Pembaruan v14n: M15 Lab (bandingkan plan H1 vs M15, terpisah dari real)

- File baru: `netlify/lib/lab.js`, `netlify/functions/lab.mjs`; panel "🧪 M15 Lab" di dashboard (di bawah Control Tower). Perubahan kecil lain: `monitor.mjs` dan `tower.mjs` memanggil lab setelah Control Tower (dibungkus try/catch), dan `tower.js` hanya menambah ekspor helper. Logika H1, Control Tower, paper trading lama, dan eksekusi MT5 TIDAK diubah.
- Lab memakai penyimpanan sendiri (Netlify Blobs store `lab`). Tidak ada order, tidak memakai kill switch/Judge/Brain, tidak menulis ke state Control Tower. Reset lab hanya menghapus data lab.
- Satu pemindaian `god()` per simbol dipakai bersama semua profil, jadi tidak menambah kuota data. Berjalan di jadwal yang sama (menit 2, 17, 32, 47) dan hanya memproses candle M15 baru.
- Empat plan M15 berjalan paralel (bisa dimatikan/diubah dari dashboard): ASIS (aturan sekarang, pembanding), TP2 (entry sama, keluar TP 2R + BE di +1R), ZONA (LIMIT di tepi zona H1, wajib candle penolakan, sesi aktif), SELEKTIF (M15 7/7, H1 7/8, ada ruang ke target H1, sesi, jeda setelah rugi).
- Tabel perbandingan: jumlah trade, winrate + batas bawah interval 95%, ekspektasi (R/trade), profit factor, max drawdown, WR 20 terakhir, dan status. Baris H1 dan M15 Control Tower hanya DIBACA sebagai pembanding (R dikurangi biaya spread yang sama).
- Semua angka dalam R setelah biaya spread (dari spesifikasi EA bila ada, selain itu biaya tetap). Jam sesi mengikuti stempel waktu candle sumber data, cek apakah itu waktu broker atau UTC.
- Batas simulasi: tidak ada slippage dan swap; bila SL dan TP tersentuh di candle yang sama dihitung SL; BE aktif mulai candle berikutnya. Di bawah 30 trade per plan belum bisa disimpulkan.

## Pembaruan v14q: perbaikan sumber data M15 Lab
- Bug: lab tidak mengarahkan `core` ke penyimpanan data EA, sehingga `pickSource` selalu memilih Twelve Data (terutama pada tombol "Jalankan lab sekarang", yang berjalan di fungsi terpisah). Diperbaiki dengan `core.setStore(tstore)` di `runLab`.
- Opsi baru "hanya data Exness" (default aktif): simbol yang data Exness-nya belum segar DILEWATI dengan alasan di panel, tidak jatuh ke Twelve Data. Mencegah campuran dua feed harga dan pemakaian kuota Twelve Data oleh lab.
- Setelah deploy, tekan "Reset lab" sekali: pembatalan plan yang terjadi saat lab memakai feed Twelve Data tidak mewakili data Exness.

## Pembaruan v14r: 10 plan M15 tambahan di M15 Lab (hanya simulasi)
- Total 14 plan di lab. Baru: RETEST (break level swing M15 lalu retest), RETEST-H1 (level swing H1), PINBAR-SR (penolakan di support/resistance), VOL-IKUT (ikut candle volume besar), VOL-RETEST (LIMIT di 50% candle impuls), VOL-ZONA (volume besar di zona H1), EMA-PULLBACK dan BREAKOUT20 (arah dari EMA H1, tanpa God 62), ASIS-TP1.5, ASIS-TRAIL (SL mengekor).
- Status "layak dilanjutkan" kini wajib: >=30 trade, PF >= 1.2, batas bawah WR >= 35%, >= 3 simbol, dan ekspektasi positif di kedua paruh periode (mengurangi risiko memilih plan yang kebetulan bagus).
- Volume: EA ExnessBridge v1.11 mengirim tick volume sebagai elemen ke-6 tiap bar (server tetap menerima format lama 5 elemen). Selama EA lama, plan VOL-* memakai range candle sebagai pengganti volume (ditandai "pengganti (range)" di panel). Pasang ulang EA untuk volume asli.
- File baru: `netlify/lib/labsig.js`. Logika H1, Control Tower, dan akun real tidak diubah.

## Pembaruan v14s: Uji Trading God62 Baru (stop-and-reverse, simulasi)
- Meniru trade strategy TradingView "God 62 PERSONAL" (ALMA 2, Sigma 5, Offset 0.85, 15 menit x 8, BOTH): selalu ada posisi; masuk di harga saat God 62 berbalik, keluar saat berbalik lagi. Tiga varian di M15 Lab: GOD62-BARU (tanpa SL, persis TradingView), GOD62-BARU+SL (SL keras 3 ATR), GOD62-BARU+TREN-H1 (hanya flip searah EMA20/50 H1).
- 1R virtual = riskAtr x ATR(14) M15 (default 3), hanya agar bisa dibandingkan dengan plan lain. Dilaporkan juga % per trade (bruto), rata-rata menang/rugi, total %, hasil per simbol, posisi berjalan, dan daftar trade terakhir untuk dicocokkan dengan TradingView.
- Masuk hanya pada pembalikan yang terlihat lab (tidak menebak posisi sebelum lab jalan). Flip yang terlewat karena data terputus >45 menit tidak dikejar.
- Rumus God 62 di kode masih dugaan dari input indikator; cocokkan arah dan jam flip dengan Daftar trade TradingView.

## Pembaruan v14t: 10 varian God62 Baru + proyeksi modal

Tiga varian lama (GOD62-BARU, +SL, +TREN-H1) TIDAK diubah; perilakunya diuji identik dengan sebelumnya. Sepuluh varian baru, semuanya dengan SL keras (EA MT5 mewajibkan SL), 1R virtual = riskAtr x ATR(14) M15. Tiap varian menguji satu gagasan:

| Varian | Gagasan |
|---|---|
| GOD62-BARU+SL2 | SL lebih rapat, 2 ATR |
| GOD62-BARU+BE | geser SL ke impas setelah +1R |
| GOD62-BARU+TRAIL | SL mengekor 1.5 ATR setelah +1R |
| GOD62-BARU+TP3R | TP 3R atau berbalik, mana lebih dulu |
| GOD62-BARU+TP1.5R | SL 2 ATR, TP 1.5R atau berbalik |
| GOD62-BARU+KONFIRMASI | masuk bila arah bertahan 2 candle setelah flip |
| GOD62-BARU+TREN-KUAT | lewati flip saat pasar sideways (efisiensi Kaufman 20 candle < 0.30) |
| GOD62-BARU+SESI | hanya masuk jam data 07-20 |
| GOD62-BARU+VOLUME | hanya flip dengan volume >= 1.3x rata-rata |
| GOD62-BARU+KOMBO | konfirmasi 1 + non-sideways + sesi + SL 2.5 ATR + impas |

- Panel baru **Proyeksi jika memakai modal Anda**: isi modal dan risiko % per trade; dashboard menampilkan profit (Rp), return, max drawdown, dan kurva modal tiap varian, diurutkan dari hasil terbaik. Dihitung dari R bersih (setelah biaya spread) dengan risiko tetap, digabung.
- Tabel kelayakan: biaya SL (3 ATR, lot minimum) per simbol dibanding risiko per trade, supaya jelas simbol mana yang tidak muat di modal Anda.
- Lab menyimpan ATR terakhir per simbol dan menampilkan spesifikasi lot dari EA.
- Semua tetap simulasi (tidak ada order real). Penting: menguji banyak varian pada sinyal yang sama menaikkan risiko tampak bagus karena kebetulan; gunakan syarat >= 30 trade, >= 3 simbol, positif di kedua paruh periode.

## Pembaruan v14u: 30 varian turunan, history per varian, uji mundur CSV

Dari hasil uji maju (TRAIL +7.5% dan TP1.5R +5.2% pada 27 trade; sisanya negatif), varian yang tidak lolos (+SL2, +BE, +TP3R, +KONFIRMASI, +TREN-KUAT, +SESI, +VOLUME, +KOMBO) dihapus dan diganti **30 varian turunan** dari dua acuan itu. Acuan (GOD62-BARU+TRAIL, GOD62-BARU+TP1.5R) dan tiga pembanding awal (GOD62-BARU, +SL, +TREN-H1) tidak diubah.

- **Keluarga TRAIL (15)**: jarak trailing 1.0 sampai 2.0 ATR, titik mulai 0.5 sampai 1.5R, SL 2 sampai 4 ATR, plus satu penambah per varian (impas +0.7R, filter tren H1, filter pasar sideways, TP 4R).
- **Keluarga TP1.5R (15)**: TP 1.0 sampai 2.5R, SL 1.5 sampai 3 ATR, plus satu penambah per varian (impas +0.8R, filter H1, filter sideways, trailing).
- **History per varian**: klik 📜 di panel Proyeksi untuk melihat trade tiap varian (masuk, keluar, simbol, arah, entry, exit, %, R bersih, MFE, hasil), posisi terbuka, dan tombol unduh CSV. Trade mencatat MFE/MAE (keuntungan/kerugian terbesar yang sempat tercapai, dalam R).
- **P(edge)**: peluang rata-rata R per trade benar-benar di atas nol (bootstrap 400 kali, deterministik). Hijau >= 90%, kuning 70-89%, merah di bawahnya.
- **Uji maju bersih**: hanya trade setelah versi ini terpasang. Varian turunan dipilih setelah melihat data lama, jadi hasil lama tidak bisa dipakai sebagai bukti.
- **Lab berjalan tiap 5 menit** (fungsi `labmon`), bukan hanya menit 02/17/32/47, supaya flip, TP, dan trailing terdeteksi lebih cepat setelah candle tutup.
- **Uji mundur cepat**: `node tools/flip_lab.js BTCUSDm.csv ETHUSDm.csv XAUUSDm.csv` menjalankan SEMUA varian pada data historis MT5 (mesin yang sama dengan lab). Data dibagi BELAJAR dan UJI menurut waktu; varian yang bagus di BELAJAR tetapi jelek di UJI adalah kebetulan. Semua trade disimpan ke CSV. Pakai minimal ~3 bulan data M15 per simbol.
