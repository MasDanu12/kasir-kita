/**
 * Kasir HPP — Cloudflare Worker (v2)
 * Alur: Master Bahan Baku -> Master Resep (HPP/gram) -> Varian Menu (HPP final) -> Kasir
 * Database: Cloudflare D1 (binding: DB) | Static assets: binding ASSETS
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
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, keyMaterial, 256);
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
  } catch { return null; }
}

// ---------- Util: HTTP ----------

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
function err(message, status = 400) { return json({ error: message }, status); }
async function getUser(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const payload = await verifyToken(token, env.JWT_SECRET);
  if (!payload || !payload.uid) return null;
  return payload;
}
function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

// ---------- Route handlers ----------

const routes = [];
function route(method, pattern, handler, auth = true) { routes.push({ method, pattern, handler, auth }); }

// ===================== AUTH =====================
route('POST', '/api/auth/register', async (req, env) => {
  const body = await req.json();
  const email = (body.email || '').trim().toLowerCase();
  const password = body.password || '';
  const namaUsaha = (body.nama_usaha || 'Usaha Saya').trim();
  if (!email || password.length < 6) return err('Email wajib diisi & password minimal 6 karakter');
  const exists = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (exists) return err('Email sudah terdaftar');
  const { hash, salt } = await pbkdf2Hash(password);
  const res = await env.DB.prepare('INSERT INTO users (email, password_hash, password_salt, nama_usaha) VALUES (?, ?, ?, ?)')
    .bind(email, hash, salt, namaUsaha).run();
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

// ===================== 1. MASTER BAHAN BAKU =====================
route('GET', '/api/bahan', async (req, env, u) => {
  const { results } = await env.DB.prepare('SELECT * FROM bahan_baku WHERE user_id = ? ORDER BY kategori, nama').bind(u.uid).all();
  return json(results);
});

route('POST', '/api/bahan', async (req, env, u) => {
  const b = await req.json();
  if (!b.nama || !b.satuan || b.harga_beli == null) return err('Nama, satuan, dan harga wajib diisi');
  const isiKemasan = Number(b.isi_kemasan) || 1;
  const hargaPerSatuan = round2(Number(b.harga_beli) / isiKemasan);
  const kategori = ['adonan', 'topping', 'kemasan'].includes(b.kategori) ? b.kategori : 'adonan';
  const res = await env.DB.prepare(
    'INSERT INTO bahan_baku (user_id, nama, kategori, satuan, harga_beli, isi_kemasan, harga_per_satuan, stok, stok_minimum) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(u.uid, b.nama.trim(), kategori, b.satuan.trim(), b.harga_beli, isiKemasan, hargaPerSatuan, b.stok || 0, b.stok_minimum || 0).run();
  return json({ id: res.meta.last_row_id, harga_per_satuan: hargaPerSatuan });
});

route('PUT', '/api/bahan/:id', async (req, env, u, params) => {
  const b = await req.json();
  const existing = await env.DB.prepare('SELECT id FROM bahan_baku WHERE id = ? AND user_id = ?').bind(params.id, u.uid).first();
  if (!existing) return err('Bahan tidak ditemukan', 404);
  const isiKemasan = Number(b.isi_kemasan) || 1;
  const hargaPerSatuan = round2(Number(b.harga_beli) / isiKemasan);
  const kategori = ['adonan', 'topping', 'kemasan'].includes(b.kategori) ? b.kategori : 'adonan';
  await env.DB.prepare(
    `UPDATE bahan_baku SET nama=?, kategori=?, satuan=?, harga_beli=?, isi_kemasan=?, harga_per_satuan=?, stok=?, stok_minimum=?, updated_at=datetime('now') WHERE id=?`
  ).bind(b.nama, kategori, b.satuan, b.harga_beli, isiKemasan, hargaPerSatuan, b.stok || 0, b.stok_minimum || 0, params.id).run();
  return json({ ok: true, harga_per_satuan: hargaPerSatuan });
});

route('DELETE', '/api/bahan/:id', async (req, env, u, params) => {
  const dipakaiResep = await env.DB.prepare('SELECT id FROM resep_bahan WHERE bahan_id = ? LIMIT 1').bind(params.id).first();
  if (dipakaiResep) return err('Bahan masih dipakai di Master Resep, hapus dari sana dulu', 409);
  const dipakaiTopping = await env.DB.prepare('SELECT id FROM varian_topping WHERE bahan_id = ? LIMIT 1').bind(params.id).first();
  if (dipakaiTopping) return err('Bahan masih dipakai sebagai topping di Varian, hapus dari sana dulu', 409);
  await env.DB.prepare('DELETE FROM bahan_baku WHERE id = ? AND user_id = ?').bind(params.id, u.uid).run();
  return json({ ok: true });
});

// ===================== 2. MASTER RESEP =====================
async function ambilResepLengkap(env, resepId) {
  const r = await env.DB.prepare('SELECT * FROM resep WHERE id = ?').bind(resepId).first();
  if (!r) return null;
  const { results: bahan } = await env.DB.prepare(
    `SELECT rb.id, rb.bahan_id, rb.qty, rb.harga_satuan_saat_itu, rb.biaya,
            b.nama AS nama_bahan, b.satuan, b.harga_per_satuan AS harga_sekarang
     FROM resep_bahan rb JOIN bahan_baku b ON b.id = rb.bahan_id WHERE rb.resep_id = ?`
  ).bind(resepId).all();
  r.bahan = bahan;
  r.harga_berubah = bahan.some(x => round2(x.harga_satuan_saat_itu) !== round2(x.harga_sekarang));
  return r;
}

route('GET', '/api/resep', async (req, env, u) => {
  const { results } = await env.DB.prepare('SELECT * FROM resep WHERE user_id = ? ORDER BY nama').bind(u.uid).all();
  for (const r of results) {
    const { results: bahan } = await env.DB.prepare(
      `SELECT rb.harga_satuan_saat_itu, b.harga_per_satuan AS harga_sekarang
       FROM resep_bahan rb JOIN bahan_baku b ON b.id = rb.bahan_id WHERE rb.resep_id = ?`
    ).bind(r.id).all();
    r.harga_berubah = bahan.some(x => round2(x.harga_satuan_saat_itu) !== round2(x.harga_sekarang));
  }
  return json(results);
});

route('GET', '/api/resep/:id', async (req, env, u, params) => {
  const r = await ambilResepLengkap(env, params.id);
  if (!r || r.user_id !== u.uid) return err('Resep tidak ditemukan', 404);
  return json(r);
});

function hitungSnapshotBahan(bahanRows, daftarBahanInput) {
  // daftarBahanInput: [{bahan_id, qty}], bahanRows: Map bahan_id -> {harga_per_satuan}
  let total = 0;
  const hasil = [];
  for (const item of daftarBahanInput) {
    const info = bahanRows.get(Number(item.bahan_id));
    if (!info) continue;
    const qty = Number(item.qty) || 0;
    const biaya = round2(qty * info.harga_per_satuan);
    total += biaya;
    hasil.push({ bahan_id: Number(item.bahan_id), qty, harga_satuan_saat_itu: info.harga_per_satuan, biaya });
  }
  return { total: round2(total), rincian: hasil };
}

route('POST', '/api/resep', async (req, env, u) => {
  const b = await req.json();
  if (!b.nama || !Array.isArray(b.bahan) || b.bahan.length === 0) return err('Nama resep dan minimal 1 bahan wajib diisi');
  const totalBerat = Number(b.total_berat) || 0;
  if (totalBerat <= 0) return err('Total berat adonan wajib diisi (hasil timbangan)');

  const { results: semuaBahan } = await env.DB.prepare('SELECT id, harga_per_satuan FROM bahan_baku WHERE user_id = ?').bind(u.uid).all();
  const peta = new Map(semuaBahan.map(x => [x.id, x]));
  const { total, rincian } = hitungSnapshotBahan(peta, b.bahan);
  if (rincian.length === 0) return err('Bahan tidak valid');
  const hppPerGram = round2(total / totalBerat);

  const res = await env.DB.prepare(
    'INSERT INTO resep (user_id, nama, catatan, total_berat, total_biaya, hpp_per_gram) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(u.uid, b.nama.trim(), b.catatan || null, totalBerat, total, hppPerGram).run();
  const resepId = res.meta.last_row_id;
  for (const item of rincian) {
    await env.DB.prepare('INSERT INTO resep_bahan (resep_id, bahan_id, qty, harga_satuan_saat_itu, biaya) VALUES (?, ?, ?, ?, ?)')
      .bind(resepId, item.bahan_id, item.qty, item.harga_satuan_saat_itu, item.biaya).run();
  }
  return json({ id: resepId, total_biaya: total, hpp_per_gram: hppPerGram });
});

route('PUT', '/api/resep/:id', async (req, env, u, params) => {
  const b = await req.json();
  const existing = await env.DB.prepare('SELECT id FROM resep WHERE id = ? AND user_id = ?').bind(params.id, u.uid).first();
  if (!existing) return err('Resep tidak ditemukan', 404);
  const totalBerat = Number(b.total_berat) || 0;
  if (totalBerat <= 0) return err('Total berat adonan wajib diisi');

  const { results: semuaBahan } = await env.DB.prepare('SELECT id, harga_per_satuan FROM bahan_baku WHERE user_id = ?').bind(u.uid).all();
  const peta = new Map(semuaBahan.map(x => [x.id, x]));
  const { total, rincian } = hitungSnapshotBahan(peta, b.bahan || []);
  const hppPerGram = round2(total / totalBerat);

  await env.DB.prepare(`UPDATE resep SET nama=?, catatan=?, total_berat=?, total_biaya=?, hpp_per_gram=?, updated_at=datetime('now') WHERE id=?`)
    .bind(b.nama, b.catatan || null, totalBerat, total, hppPerGram, params.id).run();
  await env.DB.prepare('DELETE FROM resep_bahan WHERE resep_id = ?').bind(params.id).run();
  for (const item of rincian) {
    await env.DB.prepare('INSERT INTO resep_bahan (resep_id, bahan_id, qty, harga_satuan_saat_itu, biaya) VALUES (?, ?, ?, ?, ?)')
      .bind(params.id, item.bahan_id, item.qty, item.harga_satuan_saat_itu, item.biaya).run();
  }
  return json({ total_biaya: total, hpp_per_gram: hppPerGram });
});

// Hitung ulang: pakai harga bahan TERKINI, qty tidak berubah
route('POST', '/api/resep/:id/hitung-ulang', async (req, env, u, params) => {
  const r = await env.DB.prepare('SELECT * FROM resep WHERE id = ? AND user_id = ?').bind(params.id, u.uid).first();
  if (!r) return err('Resep tidak ditemukan', 404);
  const { results: baris } = await env.DB.prepare(
    `SELECT rb.id, rb.bahan_id, rb.qty, b.harga_per_satuan FROM resep_bahan rb JOIN bahan_baku b ON b.id = rb.bahan_id WHERE rb.resep_id = ?`
  ).bind(params.id).all();
  let total = 0;
  for (const row of baris) {
    const biaya = round2(row.qty * row.harga_per_satuan);
    total += biaya;
    await env.DB.prepare('UPDATE resep_bahan SET harga_satuan_saat_itu=?, biaya=? WHERE id=?').bind(row.harga_per_satuan, biaya, row.id).run();
  }
  total = round2(total);
  const hppPerGram = round2(total / (r.total_berat || 1));
  await env.DB.prepare(`UPDATE resep SET total_biaya=?, hpp_per_gram=?, updated_at=datetime('now') WHERE id=?`).bind(total, hppPerGram, params.id).run();
  return json({ total_biaya: total, hpp_per_gram: hppPerGram });
});

route('DELETE', '/api/resep/:id', async (req, env, u, params) => {
  const dipakai = await env.DB.prepare('SELECT id FROM varian WHERE resep_id = ? LIMIT 1').bind(params.id).first();
  if (dipakai) return err('Resep masih dipakai Varian Menu, hapus varian dulu', 409);
  await env.DB.prepare('DELETE FROM resep_bahan WHERE resep_id = ?').bind(params.id).run();
  await env.DB.prepare('DELETE FROM resep WHERE id = ? AND user_id = ?').bind(params.id, u.uid).run();
  return json({ ok: true });
});

// ===================== 3. VARIAN MENU =====================
async function ambilVarianLengkap(env, varianId) {
  const v = await env.DB.prepare('SELECT * FROM varian WHERE id = ?').bind(varianId).first();
  if (!v) return null;
  const { results: topping } = await env.DB.prepare(
    `SELECT vt.id, vt.bahan_id, vt.qty, vt.harga_satuan_saat_itu, vt.biaya,
            b.nama AS nama_bahan, b.satuan, b.harga_per_satuan AS harga_sekarang, b.kategori
     FROM varian_topping vt JOIN bahan_baku b ON b.id = vt.bahan_id WHERE vt.varian_id = ?`
  ).bind(varianId).all();
  v.topping = topping;
  const resep = await env.DB.prepare('SELECT hpp_per_gram FROM resep WHERE id = ?').bind(v.resep_id).first();
  v.harga_berubah = (resep && round2(resep.hpp_per_gram) !== round2(v.hpp_per_gram_saat_itu)) ||
    topping.some(x => round2(x.harga_satuan_saat_itu) !== round2(x.harga_sekarang));
  return v;
}

route('GET', '/api/varian', async (req, env, u) => {
  const { results } = await env.DB.prepare(
    `SELECT v.*, r.nama AS nama_resep FROM varian v JOIN resep r ON r.id = v.resep_id
     WHERE v.user_id = ? AND v.aktif = 1 ORDER BY v.urutan, v.nama`
  ).bind(u.uid).all();
  for (const v of results) {
    v.margin = v.harga_jual > 0 ? round2(((v.harga_jual - v.hpp_final) / v.harga_jual) * 100) : 0;
  }
  return json(results);
});

route('GET', '/api/varian/:id', async (req, env, u, params) => {
  const v = await ambilVarianLengkap(env, params.id);
  if (!v || v.user_id !== u.uid) return err('Varian tidak ditemukan', 404);
  return json(v);
});

function hitungSnapshotTopping(bahanRows, daftarTopping) {
  let total = 0;
  const hasil = [];
  for (const item of (daftarTopping || [])) {
    const info = bahanRows.get(Number(item.bahan_id));
    if (!info) continue;
    const qty = Number(item.qty) || 0;
    const biaya = round2(qty * info.harga_per_satuan);
    total += biaya;
    hasil.push({ bahan_id: Number(item.bahan_id), qty, harga_satuan_saat_itu: info.harga_per_satuan, biaya });
  }
  return { total: round2(total), rincian: hasil };
}

route('POST', '/api/varian', async (req, env, u) => {
  const b = await req.json();
  if (!b.nama || !b.resep_id || !b.berat_gram) return err('Nama, resep, dan berat adonan wajib diisi');
  const resep = await env.DB.prepare('SELECT * FROM resep WHERE id = ? AND user_id = ?').bind(b.resep_id, u.uid).first();
  if (!resep) return err('Master Resep tidak ditemukan', 404);

  const { results: semuaBahan } = await env.DB.prepare('SELECT id, harga_per_satuan FROM bahan_baku WHERE user_id = ?').bind(u.uid).all();
  const peta = new Map(semuaBahan.map(x => [x.id, x]));
  const { total: biayaTopping, rincian } = hitungSnapshotTopping(peta, b.topping);

  const beratGram = Number(b.berat_gram);
  const biayaAdonan = round2(beratGram * resep.hpp_per_gram);
  const hppFinal = round2(biayaAdonan + biayaTopping);

  const res = await env.DB.prepare(
    `INSERT INTO varian (user_id, resep_id, nama, berat_gram, hpp_per_gram_saat_itu, biaya_adonan, biaya_topping, hpp_final, harga_jual, stok, stok_minimum)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(u.uid, b.resep_id, b.nama.trim(), beratGram, resep.hpp_per_gram, biayaAdonan, biayaTopping, hppFinal, b.harga_jual || 0, b.stok || 0, b.stok_minimum || 0).run();
  const varianId = res.meta.last_row_id;
  for (const t of rincian) {
    await env.DB.prepare('INSERT INTO varian_topping (varian_id, bahan_id, qty, harga_satuan_saat_itu, biaya) VALUES (?, ?, ?, ?, ?)')
      .bind(varianId, t.bahan_id, t.qty, t.harga_satuan_saat_itu, t.biaya).run();
  }
  return json({ id: varianId, hpp_final: hppFinal });
});

route('PUT', '/api/varian/:id', async (req, env, u, params) => {
  const b = await req.json();
  const existing = await env.DB.prepare('SELECT * FROM varian WHERE id = ? AND user_id = ?').bind(params.id, u.uid).first();
  if (!existing) return err('Varian tidak ditemukan', 404);
  const resepId = b.resep_id || existing.resep_id;
  const resep = await env.DB.prepare('SELECT * FROM resep WHERE id = ? AND user_id = ?').bind(resepId, u.uid).first();
  if (!resep) return err('Master Resep tidak ditemukan', 404);

  const { results: semuaBahan } = await env.DB.prepare('SELECT id, harga_per_satuan FROM bahan_baku WHERE user_id = ?').bind(u.uid).all();
  const peta = new Map(semuaBahan.map(x => [x.id, x]));
  const { total: biayaTopping, rincian } = hitungSnapshotTopping(peta, b.topping);

  const beratGram = Number(b.berat_gram) || existing.berat_gram;
  const biayaAdonan = round2(beratGram * resep.hpp_per_gram);
  const hppFinal = round2(biayaAdonan + biayaTopping);

  await env.DB.prepare(
    `UPDATE varian SET resep_id=?, nama=?, berat_gram=?, hpp_per_gram_saat_itu=?, biaya_adonan=?, biaya_topping=?, hpp_final=?,
     harga_jual=?, stok_minimum=?, aktif=?, updated_at=datetime('now') WHERE id=?`
  ).bind(resepId, b.nama, beratGram, resep.hpp_per_gram, biayaAdonan, biayaTopping, hppFinal, b.harga_jual || 0, b.stok_minimum || 0, b.aktif ?? 1, params.id).run();

  await env.DB.prepare('DELETE FROM varian_topping WHERE varian_id = ?').bind(params.id).run();
  for (const t of rincian) {
    await env.DB.prepare('INSERT INTO varian_topping (varian_id, bahan_id, qty, harga_satuan_saat_itu, biaya) VALUES (?, ?, ?, ?, ?)')
      .bind(params.id, t.bahan_id, t.qty, t.harga_satuan_saat_itu, t.biaya).run();
  }
  return json({ hpp_final: hppFinal });
});

// Hitung ulang varian: ambil hpp_per_gram TERKINI dari resep induk + harga topping terkini
route('POST', '/api/varian/:id/hitung-ulang', async (req, env, u, params) => {
  const v = await env.DB.prepare('SELECT * FROM varian WHERE id = ? AND user_id = ?').bind(params.id, u.uid).first();
  if (!v) return err('Varian tidak ditemukan', 404);
  const resep = await env.DB.prepare('SELECT hpp_per_gram FROM resep WHERE id = ?').bind(v.resep_id).first();
  const { results: toppingBaris } = await env.DB.prepare(
    `SELECT vt.id, vt.bahan_id, vt.qty, b.harga_per_satuan FROM varian_topping vt JOIN bahan_baku b ON b.id = vt.bahan_id WHERE vt.varian_id = ?`
  ).bind(params.id).all();
  let biayaTopping = 0;
  for (const row of toppingBaris) {
    const biaya = round2(row.qty * row.harga_per_satuan);
    biayaTopping += biaya;
    await env.DB.prepare('UPDATE varian_topping SET harga_satuan_saat_itu=?, biaya=? WHERE id=?').bind(row.harga_per_satuan, biaya, row.id).run();
  }
  biayaTopping = round2(biayaTopping);
  const biayaAdonan = round2(v.berat_gram * resep.hpp_per_gram);
  const hppFinal = round2(biayaAdonan + biayaTopping);
  await env.DB.prepare(`UPDATE varian SET hpp_per_gram_saat_itu=?, biaya_adonan=?, biaya_topping=?, hpp_final=?, updated_at=datetime('now') WHERE id=?`)
    .bind(resep.hpp_per_gram, biayaAdonan, biayaTopping, hppFinal, params.id).run();
  return json({ biaya_adonan: biayaAdonan, biaya_topping: biayaTopping, hpp_final: hppFinal });
});

route('DELETE', '/api/varian/:id', async (req, env, u, params) => {
  await env.DB.prepare('UPDATE varian SET aktif = 0 WHERE id = ? AND user_id = ?').bind(params.id, u.uid).run();
  return json({ ok: true });
});

route('POST', '/api/varian/:id/restock', async (req, env, u, params) => {
  const b = await req.json();
  const qty = Number(b.qty);
  if (!qty || qty <= 0) return err('Qty restock harus lebih dari 0');
  const v = await env.DB.prepare('SELECT * FROM varian WHERE id = ? AND user_id = ?').bind(params.id, u.uid).first();
  if (!v) return err('Varian tidak ditemukan', 404);
  await env.DB.prepare('UPDATE varian SET stok = stok + ? WHERE id = ?').bind(qty, params.id).run();
  await env.DB.prepare('INSERT INTO stok_log (varian_id, perubahan, jenis, catatan) VALUES (?, ?, ?, ?)')
    .bind(params.id, qty, 'restock', b.catatan || null).run();
  return json({ ok: true });
});

// ===================== KASIR / TRANSAKSI =====================
route('POST', '/api/transaksi', async (req, env, u) => {
  const b = await req.json();
  if (!Array.isArray(b.items) || b.items.length === 0) return err('Keranjang kosong');
  let totalJual = 0, totalHpp = 0;
  const rincian = [];
  for (const item of b.items) {
    const v = await env.DB.prepare('SELECT * FROM varian WHERE id = ? AND user_id = ?').bind(item.varian_id, u.uid).first();
    if (!v) return err(`Varian id ${item.varian_id} tidak ditemukan`, 404);
    if (v.stok < item.qty) return err(`Stok "${v.nama}" tidak cukup (sisa ${v.stok})`, 409);
    totalJual += v.harga_jual * item.qty;
    totalHpp += v.hpp_final * item.qty;
    rincian.push({ varian: v, qty: item.qty });
  }
  totalJual = round2(totalJual); totalHpp = round2(totalHpp);
  const totalProfit = round2(totalJual - totalHpp);
  const res = await env.DB.prepare(
    'INSERT INTO transaksi (user_id, total_jual, total_hpp, total_profit, metode_bayar, catatan) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(u.uid, totalJual, totalHpp, totalProfit, b.metode_bayar || 'Tunai', b.catatan || null).run();
  const transaksiId = res.meta.last_row_id;
  for (const r of rincian) {
    await env.DB.prepare('INSERT INTO transaksi_item (transaksi_id, varian_id, nama_varian, qty, harga_satuan, hpp_satuan) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(transaksiId, r.varian.id, r.varian.nama, r.qty, r.varian.harga_jual, r.varian.hpp_final).run();
    await env.DB.prepare('UPDATE varian SET stok = stok - ? WHERE id = ?').bind(r.qty, r.varian.id).run();
    await env.DB.prepare('INSERT INTO stok_log (varian_id, perubahan, jenis) VALUES (?, ?, ?)').bind(r.varian.id, -r.qty, 'jual').run();
  }
  return json({ id: transaksiId, total_jual: totalJual, total_hpp: totalHpp, total_profit: totalProfit });
});

route('GET', '/api/transaksi', async (req, env, u) => {
  const url = new URL(req.url);
  const mulai = url.searchParams.get('mulai'), selesai = url.searchParams.get('selesai');
  let q = 'SELECT * FROM transaksi WHERE user_id = ?'; const args = [u.uid];
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
    await env.DB.prepare('UPDATE varian SET stok = stok + ? WHERE id = ?').bind(it.qty, it.varian_id).run();
    await env.DB.prepare('INSERT INTO stok_log (varian_id, perubahan, jenis, catatan) VALUES (?, ?, ?, ?)')
      .bind(it.varian_id, it.qty, 'batal', `Batal transaksi #${params.id}`).run();
  }
  await env.DB.prepare(`UPDATE transaksi SET status='dibatalkan' WHERE id=?`).bind(params.id).run();
  return json({ ok: true });
});

// ===================== DASHBOARD & LAPORAN =====================
route('GET', '/api/dashboard', async (req, env, u) => {
  const today = new Date().toISOString().slice(0, 10);
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS jumlah, COALESCE(SUM(total_jual),0) AS omzet, COALESCE(SUM(total_hpp),0) AS hpp, COALESCE(SUM(total_profit),0) AS profit
     FROM transaksi WHERE user_id = ? AND status='selesai' AND date(waktu) = ?`
  ).bind(u.uid, today).first();
  const stokRendah = await env.DB.prepare(
    'SELECT id, nama, stok, stok_minimum FROM varian WHERE user_id = ? AND aktif = 1 AND stok <= stok_minimum'
  ).bind(u.uid).all();
  return json({
    tanggal: today, transaksi_hari_ini: row.jumlah, omzet_hari_ini: round2(row.omzet),
    hpp_hari_ini: round2(row.hpp), profit_hari_ini: round2(row.profit), stok_rendah: stokRendah.results,
  });
});

route('GET', '/api/laporan', async (req, env, u) => {
  const url = new URL(req.url);
  const mulai = url.searchParams.get('mulai') || '1970-01-01';
  const selesai = url.searchParams.get('selesai') || '2999-12-31';
  const ringkas = await env.DB.prepare(
    `SELECT COUNT(*) AS jumlah_transaksi, COALESCE(SUM(total_jual),0) AS omzet, COALESCE(SUM(total_hpp),0) AS hpp, COALESCE(SUM(total_profit),0) AS profit
     FROM transaksi WHERE user_id = ? AND status='selesai' AND date(waktu) BETWEEN ? AND ?`
  ).bind(u.uid, mulai, selesai).first();
  const { results: tren } = await env.DB.prepare(
    `SELECT date(waktu) AS tanggal, COALESCE(SUM(total_jual),0) AS omzet, COALESCE(SUM(total_profit),0) AS profit
     FROM transaksi WHERE user_id = ? AND status='selesai' AND date(waktu) BETWEEN ? AND ? GROUP BY date(waktu) ORDER BY tanggal`
  ).bind(u.uid, mulai, selesai).all();
  const { results: terlaris } = await env.DB.prepare(
    `SELECT ti.nama_varian, SUM(ti.qty) AS qty_terjual, SUM(ti.qty * ti.harga_satuan) AS omzet, SUM(ti.qty * (ti.harga_satuan - ti.hpp_satuan)) AS profit
     FROM transaksi_item ti JOIN transaksi t ON t.id = ti.transaksi_id
     WHERE t.user_id = ? AND t.status='selesai' AND date(t.waktu) BETWEEN ? AND ?
     GROUP BY ti.varian_id ORDER BY qty_terjual DESC LIMIT 10`
  ).bind(u.uid, mulai, selesai).all();
  const margin = ringkas.omzet > 0 ? round2((ringkas.profit / ringkas.omzet) * 100) : 0;
  return json({
    mulai, selesai, jumlah_transaksi: ringkas.jumlah_transaksi, omzet: round2(ringkas.omzet), hpp: round2(ringkas.hpp),
    profit: round2(ringkas.profit), margin_persen: margin, tren_harian: tren, produk_terlaris: terlaris,
  });
});

// ===================== Backup / Reset =====================
route('GET', '/api/backup', async (req, env, u) => {
  const tables = ['bahan_baku', 'resep', 'resep_bahan', 'varian', 'varian_topping', 'transaksi', 'transaksi_item', 'stok_log'];
  const data = { exported_at: new Date().toISOString() };
  for (const t of tables) { const { results } = await env.DB.prepare(`SELECT * FROM ${t}`).all(); data[t] = results; }
  return json(data);
});

route('POST', '/api/reset', async (req, env, u) => {
  const b = await req.json();
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(u.uid).first();
  const { hash } = await pbkdf2Hash(b.password || '', user.password_salt);
  if (hash !== user.password_hash) return err('Password salah', 401);

  const varianIds = (await env.DB.prepare('SELECT id FROM varian WHERE user_id = ?').bind(u.uid).all()).results.map(r => r.id);
  if (varianIds.length) {
    await env.DB.prepare(`DELETE FROM stok_log WHERE varian_id IN (${varianIds.join(',')})`).run();
    await env.DB.prepare(`DELETE FROM transaksi_item WHERE varian_id IN (${varianIds.join(',')})`).run();
    await env.DB.prepare(`DELETE FROM varian_topping WHERE varian_id IN (${varianIds.join(',')})`).run();
  }
  await env.DB.prepare('DELETE FROM transaksi WHERE user_id = ?').bind(u.uid).run();
  await env.DB.prepare('DELETE FROM varian WHERE user_id = ?').bind(u.uid).run();
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
      return new Response(null, { headers: {
        'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      }});
    }
    if (url.pathname.startsWith('/api/')) {
      try {
        for (const r of routes) {
          if (r.method !== request.method) continue;
          const params = matchRoute(url.pathname, r.pattern);
          if (!params) continue;
          let user = null;
          if (r.auth) { user = await getUser(request, env); if (!user) return err('Tidak terautentikasi', 401); }
          const res = await r.handler(request, env, user, params);
          res.headers.set('Access-Control-Allow-Origin', '*');
          return res;
        }
        return err('Endpoint tidak ditemukan', 404);
      } catch (e) { return err('Terjadi kesalahan server: ' + e.message, 500); }
    }
    return env.ASSETS.fetch(request);
  },
};
