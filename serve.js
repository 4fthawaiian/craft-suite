const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = process.argv[2] || '.';
const PORT = parseInt(process.argv[3] || '8091', 10);
const HOST = process.argv[4] || process.env.SUITE_HOST || '0.0.0.0';
// when set, trust X-Forwarded-User from the (localhost) reverse proxy and
// scope each user's storage to storage/<app>/<email>/. Only enable behind an
// authenticating proxy bound to loopback — otherwise the header is spoofable.
const TRUST_USER = process.env.SUITE_TRUST_USER === '1';
// Google Identity Services sign-in (same flow as marsie.me admin). When
// SUITE_AUTH=1, every request must hold a session cookie issued after a
// verified Google ID token or a local username/password login.
const AUTH_ON = process.env.SUITE_AUTH === '1';
// no default: set GOOGLE_CLIENT_ID to enable the Google sign-in button
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || null;
const root = path.resolve(ROOT);
const STORAGE = path.join(root, 'storage');
const EMAILS_FILE = path.join(root, 'auth-emails.txt');
const USERS_FILE = path.join(root, 'users.json');
const SESSIONS_FILE = path.join(root, 'sessions.json');
const SESSION_TTL = 30 * 24 * 3600 * 1000;

const sessions = (() => {
  try { return new Map(Object.entries(JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')))); }
  catch { return new Map(); }
})();
const saveSessions = () => {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(Object.fromEntries(sessions)));
};

// users.json: {"users": {"email": {"role": "admin"|"user", "added": ts}}}
// authoritative user store; auth-emails.txt lines are honoured as role 'user'
// for back-compat. '*' entry = any Google account as 'user'.
function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')).users || {}; }
  catch { return {}; }
}
function saveUsers(u) {
  fs.writeFileSync(USERS_FILE, JSON.stringify({ users: u }, null, 2) + '\n');
}
const roleOf = email => (loadUsers()[email] || {}).role || null;

// ---- local accounts: scrypt-hashed passwords (node crypto, no deps) ----
const crypto = require('crypto');
const hashPassword = pw => {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.scryptSync(pw, salt, 32).toString('hex') };
};
const verifyPassword = (pw, salt, hash) =>
  crypto.timingSafeEqual(crypto.scryptSync(pw, salt, 32), Buffer.from(hash, 'hex'));

// first boot: guarantee a local admin exists so the install is never locked out
(function ensureLocalAdmin() {
  const u = loadUsers();
  if (u['admin']?.type === 'local') return;
  const pw = process.env.SUITE_ADMIN_PASSWORD ||
    crypto.randomBytes(9).toString('base64url');
  u['admin'] = { type: 'local', role: 'admin', added: Date.now(), ...hashPassword(pw) };
  saveUsers(u);
  fs.writeFileSync(path.join(root, 'local-admin-password.txt'),
    `local admin credentials — delete this file after noting:\n\n  username: admin\n  password: ${pw}\n`, { mode: 0o600 });
  console.log(`[craft-suite] created local admin 'admin' (password in local-admin-password.txt)`);
})();

function allowedEmails() {
  const u = loadUsers();
  const fromJson = Object.entries(u).map(([e, v]) => v.role === '*' ? '*' : e);
  let fromTxt = [];
  try {
    fromTxt = fs.readFileSync(EMAILS_FILE, 'utf8').split('\n')
      .map(l => l.trim().toLowerCase())
      .filter(l => l && !l.startsWith('#'));
  } catch {}
  return [...new Set([...fromJson.map(s => s.toLowerCase()), ...fromTxt])];
}



function sessionUser(req) {
  const m = /suite_session=([^;\s]+)/.exec(req.headers.cookie || '');
  const s = m && sessions.get(m[1]);
  if (!s || s.exp < Date.now()) { if (s) sessions.delete(m[1]); return null; }
  return s.email;
}

const LOGIN_PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Craft Suite — sign in</title>
<style>body{margin:0;background:#111318;color:#e8eaee;font:15px system-ui;display:flex;
align-items:center;justify-content:center;min-height:100vh}
.card{background:#1a1e26;border:1px solid #2a2f3a;border-radius:14px;padding:32px;text-align:center;max-width:320px}
h1{font-size:20px;margin:0 0 6px}p{color:#8b919e;font-size:13px;margin:0 0 22px}</style></head>
<body><div class="card"><h1>Craft Suite</h1>
__GOOGLE__
<input id="lu" placeholder="username" autocomplete="username" style="width:100%;box-sizing:border-box;background:#111318;border:1px solid #3a4150;border-radius:8px;color:#e8eaee;padding:10px 12px;font:13px system-ui;margin-bottom:8px">
<input id="lp" type="password" placeholder="password" autocomplete="current-password" style="width:100%;box-sizing:border-box;background:#111318;border:1px solid #3a4150;border-radius:8px;color:#e8eaee;padding:10px 12px;font:13px system-ui;margin-bottom:12px">
<button onclick="localLogin()" style="width:100%;background:#4d7cff;border:0;color:#fff;border-radius:8px;padding:10px;font:13px system-ui;cursor:pointer">Sign in</button>
<div id="lerr" style="color:#d98f8f;font-size:12px;margin-top:10px;min-height:14px"></div>
</div><script>
function onGoogle(r){fetch('/auth/google',{method:'POST',headers:{'Content-Type':'application/json'},
body:JSON.stringify({credential:r.credential})}).then(r=>{if(r.ok)location.reload();else r.json().then(j=>alert(j.error||'sign-in failed'))})}
function localLogin(){fetch('/auth/local',{method:'POST',headers:{'Content-Type':'application/json'},
body:JSON.stringify({username:document.getElementById('lu').value,password:document.getElementById('lp').value})})
.then(r=>{if(r.ok)location.reload();else r.json().then(j=>document.getElementById('lerr').textContent=j.error||'sign-in failed')})}
document.getElementById('lp').addEventListener('keydown',e=>{if(e.key==='Enter')localLogin()});
</script></body></html>`;

// Google sign-in UI, only injected when GOOGLE_CLIENT_ID is configured
const GOOGLE_BLOCK = GOOGLE_CLIENT_ID ? `
<p>Sign in with Google to continue</p>
<div id="g_id_onload" data-client_id="${GOOGLE_CLIENT_ID}" data-callback="onGoogle"></div>
<div class="g_id_signin" data-type="standard" data-theme="filled_black" data-width="240"></div>
<hr style="border:0;border-top:1px solid #2a2f3a;margin:22px 0">
<script src="https://accounts.google.com/gsi/client" async defer></script>` : '';

async function verifyGoogleToken(idToken) {
  if (!GOOGLE_CLIENT_ID) return null;
  const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' +
    encodeURIComponent(idToken));
  if (!r.ok) return null;
  const p = await r.json();
  if (p.aud !== GOOGLE_CLIENT_ID || p.email_verified !== 'true') return null;
  const allowed = allowedEmails();
  const email = (p.email || '').toLowerCase();
  if (!allowed.includes('*') && !allowed.includes(email)) return 'denied:' + email;
  return email;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

const safeApp = s => /^[a-z0-9-]{1,40}$/.test(s) ? s : null;
const safeName = s => {
  if (!s || s.length > 200) return null;
  const base = path.basename(s);
  return (base === s && !s.startsWith('.')) ? s : null;
};
const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify(obj));
  return true; // counts as "handled" for the /api/ dispatch
};

function issueSession(req, res, id) {
  const tok = crypto.randomBytes(24).toString('hex');
  sessions.set(tok, { email: id, exp: Date.now() + SESSION_TTL });
  saveSessions();
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Set-Cookie': `suite_session=${tok}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}${secure}`,
  });
  res.end('{"ok":true}');
}

// email-ish dir name, or null when SSO scoping is off/absent
function scopedUser(req) {
  if (TRUST_USER) {
    const u = req.headers['x-forwarded-user'];
    if (u && u.length <= 120 && /^[\w.@+-]+$/.test(u) && !u.includes('..')) return u;
  }
  if (AUTH_ON) return sessionUser(req);
  return null;
}

function filesIn(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isFile())
    .map(e => {
      const st = fs.statSync(path.join(dir, e.name));
      return { name: e.name, size: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

const isAdmin = user => user && roleOf(user) === 'admin';

function handleApi(req, res, url) {
  const user = scopedUser(req);
  const admin = isAdmin(user);

  if (url.pathname === '/api/whoami' && req.method === 'GET') {
    return json(res, 200, { user, role: user ? roleOf(user) : null, sso: TRUST_USER || AUTH_ON }), true;
  }

  // ---- user management (admin only) ----
  if (url.pathname === '/api/users' && req.method === 'GET') {
    if (!admin) return json(res, 403, { error: 'admin only' });
    const out = Object.entries(loadUsers())
      .filter(([e, v]) => v.role !== '*')
      .map(([id, v]) => ({ id, type: v.type || 'google', role: v.role || 'user' }));
    return json(res, 200, { users: out });
  }

  // create/update a local (username+password) account — body JSON
  if (url.pathname === '/api/users/savelocal' && req.method === 'POST') {
    if (!admin) return json(res, 403, { error: 'admin only' });
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const { username, password, role } = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        if (!/^[a-z0-9_.-]{2,40}$/i.test(username) || username.includes('@'))
          return json(res, 400, { error: 'bad username (2-40 chars, no @)' });
        if ((password || '').length < 6)
          return json(res, 400, { error: 'password too short (min 6)' });
        const u = loadUsers();
        u[username] = {
          type: 'local', role: role === 'admin' ? 'admin' : 'user',
          added: u[username]?.added || Date.now(), ...hashPassword(password),
        };
        saveUsers(u);
        json(res, 200, { ok: true });
      } catch { json(res, 400, { error: 'bad request' }); }
    });
    return true;
  }

  // change password — admins any local account, users only their own — body JSON
  if (url.pathname === '/api/users/password' && req.method === 'POST') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const { username, password } = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        const target = username || user;
        if (!user || (target !== user && !admin)) return json(res, 403, { error: 'not allowed' });
        const u = loadUsers();
        if (u[target]?.type !== 'local') return json(res, 400, { error: 'not a local account' });
        if ((password || '').length < 6) return json(res, 400, { error: 'password too short (min 6)' });
        Object.assign(u[target], hashPassword(password));
        saveUsers(u);
        json(res, 200, { ok: true });
      } catch { json(res, 400, { error: 'bad request' }); }
    });
    return true;
  }

  if (url.pathname === '/api/users/save' && req.method === 'POST') {
    if (!admin) return json(res, 403, { error: 'admin only' });
    const id = (url.searchParams.get('email') || '').toLowerCase();
    const role = url.searchParams.get('role') === 'admin' ? 'admin' : 'user';
    const u = loadUsers();
    const existing = u[id];
    // preserve type/credentials on role changes; new entries are google users
    if (existing) {
      u[id] = { ...existing, role };
    } else {
      if (!/^[\w.+-]+@[\w.-]+\.\w+$/.test(id)) return json(res, 400, { error: 'bad email' });
      u[id] = { type: 'google', role, added: Date.now() };
    }
    saveUsers(u);
    return json(res, 200, { ok: true });
  }

  if (url.pathname === '/api/users/remove' && req.method === 'POST') {
    if (!admin) return json(res, 403, { error: 'admin only' });
    const email = (url.searchParams.get('email') || '').toLowerCase();
    const u = loadUsers();
    if (!(email in u)) return json(res, 404, { error: 'no such user' });
    // never strand the install with zero admins
    if (u[email].role === 'admin' &&
        Object.values(u).filter(v => v.role === 'admin').length <= 1)
      return json(res, 400, { error: 'cannot remove the last admin' });
    delete u[email];
    saveUsers(u);
    return json(res, 200, { ok: true });
  }

  // all files across all apps, one call (for the landing page browser).
  // admins get every user's files, each tagged with its owner.
  if (url.pathname === '/api/files' && req.method === 'GET') {
    fs.readdir(STORAGE, { withFileTypes: true }, (err, apps) => {
      if (err && err.code !== 'ENOENT') return json(res, 500, { error: 'list failed' });
      const out = {};
      for (const d of (apps || []).filter(e => e.isDirectory())) {
        const appDir = path.join(STORAGE, d.name);
        if (admin) {
          const files = filesIn(appDir).map(f => ({ ...f, owner: null }));
          for (const sub of fs.readdirSync(appDir, { withFileTypes: true }).filter(e => e.isDirectory()))
            files.push(...filesIn(path.join(appDir, sub.name)).map(f => ({ ...f, owner: sub.name })));
          files.sort((a, b) => b.mtime - a.mtime);
          if (files.length) out[d.name] = files;
        } else {
          const files = filesIn(user ? path.join(appDir, user) : appDir);
          if (files.length) out[d.name] = files;
        }
      }
      json(res, 200, { apps: out });
    });
    return true;
  }

  const app = safeApp(url.searchParams.get('app'));
  if (!app) return json(res, 400, { error: 'bad app' });
  // admins may act on another user's dir via &user=
  const target = admin && /^[\w.@+-]+$/.test(url.searchParams.get('user') || '')
    ? url.searchParams.get('user') : user;
  const dir = target ? path.join(STORAGE, app, target) : path.join(STORAGE, app);

  if (url.pathname === '/api/list' && req.method === 'GET') {
    if (admin && !url.searchParams.get('user')) {
      // admin pickers aggregate every user's files with an owner tag
      const files = filesIn(path.join(STORAGE, app)).map(f => ({ ...f, owner: null }));
      for (const sub of fs.readdirSync(path.join(STORAGE, app), { withFileTypes: true })
          .filter(e => e.isDirectory()).map(e => e.name))
        files.push(...filesIn(path.join(STORAGE, app, sub)).map(f => ({ ...f, owner: sub })));
      files.sort((a, b) => b.mtime - a.mtime);
      return json(res, 200, { files });
    }
    fs.readdir(dir, { withFileTypes: true }, (err, entries) => {
      if (err && err.code !== 'ENOENT') return json(res, 500, { error: 'list failed' });
      const files = (entries || []).filter(e => e.isFile()).map(e => {
        const st = fs.statSync(path.join(dir, e.name));
        return { name: e.name, size: st.size, mtime: st.mtimeMs };
      }).sort((a, b) => b.mtime - a.mtime);
      json(res, 200, { files });
    });
    return true;
  }

  if (url.pathname === '/api/file' && req.method === 'GET') {
    const name = safeName(url.searchParams.get('name'));
    if (!name) return json(res, 400, { error: 'bad name' });
    fs.readFile(path.join(dir, name), (err, data) => {
      if (err) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
    return true;
  }

  if (url.pathname === '/api/save' && req.method === 'POST') {
    const name = safeName(url.searchParams.get('name'));
    if (!name) return json(res, 400, { error: 'bad name' });
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      fs.mkdir(dir, { recursive: true }, err => {
        if (err) return json(res, 500, { error: 'mkdir failed' });
        fs.writeFile(path.join(dir, name), Buffer.concat(chunks), err2 => {
          if (err2) return json(res, 500, { error: 'write failed' });
          json(res, 200, { ok: true, name, size: Buffer.concat(chunks).length });
        });
      });
    });
    return true;
  }

  if (url.pathname === '/api/rename' && req.method === 'POST') {
    const from = safeName(url.searchParams.get('from'));
    const to = safeName(url.searchParams.get('to'));
    if (!from || !to) return json(res, 400, { error: 'bad name' });
    const target = path.join(dir, to);
    if (fs.existsSync(target)) return json(res, 409, { error: 'exists' });
    fs.rename(path.join(dir, from), target, err =>
      json(res, err ? 404 : 200, err ? { error: 'not found' } : { ok: true }));
    return true;
  }

  if (url.pathname === '/api/delete' && req.method === 'POST') {
    const name = safeName(url.searchParams.get('name'));
    if (!name) return json(res, 400, { error: 'bad name' });
    fs.unlink(path.join(dir, name), err => json(res, err ? 404 : 200, err ? { error: 'not found' } : { ok: true }));
    return true;
  }

  return false;
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // auth gate: every unauthenticated request gets the login page / 401s
  if (AUTH_ON && !sessionUser(req)) {
    if ((url.pathname === '/auth/google' || url.pathname === '/auth/local') &&
        req.method === 'POST') {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', async () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
          if (url.pathname === '/auth/local') {
            const u = loadUsers()[body.username || ''];
            if (u?.type === 'local' && verifyPassword(body.password || '', u.salt, u.hash))
              return issueSession(req, res, body.username);
            return json(res, 401, { error: 'bad username or password' });
          }
          const v = await verifyGoogleToken(body.credential || '');
          if (v && !v.startsWith('denied:')) return issueSession(req, res, v);
          if (v) return json(res, 403, { error: `${v.slice(7)} is not on the allowlist` });
          json(res, 401, { error: 'google sign-in failed' });
        } catch (e) { json(res, 400, { error: 'bad request' }); }
      });
      return;
    }
    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(LOGIN_PAGE.replace('__GOOGLE__', GOOGLE_BLOCK));
      return;
    }
    return json(res, 401, { error: 'authentication required' });
  }

  if (url.pathname === '/auth/logout' && AUTH_ON) {
    const m = /suite_session=([^;\s]+)/.exec(req.headers.cookie || '');
    if (m) { sessions.delete(m[1]); saveSessions(); }
    res.writeHead(302, { 'Location': '/', 'Set-Cookie': 'suite_session=; Path=/; Max-Age=0' });
    res.end();
    return;
  }

  if (url.pathname.startsWith('/api/') && handleApi(req, res, url)) return;

  let urlPath = decodeURIComponent(url.pathname);
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  const filePath = path.resolve(root, '.' + urlPath);
  if (!filePath.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(filePath);
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    // hashed wasm/js bundles are immutable; index.html and our own files always revalidate
    const isMutable = ext === '.html' || path.basename(filePath) === 'suite-shim.js';
    headers['Cache-Control'] = isMutable ? 'no-cache' : 'public, max-age=31536000, immutable';
    res.writeHead(200, headers);
    res.end(data);
  });
}).listen(PORT, HOST, () => console.log(`serving ${ROOT} on http://${HOST}:${PORT}/`));
