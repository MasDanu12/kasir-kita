# Panduan Deploy — Kasir HPP v2 (tanpa laptop/terminal)

Struktur v2: **Master Bahan Baku → Master Resep → Varian Menu → Kasir**. Ini rombakan total dari versi sebelumnya — kalau sudah pernah deploy versi lama, jalankan ulang `schema.sql` (data lama akan hilang, drop total).

## 1. Upload ke GitHub
Timpa isi repo dengan semua file di paket ini (`worker.js`, `wrangler.toml`, `schema.sql`, folder `public/`).

## 2. Jalankan schema.sql di Console D1
Buka **dash.cloudflare.com** → **Workers & Pages** → **D1** → database `kasir_hpp` → tab **Console**. Tempel isi `schema.sql`, jalankan. (Kalau Console menolak banyak perintah sekaligus, minta potongan per tabel — saya bisa kirim ulang di chat.)

## 3. Deploy Worker
Worker yang sudah terhubung ke GitHub akan otomatis re-deploy begitu kamu push perubahan. Pastikan binding `DB` (D1) dan variabel `JWT_SECRET` di Settings Worker masih ada seperti sebelumnya.

## 4. Buka aplikasi
Data lama (bahan/resep/produk versi sebelumnya) **tidak ikut pindah**. Mulai input dari awal sesuai urutan berikut.

## Alur pakai — 3 Tahap

**1. Racik → Bahan Baku**
Input semua bahan (adonan, topping, maupun kemasan) sesuai kemasan asli beli:
- Nama, kategori (Bahan Adonan / Topping / Kemasan)
- Ukuran kemasan (angka + satuan: Gram/Kg/Mililiter/Liter/Pcs) — otomatis dikonversi ke gram/ml/pcs
- Harga beli per kemasan itu → harga per satuan otomatis muncul

**2. Racik → Master Resep**
Susun resep dasar dari Bahan Adonan:
- Pilih bahan + jumlah pemakaian (misal Terigu 1000gr, Minyak 200ml, Telur 2pcs, Susu 60gr)
- Isi **Total berat adonan jadi** (gram) — ini hasil timbangan asli setelah adonan matang, bukan hasil jumlah otomatis, karena ada penyusutan saat diolah
- HPP per gram otomatis muncul = Total biaya bahan ÷ Total berat

**3. Racik → Varian Menu**
Turunkan varian rasa dari Master Resep:
- Pilih Master Resep + berat adonan dipakai per pcs (gram)
- Tambah topping/kemasan (boleh lebih dari satu, misal Meses + Keju)
- HPP Final otomatis = biaya adonan + topping. Isi harga jual → margin langsung kelihatan
- Stok menempel di sini (bukan di resep)

**4. Kasir**
Tinggal tap Varian Menu yang sudah jadi. Stok otomatis berkurang tiap transaksi.

**5. Laporan**
Omzet, HPP, profit, margin per periode + varian terlaris.

## Kalau harga bahan berubah
HPP di Master Resep dan Varian Menu itu **snapshot** (dibekukan saat disimpan) — tidak otomatis berubah kalau kamu update harga bahan. Kalau ada perubahan harga:
- Baris resep/varian yang terdampak akan ada tanda **⚠ harga bahan berubah**
- Tekan tombol **"↻ Hitung ulang"** di form Master Resep atau Varian Menu untuk update HPP pakai harga terbaru
- Transaksi kasir yang sudah lewat tidak berubah HPP-nya (laporan laba historis tetap akurat)

## Catatan
- Gratis di Cloudflare free tier
- 1 akun = 1 usaha
- Password di-hash (PBKDF2), sesi pakai token JWT
