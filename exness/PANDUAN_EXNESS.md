# Sumber data Exness lewat MT5 (tanpa kredit Twelve Data)

EA ExnessBridge.mq5 membaca candle dari MT5 Anda (akun Exness) dan mengirimnya ke aplikasi. EA ini hanya membaca, tidak membuka order.
MT5 harus menyala terus (PC atau VPS) selama pemantauan berjalan.

## 1. Atur Netlify (Site configuration > Environment variables)
- DATA_SOURCE = exness   (hanya data EA, tanpa kredit Twelve Data). Pilihan lain: auto (EA dulu, jika kosong pakai Twelve Data), twelve (seperti semula).
- EA_KEY = kata sandi acak panjang buatan Anda (bukan password akun Exness). Isi yang sama di EA.
- EXNESS_SUFFIX = akhiran simbol akun Anda, mis. m (XAUUSDm). Kosongkan jika simbol tanpa akhiran. Dengan ini daftar EUR/USD, XAU/USD di aplikasi otomatis dibaca sebagai EURUSDm, XAUUSDm.
Lalu deploy ulang (Clear cache and deploy site).

## 2. Pasang EA di MT5
1. MT5: File > Open Data Folder > MQL5 > Experts, salin ExnessBridge.mq5 ke sana. Buka MetaEditor (F4), buka file itu, tekan Compile (F7). Pastikan 0 error.
2. MT5: Tools > Options > Expert Advisors > centang Allow WebRequest for listed URL > tambahkan https://NAMA-SITUS-ANDA.netlify.app
3. Seret ExnessBridge dari Navigator ke satu chart mana saja. Untuk konfigurasi Gold pengguna ini, isi SymbolList = XAUUSD dan TimeframeList = M5,M15,H1,H4. Pastikan nama persis sama dengan Market Watch. Isi juga ServerUrl (alamat situs + /.netlify/functions/ingest) dan EaKey. EA mengirim pembaruan setiap 5 detik; ini polling mendekati real-time, bukan streaming tick tanpa jeda.
4. Tab Experts di MT5 harus tidak menampilkan error. EA tidak memakai fungsi trading, tombol Algo Trading biasanya boleh mati. Jika data tidak masuk, coba nyalakan.

## 3. Periksa
Buka aplikasi dan tekan Perbarui. Jika muncul "Belum ada data EA", cek nama simbol dan EXNESS_SUFFIX. Jika muncul "Data EA basi", MT5 atau EA berhenti.
Timeframe Acuan dan Entry di aplikasi harus ada di TimeframeList EA (1h = H1, 15min = M15, 5min = M5, 4h = H4). Untuk nama simbol akun pengguna XAUUSD, kosongkan EXNESS_SUFFIX di Netlify.
Jam candle mengikuti waktu server Exness.

## Mode auto: Exness bila MT5 aktif, Twelve Data bila tidak
Isi DATA_SOURCE = auto (direkomendasikan). Aturannya:
- Satu simbol memakai SATU sumber untuk semua timeframe. Exness dipakai hanya jika timestamp tick broker dari MT5 berumur maksimal 2 menit (bisa diubah dengan EA_STALE_MIN) dan data candle lengkap untuk semua timeframe yang diminta. Jika tick berhenti, terminal/EA mati, data tidak lengkap, atau koneksi putus, sistem beralih ke Twelve Data. Jika tidak, simbol itu memakai Twelve Data.
- Kartu dan grafik menampilkan sumber yang dipakai (Exness MT5 atau Twelve Data fallback). Dashboard dapat diatur refresh 5 detik; EA bridge mengirim update setiap 5 detik. Ini polling mendekati real-time, bukan streaming tick tanpa jeda.
- Saat MT5/quote broker tidak aktif, kredit Twelve Data terpakai lagi (sesuai cache dan refresh aplikasi). Hitung kredit dengan simbol seperlunya.
- Harga kedua sumber bisa berbeda tipis. Saat sumber beralih, zona dan level plan bisa bergeser sedikit, dan posisi paper yang terbuka dihitung dengan sumber yang sedang aktif.


## AI_Exness_Bot.mq5 — pending-order bridge (preflight keselamatan)
File `AI_Exness_Bot.mq5` terpisah dari `ExnessBridge.mq5`. Bridge lama hanya mengirim candle; EA baru mengambil perintah pending LIMIT dari Netlify dan melaporkan akun.

- Default `EnableExecution=false`: tidak akan mengirim order.
- Default `AllowLiveAccount=false`: menolak akun REAL/CONTEST.
- Order yang didukung: BUY LIMIT dan SELL LIMIT, dengan SL dan TP wajib.
- Sebelum mengirim order, EA memeriksa quote MT5 maksimal berumur 30 detik, spread, jarak entry dari harga terbaru, stop/freeze level broker, urutan SL/TP, dan R:R minimal 1,2. Jika harga terlalu jauh (indikasi feed berganti atau analisa basi), perintah ditolak dan analisa harus dibuat ulang.
- Perintah kedaluwarsa dalam 60 detik; server juga menolak antrean bila MT5 offline atau laporan akun tidak segar.
- Batas awal: `MaxEntryDistancePoints=500`, `MaxQuoteAgeSeconds=30`, `MaxSpreadPoints=100`, `MinRiskReward=1.20`. Sesuaikan hanya setelah diuji pada simbol dan akun demo Anda.
- Risiko input dibatasi maksimal 0,50% equity; lot dihitung EA dari estimasi kerugian 1 lot sampai SL dan dibulatkan ke bawah. Jika lot minimum broker terlalu besar, order ditolak.
- Backend juga default terkunci melalui `MT5_ORDERS_ENABLED=false`.
- Tahap ini memerlukan review manual atas hasil AI. Jangan aktifkan live trading. Pemeriksaan ini adalah pengaman tambahan, bukan jaminan profit atau pengganti pengujian demo.

- Lot minimum vs anggaran risiko: jika lot minimum broker membuat risiko melebihi anggaran, EA memakai lot minimum selama risiko aktual masih di bawah `MaxRiskPctWithMinLot` (default 6%, hanya jika `AllowMinLotOverBudget=true`). Di atas plafon itu order ditolak dengan pesan yang menyebut risiko aktual lot minimum. ACK menampilkan risiko aktual setiap order.
- Cek lot di dashboard: EA melaporkan lot minimum, nilai per poin, dan spread untuk simbol di input `SpecSymbols` (isi persis seperti Market Watch, mis. `BTCUSDm,BNBUSDm,XAUUSDm`). Dashboard menampilkan per simbol apakah order MUAT, memakai LOT MIN, atau DITOLAK, berdasarkan SL plan aktif dan ekuitas akun.
