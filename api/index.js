'use strict';

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Configuration manquante : SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont requis.');
}
const opt = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const db = createClient(SUPABASE_URL || 'https://invalid.supabase.co', SUPABASE_SERVICE_ROLE_KEY || 'missing-service-role-key', opt);
const anon = () => {
  if (!SUPABASE_ANON_KEY) throw Object.assign(new Error('Configuration serveur incomplète : SUPABASE_ANON_KEY manquante.'), { status: 500 });
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, opt);
};
const ok = async p => { const { data, error } = await p; if (error) throw error; return data; };
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const h = f => async (req, res) => {
  try { await f(req, res); }
  catch (e) {
    const status = Number.isInteger(e.status) ? e.status : (e.code === '23505' ? 409 : 500);
    if (status >= 500) console.error('API error:', e.message);
    res.status(status).json({ error: status >= 500 ? 'Une erreur serveur est survenue.' : e.message });
  }
};
const T = {
  teams: ['name','city','stadium_id','coach'],
  stadiums: ['name','city','capacity'],
  referees: ['name','country'],
  players: ['name','team_id','pos','number'],
  matches: ['home_id','away_id','date','stadium_id','referee_id','hg','ag','played'],
  events: ['match_id','player_id','type','minute']
};
const pick = (o, cols) => Object.fromEntries(cols.filter(c => o[c] !== undefined).map(c => [c, o[c] === '' ? null : o[c]]));
const cleanText = (v, max = 120) => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max;
const normalizeEmail = v => typeof v === 'string' ? v.trim().toLowerCase() : '';
const validEmail = v => v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const codeValid = v => typeof v === 'string' && /^\d{8}$/.test(v)
  && !/^(\d)\1{7}$/.test(v)
  && !['01234567', '12345678', '87654321', '76543210'].includes(v);
const notify = async text => ok(db.from('notifications').insert({ text }));
const notifySafely = async text => { try { await notify(text); return true; } catch (e) { console.error('Notification non enregistrée:', e.message); return false; } };
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('X-Frame-Options', 'DENY');
  next();
});
app.use(express.json({ limit: '100kb', strict: true }));
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));
app.get('/', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

// Le quota IP et le quota e-mail sont stockés séparément dans Supabase.
// La migration supabase/auth-security.sql ajoute la fonction atomique utilisée ici.
const hashRateKey = (type, value) => crypto.createHmac('sha256', process.env.AUTH_RATE_LIMIT_SECRET || SUPABASE_SERVICE_ROLE_KEY || 'missing-secret')
  .update(`${type}:${value}`).digest('hex');
async function consumeQuota(type, value, limit) {
  const keyHash = hashRateKey(type, value);
  const { data, error } = await db.rpc('consume_auth_rate_limit', {
    p_key_type: type, p_key_hash: keyHash, p_max_attempts: limit, p_window_seconds: 900
  });
  if (error) {
    console.error('Rate limit storage error:', error.message);
    throw fail('Service de sécurité temporairement indisponible. Réessayez plus tard.', 503);
  }
  if (data !== true) throw fail('Trop de tentatives. Réessayez dans 15 minutes.', 429);
}
async function guardAuth(req, email) {
  // Les deux quotas sont tentés en parallèle : un quota atteint n'empêche pas
  // l'autre d'enregistrer sa propre tentative. Les clés IP/e-mail restent distinctes.
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const results = await Promise.allSettled([
    consumeQuota('ip', ip, 20),
    consumeQuota('email', email, 8)
  ]);
  const errors = results.filter(r => r.status === 'rejected').map(r => r.reason);
  const unavailable = errors.find(e => e?.status === 503);
  if (unavailable) throw unavailable;
  if (errors.length) throw errors[0];
}

app.use(async (req, _res, next) => {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (match) {
    try {
      const { data, error } = await db.auth.getUser(match[1]);
      if (!error && data?.user) {
        const { data: profile } = await db.from('profiles').select('name,role').eq('id', data.user.id).maybeSingle();
        if (profile) req.user = { id: data.user.id, name: profile.name, role: profile.role };
      }
    } catch (e) { /* Les routes protégées renverront 401/403 sans session valide. */ }
  }
  next();
});
const requireUser = (req, res, next) => req.user ? next() : res.status(401).json({ error: 'Connexion requise.' });
const admin = (req, res, next) => req.user?.role === 'admin' ? next() : res.status(req.user ? 403 : 401).json({ error: req.user ? 'Réservé aux administrateurs.' : 'Connexion requise.' });

async function session(email, password) {
  const { data, error } = await anon().auth.signInWithPassword({ email, password });
  if (error || !data?.session || !data?.user) throw fail('E-mail ou code personnel incorrect.', 401);
  let p = await ok(db.from('profiles').select('name,role').eq('id', data.user.id).maybeSingle());
  // Compatibilité avec un ancien compte Auth qui n'aurait pas encore de profil.
  // Un profil manquant est créé en rôle user ; un rôle existant n'est jamais remplacé.
  if (!p) {
    const legacyName = cleanText(data.user.user_metadata?.name, 80) ? data.user.user_metadata.name.trim()
      : (email.split('@')[0].slice(0, 80) || 'Utilisateur');
    p = await ok(db.from('profiles').insert({ id: data.user.id, name: legacyName, role: 'user' }).select('name,role').single());
  }
  return { token: data.session.access_token, user: { id: data.user.id, name: p.name, role: p.role } };
}
app.post('/api/register', h(async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const code = req.body?.password;
  const confirmation = req.body?.confirmCode;
  if (!validEmail(email)) throw fail('Veuillez saisir une adresse e-mail valide.');
  if (!cleanText(name, 80)) throw fail('Le nom est obligatoire (80 caractères maximum).');
  if (!codeValid(code)) throw fail('Le code personnel doit contenir exactement 8 chiffres.');
  if (code !== confirmation) throw fail('Les deux codes personnels ne correspondent pas.');
  await guardAuth(req, email);
  // Supabase Auth garantit l'unicité des e-mails même en cas d'inscriptions simultanées.
  // Le résultat de createUser est la source de vérité ; aucune migration destructive n'est nécessaire.
  const { data, error } = await db.auth.admin.createUser({
    email, password: code, email_confirm: true, user_metadata: { name }
  });
  if (error) {
    if (/already|registered|exists/i.test(error.message || '')) throw fail('Cette adresse e-mail est déjà utilisée.', 409);
    throw fail('Impossible de créer le compte. Vérifiez les informations et réessayez.', 400);
  }
  try {
    await ok(db.from('profiles').insert({ id: data.user.id, name, role: 'user' }));
    // La session est créée par le même mécanisme que la connexion classique.
    res.status(201).json(await session(email, code));
  } catch (e) {
    // Évite un utilisateur Auth orphelin si le profil ou la connexion échoue.
    await db.auth.admin.deleteUser(data.user.id).catch(() => {});
    throw e;
  }
}));
app.post('/api/login', h(async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = req.body?.password;
  if (!validEmail(email) || typeof password !== 'string' || !password.length || password.length > 128) {
    throw fail('Veuillez saisir une adresse e-mail et votre code personnel.');
  }
  await guardAuth(req, email);
  res.json(await session(email, password));
}));

app.get('/api/health', h(async (_req, res) => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_ANON_KEY) throw fail('Configuration Supabase incomplète.', 503);
  await ok(db.from('teams').select('id', { head: true, count: 'exact' }));
  res.json({ ok: true, app: 'FOOT26', version: '2.1.1', configured: true, database: 'connected' });
}));

app.get('/api/standings', h(async (_req, res) => {
  const rows = {};
  (await ok(db.from('teams').select('id,name'))).forEach(t => rows[t.id] = { id: t.id, name: t.name, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, pts: 0, form: [] });
  (await ok(db.from('matches').select('*').eq('played', true).order('date'))).forEach(m => {
    const a = rows[m.home_id], b = rows[m.away_id]; if (!a || !b) return;
    a.p++; b.p++; a.gf += Number(m.hg || 0); a.ga += Number(m.ag || 0); b.gf += Number(m.ag || 0); b.ga += Number(m.hg || 0);
    const r = m.hg > m.ag ? [a, b] : m.hg < m.ag ? [b, a] : null;
    if (r) { r[0].w++; r[0].pts += 3; r[1].l++; r[0].form.push('V'); r[1].form.push('D'); }
    else { a.d++; b.d++; a.pts++; b.pts++; a.form.push('N'); b.form.push('N'); }
  });
  res.json(Object.values(rows).map(r => ({ ...r, gd: r.gf - r.ga, form: r.form.slice(-5) }))
    .sort((x, y) => y.pts - x.pts || y.gd - x.gd || y.gf - x.gf));
}));
app.get('/api/stats/players', h(async (_req, res) => {
  const [pl, ev] = await Promise.all([ok(db.from('players').select('id,name,pos,teams(name)')), ok(db.from('events').select('player_id,type'))]);
  const s = {}; ev.forEach(e => { const k = e.type === 'goal' ? 'goal' : e.type === 'yellow' ? 'yellow' : e.type === 'red' ? 'red' : null; if (k) (s[e.player_id] ||= { goal: 0, yellow: 0, red: 0 })[k]++; });
  res.json(pl.map(p => ({ id: p.id, name: p.name, pos: p.pos, team: p.teams?.name, goals: s[p.id]?.goal || 0, yellow: s[p.id]?.yellow || 0, red: s[p.id]?.red || 0 }))
    .sort((a, b) => b.goals - a.goals || a.yellow - b.yellow));
}));
app.get('/api/matches/full', h(async (_req, res) => {
  const d = await ok(db.from('matches').select('*, home:teams!matches_home_id_fkey(name), away:teams!matches_away_id_fkey(name), stadium:stadiums(name), referee:referees(name)').order('date'));
  res.json(d.map(m => ({ ...m, home: m.home?.name, away: m.away?.name, stadium: m.stadium?.name, referee: m.referee?.name })));
}));
app.get('/api/notifications', h(async (_req, res) => res.json(await ok(db.from('notifications').select('*').order('id', { ascending: false }).limit(15)))));
app.get('/api/events', h(async (_req, res) => res.json(await ok(db.from('events').select('*')))));
app.get('/api/:t', h(async (req, res) => {
  if (!T[req.params.t]) throw fail('Ressource introuvable.', 404);
  res.json(await ok(db.from(req.params.t).select('*').order('id')));
}));

function validateRow(t, row, partial = false) {
  const required = {
    teams: ['name'], stadiums: ['name'], referees: ['name'], players: ['name','team_id'],
    matches: ['home_id','away_id','date'], events: ['match_id','player_id','type','minute']
  }[t] || [];
  for (const key of required) if ((!partial || row[key] !== undefined) && (row[key] === undefined || row[key] === null || row[key] === '')) throw fail(`Le champ « ${key} » est obligatoire.`);
  for (const key of ['name','city','coach','country','pos']) if (row[key] !== undefined && row[key] !== null && (typeof row[key] !== 'string' || row[key].length > 120)) throw fail(`Le champ « ${key} » est invalide.`);
  if (t === 'matches') {
    if (row.home_id !== undefined && row.away_id !== undefined && String(row.home_id) === String(row.away_id)) throw fail('Une équipe ne peut pas jouer contre elle-même.');
    for (const k of ['hg','ag']) if (row[k] !== undefined && (!Number.isInteger(Number(row[k])) || Number(row[k]) < 0 || Number(row[k]) > 99)) throw fail('Le score doit être un entier compris entre 0 et 99.');
    if (row.played !== undefined && typeof row.played !== 'boolean') throw fail('Le statut du match est invalide.');
    if (row.date !== undefined) {
      const value = String(row.date);
      const d = new Date(`${value}T00:00:00.000Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) throw fail('La date du match est invalide.');
    }
  }
  if (t === 'events') {
    if (row.type !== undefined && !['goal','yellow','red'].includes(row.type)) throw fail('Type d’événement invalide.');
    if (row.minute !== undefined && (!Number.isInteger(Number(row.minute)) || Number(row.minute) < 0 || Number(row.minute) > 130)) throw fail('La minute doit être comprise entre 0 et 130.');
  }
  for (const k of ['team_id','stadium_id','referee_id','home_id','away_id','match_id','player_id','number','capacity']) {
    if (row[k] !== undefined && row[k] !== null && row[k] !== '' && (!Number.isInteger(Number(row[k])) || Number(row[k]) < 1)) throw fail(`Le champ « ${k} » doit être un entier positif.`);
  }
}
app.post('/api/:t', admin, h(async (req, res) => {
  const t = req.params.t; if (!T[t]) throw fail('Ressource introuvable.', 404);
  const rowIn = pick(req.body || {}, T[t]); validateRow(t, rowIn);
  if (t === 'events') {
    const [match, player] = await Promise.all([
      ok(db.from('matches').select('home_id,away_id').eq('id', rowIn.match_id).maybeSingle()),
      ok(db.from('players').select('team_id').eq('id', rowIn.player_id).maybeSingle())
    ]);
    if (!match || !player) throw fail('Le match ou le joueur sélectionné est introuvable.', 400);
    if (player.team_id !== match.home_id && player.team_id !== match.away_id) throw fail('Le joueur doit appartenir à l’une des deux équipes du match.');
  }
  const row = await ok(db.from(t).insert(rowIn).select().single());
  if (t === 'events') {
    const [p, m] = await Promise.all([
      ok(db.from('players').select('name').eq('id', row.player_id).single()),
      ok(db.from('matches').select('home_id,away_id,home:teams!matches_home_id_fkey(name),away:teams!matches_away_id_fkey(name)').eq('id', row.match_id).single())
    ]);
    const notificationSaved = row.type === 'goal'
      ? await notifySafely(`But à la ${row.minute}e minute : ${p.name} — ${m.home?.name} contre ${m.away?.name}.`)
      : await notifySafely(`Carton ${row.type === 'red' ? 'rouge' : 'jaune'} à la ${row.minute}e minute pour ${p.name}.`);
    if (!notificationSaved) row.notificationWarning = 'Événement enregistré, mais la notification n’a pas pu être enregistrée.';
  }
  res.status(201).json(row);
}));
app.put('/api/:t/:id', admin, h(async (req, res) => {
  const t = req.params.t; if (!T[t]) throw fail('Ressource introuvable.', 404);
  if (!/^\d+$/.test(String(req.params.id))) throw fail('Identifiant invalide.');
  const rowIn = pick(req.body || {}, T[t]); if (!Object.keys(rowIn).length) throw fail('Aucune modification fournie.');
  validateRow(t, rowIn, true);
  const before = t === 'matches' ? await ok(db.from('matches').select('played,hg,ag,home_id,away_id,home:teams!matches_home_id_fkey(name),away:teams!matches_away_id_fkey(name)').eq('id', req.params.id).maybeSingle()) : null;
  if (t === 'matches') {
    if (!before) throw fail('Match introuvable.', 404);
    const homeId = rowIn.home_id ?? before.home_id;
    const awayId = rowIn.away_id ?? before.away_id;
    if (String(homeId) === String(awayId)) throw fail('Une équipe ne peut pas jouer contre elle-même.');
    const played = rowIn.played ?? before.played;
    const hg = rowIn.hg ?? before.hg;
    const ag = rowIn.ag ?? before.ag;
    if (played && (!Number.isInteger(Number(hg)) || !Number.isInteger(Number(ag)) || Number(hg) < 0 || Number(ag) < 0 || Number(hg) > 99 || Number(ag) > 99)) throw fail('Un résultat validé doit contenir deux scores entiers compris entre 0 et 99.');
  }
  if (t === 'events') {
    const current = await ok(db.from('events').select('match_id,player_id').eq('id', req.params.id).maybeSingle());
    if (!current) throw fail('Événement introuvable.', 404);
    const matchId = rowIn.match_id ?? current.match_id;
    const playerId = rowIn.player_id ?? current.player_id;
    const [match, player] = await Promise.all([
      ok(db.from('matches').select('home_id,away_id').eq('id', matchId).maybeSingle()),
      ok(db.from('players').select('team_id').eq('id', playerId).maybeSingle())
    ]);
    if (!match || !player) throw fail('Le match ou le joueur sélectionné est introuvable.', 400);
    if (player.team_id !== match.home_id && player.team_id !== match.away_id) throw fail('Le joueur doit appartenir à l’une des deux équipes du match.');
  }
  const updated = await ok(db.from(t).update(rowIn).eq('id', req.params.id).select().maybeSingle());
  if (!updated) throw fail('Élément introuvable.', 404);
  if (t === 'matches' && updated.played === true && (!before?.played || rowIn.hg !== undefined || rowIn.ag !== undefined)) {
    const m = await ok(db.from('matches').select('hg,ag,home:teams!matches_home_id_fkey(name),away:teams!matches_away_id_fkey(name)').eq('id', req.params.id).single());
    const notificationSaved = await notifySafely(`Résultat enregistré : ${m.home?.name} ${m.hg} - ${m.ag} ${m.away?.name}.`);
    if (!notificationSaved) updated.notificationWarning = 'Résultat enregistré, mais la notification n’a pas pu être enregistrée.';
  }
  res.json(updated);
}));
app.delete('/api/:t/:id', admin, h(async (req, res) => {
  if (!T[req.params.t]) throw fail('Ressource introuvable.', 404);
  if (!/^\d+$/.test(String(req.params.id))) throw fail('Identifiant invalide.');
  const result = await ok(db.from(req.params.t).delete().eq('id', req.params.id).select('id').maybeSingle());
  if (!result) throw fail('Élément introuvable.', 404);
  res.json({ ok: true });
}));

module.exports = app;
if (!process.env.VERCEL) app.listen(process.env.PORT || 3000, () => console.log('FOOT26 API prête sur le port ' + (process.env.PORT || 3000)));
