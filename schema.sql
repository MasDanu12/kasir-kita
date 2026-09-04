-- Skema database "Kasir HPP" — Cloudflare D1
-- Jalankan lewat: wrangler d1 execute kasir_hpp --remote --file=./schema.sql
-- (atau tempel isi file ini di tab "Console" D1 pada Cloudflare Dashboard)

DROP TABLE IF EXISTS stok_log;
DROP TABLE IF EXISTS transaksi_item;
DROP TABLE IF EXISTS transaksi;
DROP TABLE IF EXISTS produk;
DROP TABLE IF EXISTS resep_bahan;
DROP TABLE IF EXISTS resep;
DROP TABLE IF EXISTS bahan_baku;
DROP TABLE IF EXISTS users;

-- Akun pemilik/pengguna aplikasi
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  nama_usaha TEXT DEFAULT 'Usaha Saya',
  created_at TEXT DEFAULT (datetime('now'))
);

-- Bahan baku dasar (gula, tepung, cup, dsb)
CREATE TABLE bahan_baku (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  nama TEXT NOT NULL,
  satuan TEXT NOT NULL,              -- gr, ml, pcs, dst (satuan terkecil yang dipakai di resep)
  harga_beli REAL NOT NULL,          -- harga beli per kemasan, misal 11000 untuk 1kg
  isi_kemasan REAL NOT NULL DEFAULT 1, -- isi kemasan dalam satuan di atas, misal 1000 (gr)
  harga_per_satuan REAL NOT NULL,    -- hasil hitung = harga_beli / isi_kemasan, dipakai untuk HPP
  stok REAL DEFAULT 0,               -- stok bahan baku (opsional dipakai)
  stok_minimum REAL DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Resep = blueprint komposisi bahan untuk satu produk
CREATE TABLE resep (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  nama TEXT NOT NULL,
  kategori TEXT DEFAULT 'Umum',
  catatan TEXT,
  hasil_pcs REAL NOT NULL DEFAULT 1, -- jumlah pcs yang dihasilkan dari 1 batch/adonan resep ini
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Rincian bahan + qty per resep (untuk hitung HPP otomatis)
CREATE TABLE resep_bahan (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resep_id INTEGER NOT NULL,
  bahan_id INTEGER NOT NULL,
  qty REAL NOT NULL,
  -- 'batch'  = qty untuk 1 kali bikin adonan, biayanya dibagi rata ke "hasil_pcs" resep
  -- 'pcs'    = qty dipakai langsung per 1 pcs (topping/isian), tidak dibagi
  mode TEXT NOT NULL DEFAULT 'batch' CHECK (mode IN ('batch','pcs')),
  FOREIGN KEY (resep_id) REFERENCES resep(id) ON DELETE CASCADE,
  FOREIGN KEY (bahan_id) REFERENCES bahan_baku(id)
);

-- Produk yang dijual di kasir (terhubung ke resep untuk HPP)
CREATE TABLE produk (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  resep_id INTEGER,                  -- boleh NULL kalau produk tanpa resep (HPP manual)
  nama TEXT NOT NULL,
  hpp_manual REAL,                   -- dipakai kalau resep_id NULL
  harga_jual REAL NOT NULL,
  stok REAL DEFAULT 0,
  stok_minimum REAL DEFAULT 0,
  aktif INTEGER DEFAULT 1,
  urutan INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (resep_id) REFERENCES resep(id)
);

-- Satu transaksi kasir (satu struk)
CREATE TABLE transaksi (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  waktu TEXT DEFAULT (datetime('now')),
  total_jual REAL NOT NULL,
  total_hpp REAL NOT NULL,
  total_profit REAL NOT NULL,
  metode_bayar TEXT DEFAULT 'Tunai',
  status TEXT DEFAULT 'selesai',     -- selesai / dibatalkan
  catatan TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Item per transaksi, snapshot harga & HPP saat itu (harga bisa berubah nanti)
CREATE TABLE transaksi_item (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaksi_id INTEGER NOT NULL,
  produk_id INTEGER NOT NULL,
  nama_produk TEXT NOT NULL,
  qty REAL NOT NULL,
  harga_satuan REAL NOT NULL,
  hpp_satuan REAL NOT NULL,
  FOREIGN KEY (transaksi_id) REFERENCES transaksi(id) ON DELETE CASCADE,
  FOREIGN KEY (produk_id) REFERENCES produk(id)
);

-- Riwayat perubahan stok produk (jual, restock, koreksi)
CREATE TABLE stok_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  produk_id INTEGER NOT NULL,
  perubahan REAL NOT NULL,           -- negatif = keluar, positif = masuk
  jenis TEXT NOT NULL,               -- jual / restock / koreksi / batal
  catatan TEXT,
  waktu TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (produk_id) REFERENCES produk(id)
);

CREATE INDEX idx_bahan_user ON bahan_baku(user_id);
CREATE INDEX idx_resep_user ON resep(user_id);
CREATE INDEX idx_produk_user ON produk(user_id);
CREATE INDEX idx_transaksi_user_waktu ON transaksi(user_id, waktu);
CREATE INDEX idx_transaksi_item_transaksi ON transaksi_item(transaksi_id);
CREATE INDEX idx_stok_log_produk ON stok_log(produk_id);
