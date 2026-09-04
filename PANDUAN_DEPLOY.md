# Panduan Deploy — Kasir HPP (tanpa laptop/terminal)

Aplikasi ini adalah **PWA** (bisa di-"Add to Home Screen" seperti app), berjalan di **Cloudflare Workers + D1**, sama seperti pola Dompetku yang sudah kamu pakai. Semua langkah bisa dari HP lewat Cloudflare Dashboard.

## 1. Upload ke GitHub
Buat repo baru, upload semua isi folder ini (`worker.js`, `wrangler.toml`, `schema.sql`, folder `public/`).

## 2. Buat database D1
1. Buka **dash.cloudflare.com** → **Workers & Pages** → **D1**.
2. Klik **Create database**, beri nama `kasir_hpp`.
3. Buka tab **Console** database tersebut, tempel isi `schema.sql`, jalankan.
4. Salin **Database ID** yang muncul.

## 3. Buat Worker & hubungkan ke GitHub
1. **Workers & Pages** → **Create** → **Workers** → hubungkan ke repo GitHub tadi.
2. Cloudflare otomatis mendeteksi `wrangler.toml`.
3. Di pengaturan Worker, buka **Settings → Variables**:
   - Tambahkan **D1 Database binding**: nama `DB`, pilih database `kasir_hpp` (ini menggantikan `database_id` placeholder di `wrangler.toml`).
   - Tambahkan **environment variable** `JWT_SECRET` dengan teks acak panjang (contoh: kombinasi huruf-angka 40 karakter, buat sendiri, jangan dibagikan).
4. Deploy.

## 4. Buka aplikasi & daftar akun
1. Buka URL Worker kamu (contoh `kasir-hpp.<nama>.workers.dev`) di browser HP.
2. Tap tab **Daftar Usaha Baru**, isi email, password, dan nama usaha.
3. Di menu browser, pilih **Add to Home Screen** — aplikasi akan muncul seperti app biasa dengan ikon sendiri.

## Alur pakai sehari-hari
1. **Racik → Bahan Baku**: input semua bahan baku beserta harga beli per satuan.
2. **Racik → Resep**: susun resep dari bahan baku + qty — HPP terhitung otomatis.
3. **Racik → Produk Jual**: hubungkan resep ke produk yang dijual, atur harga jual & stok awal.
4. **Kasir**: tap produk untuk transaksi, sistem otomatis mengurangi stok dan mencatat HPP + profit.
5. **Laporan**: pantau omzet, HPP, profit, margin, dan produk terlaris per periode.
6. **Profil**: backup data berkala (unduh JSON), aktifkan mode gelap jika perlu.

## Catatan
- Gratis di Cloudflare free tier (Workers + D1 free tier cukup untuk skala UMKM).
- 1 akun = 1 usaha. Kalau mau multi-cabang/multi-usaha, tiap usaha daftar akun terpisah.
- Password di-hash (PBKDF2), sesi pakai token JWT — tidak ada data sensitif tersimpan polos.
