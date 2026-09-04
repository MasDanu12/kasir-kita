/**
 * Kasir HPP — Cloudflare Worker
 * Backend API untuk pencatatan HPP resep, kasir, dan laporan.
 * Database: Cloudflare D1 (binding: DB)
 * Static assets: Cloudflare Assets (binding: ASSETS) — lihat wrangler.toml
 */

// ---------- Util: crypto ----------

function b64urlEncode(buf) {
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function pbkdf2Hash(password, saltB64) {
  const enc = new TextEncoder();
  const salt = saltB64 ? b64urlDecode(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return { hash: b64urlEncode(bits), salt: b64urlEncode(salt) };
}

async function hmacSign(data, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return b64urlEncode(sig);
}

async function createToken(payload, secret) {
  const header = b64urlEncode(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = await hmacSign(`${header}.${body}`, secret);
  return `${header}.${body}.${sig}`;
}

async function verifyToken(token, secret) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = await hmacSign(`${header}.${body}`, secret);
  if (expected !== sig) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---------- Util: HTTP ----------

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
function err(message, status = 400) {
  return json({ error: message }, status);
}

async function getUser(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const payload = await verifyToken(token, env.JWT_SECRET);
  if (!payload || !payload.uid) return null;
  return payload;
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// ---------- HPP helper ----------

async function hitungHppResep(env, resepId) {
  const { results } = await env.DB.prepare(
    `SELECT rb.qty, b.harga_per_satuan
     FROM resep_bahan rb JOIN bahan_baku b ON b.id = rb.bahan_id
     WHERE rb.resep_id = ?`
  ).bind(resepId).all();
  let total = 0;
  for (const r of results) total += Number(r.qty) * Number(r.harga_per_satuan);
  return round2(total);
}

async function hitungHppProduk(env, produk) {
  if (produk.resep_id) return await hitungHppResep(env, produk.resep_id);
  return round2(produk.hpp_manual || 0);
}

// ---------- Route handlers ----------

const routes = [];
function route(method, pattern, handler, auth = true) {
  routes.push({ method, pattern, handler, auth });
}

// --- Auth ---
route('POST', '/api/auth/register', async (req, env) => {
  const body = await req.json();
  const email = (body.email || '').trim().toLowerCase();
  const password = body.password || '';
  const namaUsaha = (body.nama_usaha || 'Usaha Saya').trim();
  if (!email || password.length < 6) return err('Email wajib diisi & password minimal 6 karakter');

  const exists = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (exists) return err('Email sudah terdaftar');

  const { hash, salt } = await pbkdf2Hash(password);
  const res = await env.DB.prepare(
    'INSERT INTO users (email, password_hash, password_salt, nama_usaha) VALUES (?, ?, ?, ?)'
  ).bind(email, hash, salt, namaUsaha).run();

  const uid = res.meta.last_row_id;
  const token = await createToken({ uid, email, exp: Date.now() + 1000 * 60 * 60 * 24 * 30 }, env.JWT_SECRET);
  return json({ token, user: { id: uid, email, nama_usaha: namaUsaha } });
}, false);

route('POST', '/api/auth/login', async (req, env) => {
  const body = await req.json();
  const email = (body.email || '').trim().toLowerCase();
  const password = body.password || '';
  const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  if (!user) return err('Email atau password salah', 401);
  const { hash } = await pbkdf2Hash(password, user.password_salt);
  if (hash !== user.password_hash) return err('Email atau password salah', 401);
  const token = await createToken({ uid: user.id, email, exp: Date.now() + 1000 * 60 * 60 * 24 * 30 }, env.JWT_SECRET);
  return json({ token, user: { id: user.id, email: user.email, nama_usaha: user.nama_usaha } });
}, false);

route('POST', '/api/auth/reset-request', async (req, env) => {
  // Verifikasi password lama sebagai syarat sebelum reset total data (2 langkah)
  const body = await req.json();
  return json({ ok: true, note: 'Gunakan POST /api/reset dengan password untuk konfirmasi.' });
}, false);

// --- Bahan baku ---
route('GET', '/api/bahan', async (req, env, u) => {
  const { results } = await env.DB.prepare('SELECT * FROM bahan_baku WHERE user_id = ? ORDER BY nama').bind(u.uid).all();
  return json(results);
});

route('POST', '/api/bahan', async (req, env, u) => {
  const b = await req.json();
  if (!b.nama || !b.satuan || b.harga_per_satuan == null) return err('Nama, satuan, dan harga wajib diisi');
  const res = await env.DB.prepare(
    'INSERT INTO bahan_baku (user_id, nama, satuan, harga_per_satuan, stok, stok_minimum) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(u.uid, b.nama.trim(), b.satuan.trim(), b.harga_per_satuan, b.stok || 0, b.stok_minimum || 0).run();
  return json({ id: res.meta.last_row_id });
});

route('PUT', '/api/bahan/:id', async (req, env, u, params) => {
  const b = await req.json();
  const existing = await env.DB.prepare('SELECT id FROM bahan_baku WHERE id = ? AND user_id = ?').bind(params.id, u.uid).first();
  if (!existing) return err('Bahan tidak ditemukan', 404);
  await env.DB.prepare(
    `UPDATE bahan_baku SET nama=?, satuan=?, harga_per_satuan=?, stok=?, stok_minimum=?, updated_at=datetime('now') WHERE id=?`
  ).bind(b.nama, b.satuan, b.harga_per_satuan, b.stok || 0, b.stok_minimum || 0, params.id).run();
  return json({ ok: true });
});

route('DELETE', '/api/bahan/:id', async (req, env, u, params) => {
  const dipakai = await env.DB.prepare('SELECT id FROM resep_bahan WHERE bahan_id = ? LIMIT 1').bind(params.id).first();
  if (dipakai) return err('Bahan masih dipakai di resep, hapus dari resep dulu', 409);
  await env.DB.prepare('DELETE FROM bahan_baku WHERE id = ? AND user_id = ?').bind(params.id, u.uid).run();
  return json({ ok: true });
});

// --- Resep ---
route('GET', '/api/resep', async (req, env, u) => {
  const { results } = await env.DB.prepare('SELECT * FROM resep WHERE user_id = ? ORDER BY nama').bind(u.uid).all();
  for (const r of results) r.hpp = await hitungHppResep(env, r.id);
  return json(results);
});

route('GET', '/api/resep/:id', async (req, env, u, params) => {
  const r = await env.DB.prepare('SELECT * FROM resep WHERE id = ? AND user_id = ?').bind(params.id, u.uid).first();
  if (!r) return err('Resep tidak ditemukan', 404);
  const { results: bahan } = await env.DB.prepare(
    `SELECT rb.id, rb.bahan_id, rb.qty, b.nama AS nama_bahan, b.satuan, b.harga_per_satuan
     FROM resep_bahan rb JOIN bahan_baku b ON b.id = rb.bahan_id WHERE rb.resep_id = ?`
  ).bind(params.id).all();
  r.bahan = bahan;
  r.hpp = await hitungHppResep(env, r.id);
  return json(r);
});

route('POST', '/api/resep', async (req, env, u) => {
  const b = await req.json();
  if (!b.nama || !Array.isArray(b.bahan) || b.bahan.length === 0) {
    return err('Nama resep dan minimal 1 bahan wajib diisi');
  }
  const res = await env.DB.prepare(
    'INSERT INTO resep (user_id, nama, kategori, catatan) VALUES (?, ?, ?, ?)'
  ).bind(u.uid, b.nama.trim(), b.kategori || 'Umum', b.catatan || null).run();
  const resepId = res.meta.last_row_id;
  for (const item of b.bahan) {
    await env.DB.prepare('INSERT INTO resep_bahan (resep_id, bahan_id, qty) VALUES (?, ?, ?)')
      .bind(resepId, item.bahan_id, item.qty).run();
  }
  return json({ id: resepId, hpp: await hitungHppResep(env, resepId) });
});

route('PUT', '/api/resep/:id', async (req, env, u, params) => {
  const b = await req.json();
  const existing = await env.DB.prepare('SELECT id FROM resep WHERE id = ? AND user_id = ?').bind(params.id, u.uid).first();
  if (!existing) return err('Resep tidak ditemukan', 404);
  await env.DB.prepare(`UPDATE resep SET nama=?, kategori=?, catatan=?, updated_at=datetime('now') WHERE id=?`)
    .bind(b.nama, b.kategori || 'Umum', b.catatan || null, params.id).run();
  if (Array.isArray(b.bahan)) {
    await env.DB.prepare('DELETE FROM resep_bahan WHERE resep_id = ?').bind(params.id).run();
    for (const item of b.bahan) {
      await env.DB.prepare('INSERT INTO resep_bahan (resep_id, bahan_id, qty) VALUES (?, ?, ?)')
        .bind(params.id, item.bahan_id, item.qty).run();
    }
  }
  return json({ hpp: await hitungHppResep(env, params.id) });
});

route('DELETE', '/api/resep/:id', async (req, env, u, params) => {
  const dipakai = await env.DB.prepare('SELECT id FROM produk WHERE resep_id = ? LIMIT 1').bind(params.id).first();
  if (dipakai) return err('Resep masih dipakai produk, hapus produk dulu', 409);
  await env.DB.prepare('DELETE FROM resep_bahan WHERE resep_id = ?').bind(params.id).run();
  await env.DB.prepare('DELETE FROM resep WHERE id = ? AND user_id = ?').bind(params.id, u.uid).run();
  return json({ ok: true });
});

// --- Produk (untuk kasir) ---
route('GET', '/api/produk', async (req, env, u) => {
  const { results } = await env.DB.prepare(
    'SELECT * FROM produk WHERE user_id = ? AND aktif = 1 ORDER BY urutan, nama'
  ).bind(u.uid).all();
  for (const p of results) {
    p.hpp = await hitungHppProduk(env, p);
    p.margin = p.harga_jual > 0 ? round2(((p.harga_jual - p.hpp) / p.harga_jual) * 100) : 0;
  }
  return json(results);
});

route('POST', '/api/produk', async (req, env, u) => {
  const b = await req.json();
  if (!b.nama || b.harga_jual == null) return err('Nama dan harga jual wajib diisi');
  if (!b.resep_id && b.hpp_manual == null) return err('Pilih resep atau isi HPP manual');
  const res = await env.DB.prepare(
    'INSERT INTO produk (user_id, resep_id, nama, hpp_manual, harga_jual, stok, stok_minimum) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(u.uid, b.resep_id || null, b.nama.trim(), b.hpp_manual ?? null, b.harga_jual, b.stok || 0, b.stok_minimum || 0).run();
  return json({ id: res.meta.last_row_id });
});

route('PUT', '/api/produk/:id', async (req, env, u, params) => {
  const b = await req.json();
  const existing = await env.DB.prepare('SELECT id FROM produk WHERE id = ? AND user_id = ?').bind(params.id, u.uid).first();
  if (!existing) return err('Produk tidak ditemukan', 404);
  await env.DB.prepare(
    'UPDATE produk SET nama=?, resep_id=?, hpp_manual=?, harga_jual=?, stok_minimum=?, aktif=? WHERE id=?'
  ).bind(b.nama, b.resep_id || null, b.hpp_manual ?? null, b.harga_jual, b.stok_minimum || 0, b.aktif ?? 1, params.id).run();
  return json({ ok: true });
});

route('DELETE', '/api/produk/:id', async (req, env, u, params) => {
  await env.DB.prepare('UPDATE produk SET aktif = 0 WHERE id = ? AND user_id = ?').bind(params.id, u.uid).run();
  return json({ ok: true });
});

route('POST', '/api/produk/:id/restock', async (req, env, u, params) => {
  const b = await req.json();
  const qty = Number(b.qty);
  if (!qty || qty <= 0) return err('Qty restock harus lebih dari 0');
  const p = await env.DB.prepare('SELECT * FROM produk WHERE id = ? AND user_id = ?').bind(params.id, u.uid).first();
  if (!p) return err('Produk tidak ditemukan', 404);
  await env.DB.prepare('UPDATE produk SET stok = stok + ? WHERE id = ?').bind(qty, params.id).run();
  await env.DB.prepare('INSERT INTO stok_log (produk_id, perubahan, jenis, catatan) VALUES (?, ?, ?, ?)')
    .bind(params.id, qty, 'restock', b.catatan || null).run();
  return json({ ok: true });
});

// --- Kasir / Transaksi ---
route('POST', '/api/transaksi', async (req, env, u) => {
  const b = await req.json();
  if (!Array.isArray(b.items) || b.items.length === 0) return err('Keranjang kosong');

  let totalJual = 0, totalHpp = 0;
  const rincian = [];
  for (const item of b.items) {
    const p = await env.DB.prepare('SELECT * FROM produk WHERE id = ? AND user_id = ?').bind(item.produk_id, u.uid).first();
    if (!p) return err(`Produk id ${item.produk_id} tidak ditemukan`, 404);
    if (p.stok < item.qty) return err(`Stok "${p.nama}" tidak cukup (sisa ${p.stok})`, 409);
    const hpp = await hitungHppProduk(env, p);
    totalJual += p.harga_jual * item.qty;
    totalHpp += hpp * item.qty;
    rincian.push({ produk: p, qty: item.qty, hpp });
  }
  totalJual = round2(totalJual);
  totalHpp = round2(totalHpp);
  const totalProfit = round2(totalJual - totalHpp);

  const res = await env.DB.prepare(
    'INSERT INTO transaksi (user_id, total_jual, total_hpp, total_profit, metode_bayar, catatan) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(u.uid, totalJual, totalHpp, totalProfit, b.metode_bayar || 'Tunai', b.catatan || null).run();
  const transaksiId = res.meta.last_row_id;

  for (const r of rincian) {
    await env.DB.prepare(
      'INSERT INTO transaksi_item (transaksi_id, produk_id, nama_produk, qty, harga_satuan, hpp_satuan) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(transaksiId, r.produk.id, r.produk.nama, r.qty, r.produk.harga_jual, r.hpp).run();
    await env.DB.prepare('UPDATE produk SET stok = stok - ? WHERE id = ?').bind(r.qty, r.produk.id).run();
    await env.DB.prepare('INSERT INTO stok_log (produk_id, perubahan, jenis) VALUES (?, ?, ?)')
      .bind(r.produk.id, -r.qty, 'jual').run();
  }

  return json({ id: transaksiId, total_jual: totalJual, total_hpp: totalHpp, total_profit: totalProfit });
});

route('GET', '/api/transaksi', async (req, env, u) => {
  const url = new URL(req.url);
  const mulai = url.searchParams.get('mulai');
  const selesai = url.searchParams.get('selesai');
  let q = 'SELECT * FROM transaksi WHERE user_id = ?';
  const args = [u.uid];
  if (mulai) { q += ' AND waktu >= ?'; args.push(mulai); }
  if (selesai) { q += ' AND waktu <= ?'; args.push(selesai); }
  q += ' ORDER BY waktu DESC LIMIT 200';
  const { results } = await env.DB.prepare(q).bind(...args).all();
  return json(results);
});

route('GET', '/api/transaksi/:id', async (req, env, u, params) => {
  const t = await env.DB.prepare('SELECT * FROM transaksi WHERE id = ? AND user_id = ?').bind(params.id, u.uid).first();
  if (!t) return err('Transaksi tidak ditemukan', 404);
  const { results: items } = await env.DB.prepare('SELECT * FROM transaksi_item WHERE transaksi_id = ?').bind(params.id).all();
  t.items = items;
  return json(t);
});

route('DELETE', '/api/transaksi/:id', async (req, env, u, params) => {
  const t = await env.DB.prepare('SELECT * FROM transaksi WHERE id = ? AND user_id = ?').bind(params.id, u.uid).first();
  if (!t) return err('Transaksi tidak ditemukan', 404);
  if (t.status === 'dibatalkan') return err('Transaksi sudah dibatalkan sebelumnya');
  const { results: items } = await env.DB.prepare('SELECT * FROM transaksi_item WHERE transaksi_id = ?').bind(params.id).all();
  for (const it of items) {
    await env.DB.prepare('UPDATE produk SET stok = stok + ? WHERE id = ?').bind(it.qty, it.produk_id).run();
    await env.DB.prepare('INSERT INTO stok_log (produk_id, perubahan, jenis, catatan) VALUES (?, ?, ?, ?)')
      .bind(it.produk_id, it.qty, 'batal', `Batal transaksi #${params.id}`).run();
  }
  await env.DB.prepare(`UPDATE transaksi SET status='dibatalkan' WHERE id=?`).bind(params.id).run();
  return json({ ok: true });
});

// --- Dashboard & Laporan ---
route('GET', '/api/dashboard', async (req, env, u) => {
  const today = new Date().toISOString().slice(0, 10);
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS jumlah, COALESCE(SUM(total_jual),0) AS omzet,
            COALESCE(SUM(total_hpp),0) AS hpp, COALESCE(SUM(total_profit),0) AS profit
     FROM transaksi WHERE user_id = ? AND status='selesai' AND date(waktu) = ?`
  ).bind(u.uid, today).first();

  const stokRendah = await env.DB.prepare(
    'SELECT id, nama, stok, stok_minimum FROM produk WHERE user_id = ? AND aktif = 1 AND stok <= stok_minimum'
  ).bind(u.uid).all();

  return json({
    tanggal: today,
    transaksi_hari_ini: row.jumlah,
    omzet_hari_ini: round2(row.omzet),
    hpp_hari_ini: round2(row.hpp),
    profit_hari_ini: round2(row.profit),
    stok_rendah: stokRendah.results,
  });
});

route('GET', '/api/laporan', async (req, env, u) => {
  const url = new URL(req.url);
  const mulai = url.searchParams.get('mulai') || '1970-01-01';
  const selesai = url.searchParams.get('selesai') || '2999-12-31';

  const ringkas = await env.DB.prepare(
    `SELECT COUNT(*) AS jumlah_transaksi, COALESCE(SUM(total_jual),0) AS omzet,
            COALESCE(SUM(total_hpp),0) AS hpp, COALESCE(SUM(total_profit),0) AS profit
     FROM transaksi WHERE user_id = ? AND status='selesai' AND date(waktu) BETWEEN ? AND ?`
  ).bind(u.uid, mulai, selesai).first();

  const { results: tren } = await env.DB.prepare(
    `SELECT date(waktu) AS tanggal, COALESCE(SUM(total_jual),0) AS omzet,
            COALESCE(SUM(total_profit),0) AS profit
     FROM transaksi WHERE user_id = ? AND status='selesai' AND date(waktu) BETWEEN ? AND ?
     GROUP BY date(waktu) ORDER BY tanggal`
  ).bind(u.uid, mulai, selesai).all();

  const { results: terlaris } = await env.DB.prepare(
    `SELECT ti.nama_produk, SUM(ti.qty) AS qty_terjual,
            SUM(ti.qty * ti.harga_satuan) AS omzet, SUM(ti.qty * (ti.harga_satuan - ti.hpp_satuan)) AS profit
     FROM transaksi_item ti JOIN transaksi t ON t.id = ti.transaksi_id
     WHERE t.user_id = ? AND t.status='selesai' AND date(t.waktu) BETWEEN ? AND ?
     GROUP BY ti.produk_id ORDER BY qty_terjual DESC LIMIT 10`
  ).bind(u.uid, mulai, selesai).all();

  const margin = ringkas.omzet > 0 ? round2((ringkas.profit / ringkas.omzet) * 100) : 0;

  return json({
    mulai, selesai,
    jumlah_transaksi: ringkas.jumlah_transaksi,
    omzet: round2(ringkas.omzet),
    hpp: round2(ringkas.hpp),
    profit: round2(ringkas.profit),
    margin_persen: margin,
    tren_harian: tren,
    produk_terlaris: terlaris,
  });
});

// --- Backup / Restore / Reset ---
route('GET', '/api/backup', async (req, env, u) => {
  const tables = ['bahan_baku', 'resep', 'resep_bahan', 'produk', 'transaksi', 'transaksi_item', 'stok_log'];
  const data = { exported_at: new Date().toISOString() };
  for (const t of tables) {
    const { results } = await env.DB.prepare(`SELECT * FROM ${t}`).all();
    data[t] = results;
  }
  return json(data);
});

route('POST', '/api/reset', async (req, env, u) => {
  const b = await req.json();
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(u.uid).first();
  const { hash } = await pbkdf2Hash(b.password || '', user.password_salt);
  if (hash !== user.password_hash) return err('Password salah', 401);

  const ids = (await env.DB.prepare('SELECT id FROM produk WHERE user_id = ?').bind(u.uid).all()).results.map(r => r.id);
  if (ids.length) {
    await env.DB.prepare(`DELETE FROM stok_log WHERE produk_id IN (${ids.join(',')})`).run();
    await env.DB.prepare(`DELETE FROM transaksi_item WHERE produk_id IN (${ids.join(',')})`).run();
  }
  await env.DB.prepare('DELETE FROM transaksi WHERE user_id = ?').bind(u.uid).run();
  await env.DB.prepare('DELETE FROM produk WHERE user_id = ?').bind(u.uid).run();
  const resepIds = (await env.DB.prepare('SELECT id FROM resep WHERE user_id = ?').bind(u.uid).all()).results.map(r => r.id);
  if (resepIds.length) await env.DB.prepare(`DELETE FROM resep_bahan WHERE resep_id IN (${resepIds.join(',')})`).run();
  await env.DB.prepare('DELETE FROM resep WHERE user_id = ?').bind(u.uid).run();
  await env.DB.prepare('DELETE FROM bahan_baku WHERE user_id = ?').bind(u.uid).run();
  return json({ ok: true });
});

// ---------- Router ----------

function matchRoute(pathname, pattern) {
  const p1 = pathname.split('/').filter(Boolean);
  const p2 = pattern.split('/').filter(Boolean);
  if (p1.length !== p2.length) return null;
  const params = {};
  for (let i = 0; i < p2.length; i++) {
    if (p2[i].startsWith(':')) params[p2[i].slice(1)] = p1[i];
    else if (p2[i] !== p1[i]) return null;
  }
  return params;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      });
    }

    if (url.pathname.startsWith('/api/')) {
      try {
        for (const r of routes) {
          if (r.method !== request.method) continue;
          const params = matchRoute(url.pathname, r.pattern);
          if (!params) continue;

          let user = null;
          if (r.auth) {
            user = await getUser(request, env);
            if (!user) return err('Tidak terautentikasi', 401);
          }
          const res = await r.handler(request, env, user, params);
          res.headers.set('Access-Control-Allow-Origin', '*');
          return res;
        }
        return err('Endpoint tidak ditemukan', 404);
      } catch (e) {
        return err('Terjadi kesalahan server: ' + e.message, 500);
      }
    }

    // Static assets (PWA frontend)
    return env.ASSETS.fetch(request);
  },
};
