-- Skema database "Kasir HPP" — versi 2 (Bahan Baku → Master Resep → Varian Menu)
-- Cloudflare D1. Jalankan lewat Console D1 di Cloudflare Dashboard.
-- PERINGATAN: ini struktur baru total, data lama (resep/produk versi 1) tidak ikut pindah.

DROP TABLE IF EXISTS stok_log;
DROP TABLE IF EXISTS transaksi_item;
DROP TABLE IF EXISTS transaksi;
DROP TABLE IF EXISTS varian_topping;
DROP TABLE IF EXISTS varian;
DROP TABLE IF EXISTS resep_bahan;
DROP TABLE IF EXISTS resep;
DROP TABLE IF EXISTS bahan_baku;
DROP TABLE IF EXISTS users;

-- Akun pemilik usaha
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  nama_usaha TEXT DEFAULT 'Usaha Saya',
  created_at TEXT DEFAULT (datetime('now'))
);

-- ============ 1. MASTER BAHAN BAKU ============
-- Database harga patokan semua bahan: adonan, topping, maupun kemasan.
CREATE TABLE bahan_baku (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  nama TEXT NOT NULL,
  kategori TEXT NOT NULL DEFAULT 'adonan' CHECK (kategori IN ('adonan','topping','kemasan')),
  satuan TEXT NOT NULL,                 -- satuan dasar: gr, ml, pcs
  harga_beli REAL NOT NULL,             -- harga beli per kemasan, misal 11000 untuk 1kg
  isi_kemasan REAL NOT NULL DEFAULT 1,  -- isi kemasan dalam satuan dasar, misal 1000 (gr)
  harga_per_satuan REAL NOT NULL,       -- = harga_beli / isi_kemasan
  stok REAL DEFAULT 0,
  stok_minimum REAL DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX idx_bahan_user ON bahan_baku(user_id);

-- ============ 2. MASTER RESEP ============
-- Takaran/komposisi bahan adonan dasar. HPP dihitung per gram adonan.
-- total_berat diisi MANUAL (hasil timbangan asli adonan jadi), bukan auto-sum bahan mentah,
-- karena satuan bahan bisa campur (gr/ml/pcs) dan ada penyusutan saat diolah.
CREATE TABLE resep (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  nama TEXT NOT NULL,
  catatan TEXT,
  total_berat REAL NOT NULL DEFAULT 0,
  total_biaya REAL NOT NULL DEFAULT 0,
  hpp_per_gram REAL NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX idx_resep_user ON resep(user_id);

-- Komposisi bahan per Master Resep. harga_satuan_saat_itu = snapshot harga bahan saat
-- resep dibuat/terakhir dihitung ulang -> dipakai untuk deteksi "harga berubah".
CREATE TABLE resep_bahan (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  resep_id INTEGER NOT NULL,
  bahan_id INTEGER NOT NULL,
  qty REAL NOT NULL,
  harga_satuan_saat_itu REAL NOT NULL,
  biaya REAL NOT NULL,
  FOREIGN KEY (resep_id) REFERENCES resep(id) ON DELETE CASCADE,
  FOREIGN KEY (bahan_id) REFERENCES bahan_baku(id)
);

-- ============ 3. VARIAN MENU ============
-- Turunan dari 1 Master Resep + topping/kemasan tambahan. Ini yang jadi produk kasir.
CREATE TABLE varian (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  resep_id INTEGER NOT NULL,
  nama TEXT NOT NULL,
  berat_gram REAL NOT NULL,
  hpp_per_gram_saat_itu REAL NOT NULL,
  biaya_adonan REAL NOT NULL,
  biaya_topping REAL NOT NULL DEFAULT 0,
  hpp_final REAL NOT NULL,
  harga_jual REAL NOT NULL DEFAULT 0,
  stok REAL DEFAULT 0,
  stok_minimum REAL DEFAULT 0,
  aktif INTEGER DEFAULT 1,
  urutan INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (resep_id) REFERENCES resep(id)
);
CREATE INDEX idx_varian_user ON varian(user_id);

CREATE TABLE varian_topping (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  varian_id INTEGER NOT NULL,
  bahan_id INTEGER NOT NULL,
  qty REAL NOT NULL,
  harga_satuan_saat_itu REAL NOT NULL,
  biaya REAL NOT NULL,
  FOREIGN KEY (varian_id) REFERENCES varian(id) ON DELETE CASCADE,
  FOREIGN KEY (bahan_id) REFERENCES bahan_baku(id)
);

-- ============ KASIR ============
CREATE TABLE transaksi (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  waktu TEXT DEFAULT (datetime('now')),
  total_jual REAL NOT NULL,
  total_hpp REAL NOT NULL,
  total_profit REAL NOT NULL,
  metode_bayar TEXT DEFAULT 'Tunai',
  status TEXT DEFAULT 'selesai',
  catatan TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX idx_transaksi_user_waktu ON transaksi(user_id, waktu);

CREATE TABLE transaksi_item (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transaksi_id INTEGER NOT NULL,
  varian_id INTEGER NOT NULL,
  nama_varian TEXT NOT NULL,
  qty REAL NOT NULL,
  harga_satuan REAL NOT NULL,
  hpp_satuan REAL NOT NULL,
  FOREIGN KEY (transaksi_id) REFERENCES transaksi(id) ON DELETE CASCADE,
  FOREIGN KEY (varian_id) REFERENCES varian(id)
);
CREATE INDEX idx_transaksi_item_transaksi ON transaksi_item(transaksi_id);

CREATE TABLE stok_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  varian_id INTEGER NOT NULL,
  perubahan REAL NOT NULL,
  jenis TEXT NOT NULL,
  catatan TEXT,
  waktu TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (varian_id) REFERENCES varian(id)
);
CREATE INDEX idx_stok_log_varian ON stok_log(varian_id);
