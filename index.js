require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');
const crypto = require('crypto');
const Anthropic   = require('@anthropic-ai/sdk');
const pdfParse    = require('pdf-parse');
const nodemailer  = require('nodemailer');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const pool = mysql.createPool({
  host: process.env.MYSQLHOST,
  port: parseInt(process.env.MYSQLPORT || '3306'),
  database: process.env.MYSQLDATABASE,
  user: process.env.MYSQLUSER,
  password: process.env.MYSQLPASSWORD,
  waitForConnections: true,
  connectionLimit: 10,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  connectTimeout: 20000,
});

const JWT_SECRET            = process.env.JWT_SECRET || 'dre_mobile_v2_secret_2026_hugo';
const RESEND_API_KEY        = process.env.RESEND_API_KEY || '';
const APP_URL               = process.env.APP_URL || 'https://dre-backend-v2-production.up.railway.app';
const anthropic             = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' });
const GOOGLE_CLIENT_ID      = '1052382742405-jha3u1p9e0kv63folh6326tk43kd15hn.apps.googleusercontent.com';
const GOOGLE_CLIENT_SECRET  = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_CALLBACK_URL   = 'https://dre-backend-v2-production.up.railway.app/api/auth/google/callback';

const googleSessions       = new Map(); // sessionId → { returnUrl }
const pendingRegistrations = new Map(); // email → { nome, nome_empresa, senhaHash, code, expires }
const pending2FA           = new Map(); // userId → { code, expires }

function makeOtpCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function otpEmail(nome, code, msg = 'Use o código abaixo para criar sua conta:') {
  return `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#08090b;padding:40px 20px;text-align:center">
  <div style="max-width:420px;margin:0 auto;background:#13141a;border-radius:16px;padding:36px 32px;border:1px solid #23242e">
    <div style="font-size:28px;font-weight:800;color:#f2f0e8;margin-bottom:8px">DRE<span style="color:#4ade80">Fácil</span></div>
    <p style="color:#7e7d88;margin:16px 0 8px">Olá, ${nome}!</p>
    <p style="color:#7e7d88;margin:0 0 28px">${msg}</p>
    <div style="background:#0d0e13;border-radius:12px;padding:20px;margin-bottom:24px">
      <div style="font-size:44px;font-weight:900;letter-spacing:14px;color:#4ade80;font-family:monospace">${code}</div>
    </div>
    <p style="color:#3e3d48;font-size:13px;margin:0">Válido por 10 minutos. Se não foi você, ignore este e-mail.</p>
  </div>
</div>`;
}

// ── EMAIL (Brevo REST API) ─────────────────────────────────
const BREVO_API_KEY    = process.env.BREVO_API_KEY || '';
const BREVO_FROM_EMAIL = process.env.BREVO_FROM_EMAIL || 'airchgroup@gmail.com';
const BREVO_FROM_NAME  = 'DRE Fácil';

async function sendEmail(to, subject, html) {
  if (!BREVO_API_KEY) {
    console.log('[EMAIL] BREVO_API_KEY não configurado — pulando:', subject, to);
    return;
  }
  try {
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: { name: BREVO_FROM_NAME, email: BREVO_FROM_EMAIL },
        to: [{ email: to }],
        subject,
        htmlContent: html,
      }),
    });
    if (!r.ok) console.error('[EMAIL] Brevo error:', r.status, await r.text());
    else console.log('[EMAIL] enviado para', to);
  } catch (e) {
    console.error('[EMAIL] erro:', e.message);
  }
}

// ── CRIAR / MIGRAR TABELAS ─────────────────────────────────
async function initDB() {
  const conn = await pool.getConnection();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS dre_users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        nome VARCHAR(100) NOT NULL,
        nome_empresa VARCHAR(150),
        email VARCHAR(150) NOT NULL UNIQUE,
        senha VARCHAR(255),
        provider ENUM('local','google','apple') DEFAULT 'local',
        provider_id VARCHAR(255),
        email_verificado TINYINT(1) DEFAULT 0,
        verify_token VARCHAR(64),
        reset_token VARCHAR(64),
        reset_expires DATETIME,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // Adicionar colunas novas se já existe a tabela (migração suave)
    const cols = ['nome_empresa VARCHAR(150)', 'cnpj VARCHAR(20)',
      'provider ENUM(\'local\',\'google\',\'apple\') DEFAULT \'local\'',
      'provider_id VARCHAR(255)', 'email_verificado TINYINT(1) DEFAULT 0',
      'verify_token VARCHAR(64)', 'reset_token VARCHAR(64)', 'reset_expires DATETIME',
      'two_factor_enabled TINYINT(1) DEFAULT 0'];
    for (const col of cols) {
      const colName = col.split(' ')[0];
      try { await conn.query(`ALTER TABLE dre_users ADD COLUMN ${col}`); } catch {}
    }
    await conn.query(`
      CREATE TABLE IF NOT EXISTS dre_historico (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        mes_key VARCHAR(7) NOT NULL,
        period VARCHAR(60),
        receita DECIMAL(12,2),
        custos JSON,
        total_custo DECIMAL(12,2),
        lucro DECIMAL(12,2),
        by_forn_raw JSON,
        forn_config JSON,
        saved_at DATETIME,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_user_mes (user_id, mes_key),
        FOREIGN KEY (user_id) REFERENCES dre_users(id) ON DELETE CASCADE
      )
    `);
    await conn.query(`
      CREATE TABLE IF NOT EXISTS dre_config (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL UNIQUE,
        categories JSON,
        rules JSON,
        fornecedores JSON,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES dre_users(id) ON DELETE CASCADE
      )
    `);
    try { await conn.query(`ALTER TABLE dre_config ADD COLUMN fornecedores JSON`); } catch {}
    try { await conn.query(`ALTER TABLE dre_config ADD COLUMN business_type VARCHAR(50)`); } catch {}
    try { await conn.query(`ALTER TABLE dre_config ADD COLUMN memory JSON`); } catch {}
    console.log('✓ Tabelas verificadas/criadas');
  } finally {
    conn.release();
  }
}

// ── MIDDLEWARE AUTH ────────────────────────────────────────
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token não informado' });
  try {
    req.user = jwt.verify(header.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido ou expirado' });
  }
}

function makeToken(user) {
  return jwt.sign({ id: user.id, nome: user.nome, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
}

function userPayload(u) {
  return { id: u.id, nome: u.nome, email: u.email, nome_empresa: u.nome_empresa || null, cnpj: u.cnpj || null, email_verificado: !!u.email_verificado, two_factor_enabled: !!u.two_factor_enabled };
}

// ── HEALTH CHECK ──────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected' });
  } catch (e) {
    res.status(500).json({ status: 'error', db: e.message });
  }
});

// ──────────────────────────────────────────────────────────
// AUTH ROUTES
// ──────────────────────────────────────────────────────────

// Passo 1 do cadastro: valida dados e envia código (não cria conta ainda)
app.post('/api/auth/send-register-code', async (req, res) => {
  const { nome, email, senha, nome_empresa } = req.body;
  if (!nome || !email || !senha) return res.status(400).json({ error: 'Campos obrigatórios: nome, email, senha' });
  if (senha.length < 6) return res.status(400).json({ error: 'Senha deve ter pelo menos 6 caracteres' });
  const emailLower = email.trim().toLowerCase();
  try {
    const [rows] = await pool.query('SELECT id FROM dre_users WHERE email=?', [emailLower]);
    if (rows.length) return res.status(409).json({ error: 'E-mail já cadastrado' });
    const senhaHash = await bcrypt.hash(senha, 10);
    const code = makeOtpCode();
    pendingRegistrations.set(emailLower, {
      nome: nome.trim(), nome_empresa: nome_empresa?.trim() || null,
      senhaHash, code, expires: Date.now() + 30 * 60 * 1000,
    });
    setTimeout(() => pendingRegistrations.delete(emailLower), 30 * 60 * 1000);
    await sendEmail(email, `${code} é seu código DRE Fácil`, otpEmail(nome.trim(), code));
    res.json({ ok: true });
  } catch (e) { console.error('[send-register-code]', e); res.status(500).json({ error: 'Erro interno' }); }
});

// Passo 2: valida código e cria a conta
app.post('/api/auth/confirm-register-code', async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ error: 'E-mail e código obrigatórios' });
  const emailLower = email.trim().toLowerCase();
  const pending = pendingRegistrations.get(emailLower);
  if (!pending) return res.status(400).json({ error: 'Nenhum cadastro pendente. Inicie o cadastro novamente.' });
  if (Date.now() > pending.expires) {
    pendingRegistrations.delete(emailLower);
    return res.status(400).json({ error: 'Código expirado. Inicie o cadastro novamente.' });
  }
  if (pending.code !== code.trim()) return res.status(400).json({ error: 'Código incorreto.' });
  try {
    const [result] = await pool.query(
      'INSERT INTO dre_users (nome, nome_empresa, email, senha, email_verificado) VALUES (?, ?, ?, ?, 1)',
      [pending.nome, pending.nome_empresa, emailLower, pending.senhaHash]
    );
    const user = { id: result.insertId, nome: pending.nome, email: emailLower, nome_empresa: pending.nome_empresa, email_verificado: true };
    pendingRegistrations.delete(emailLower);
    res.json({ token: makeToken(user), user: userPayload(user) });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'E-mail já cadastrado' });
    console.error('[confirm-register-code]', e); res.status(500).json({ error: 'Erro interno' });
  }
});

// Reenviar código de cadastro
app.post('/api/auth/resend-register-code', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'E-mail obrigatório' });
  const emailLower = email.trim().toLowerCase();
  const pending = pendingRegistrations.get(emailLower);
  if (!pending) return res.status(400).json({ error: 'Nenhum cadastro pendente. Inicie o cadastro novamente.' });
  pending.code = makeOtpCode();
  pending.expires = Date.now() + 30 * 60 * 1000;
  await sendEmail(email, `${pending.code} é seu código DRE Fácil`, otpEmail(pending.nome, pending.code));
  res.json({ ok: true });
});

app.post('/api/auth/register', async (req, res) => {
  const { nome, email, senha, nome_empresa } = req.body;
  if (!nome || !email || !senha) return res.status(400).json({ error: 'Campos obrigatórios: nome, email, senha' });
  try {
    const hash = await bcrypt.hash(senha, 10);
    const verifyToken = crypto.randomBytes(32).toString('hex');
    const [result] = await pool.query(
      'INSERT INTO dre_users (nome, nome_empresa, email, senha, verify_token) VALUES (?, ?, ?, ?, ?)',
      [nome.trim(), nome_empresa?.trim() || null, email.trim().toLowerCase(), hash, verifyToken]
    );
    const user = { id: result.insertId, nome: nome.trim(), email: email.trim().toLowerCase(), nome_empresa: nome_empresa?.trim() || null, email_verificado: false };
    await sendEmail(email, 'Confirme seu e-mail — DRE Fácil',
      `<p>Olá ${nome},</p><p>Clique no link abaixo para verificar seu e-mail:</p><p><a href="${APP_URL}/verify?token=${verifyToken}">Verificar e-mail</a></p><p>Se não foi você, ignore este e-mail.</p>`
    );
    res.json({ token: makeToken(user), user: userPayload(user) });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'E-mail já cadastrado' });
    console.error(e);
    res.status(500).json({ error: 'Erro interno' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) return res.status(400).json({ error: 'Informe email e senha' });
  try {
    const [rows] = await pool.query('SELECT * FROM dre_users WHERE email = ?', [email.trim().toLowerCase()]);
    if (!rows.length) return res.status(401).json({ error: 'E-mail ou senha incorretos' });
    const user = rows[0];
    if (!user.senha) return res.status(401).json({ error: 'Esta conta usa login social. Entre com Google ou Apple.' });
    const ok = await bcrypt.compare(senha, user.senha);
    if (!ok) return res.status(401).json({ error: 'E-mail ou senha incorretos' });
    if (user.two_factor_enabled) {
      const code = makeOtpCode();
      pending2FA.set(user.id, { code, expires: Date.now() + 10 * 60 * 1000 });
      setTimeout(() => pending2FA.delete(user.id), 10 * 60 * 1000);
      await sendEmail(user.email, `${code} — Código de acesso DRE Fácil`,
        otpEmail(user.nome, code, 'Use o código abaixo para acessar sua conta:'));
      return res.json({ twoFactorRequired: true, userId: user.id });
    }
    res.json({ token: makeToken(user), user: userPayload(user) });
  } catch (e) { console.error('[login]', e.message); res.status(500).json({ error: 'Erro interno: ' + e.message }); }
});

// Verificar código 2FA e retornar JWT
app.post('/api/auth/verify-2fa', async (req, res) => {
  const { userId, code } = req.body;
  if (!userId || !code) return res.status(400).json({ error: 'userId e código obrigatórios' });
  const entry = pending2FA.get(Number(userId));
  if (!entry) return res.status(400).json({ error: 'Sessão expirada. Faça o login novamente.' });
  if (Date.now() > entry.expires) {
    pending2FA.delete(Number(userId));
    return res.status(400).json({ error: 'Código expirado. Faça o login novamente.' });
  }
  if (entry.code !== code.trim()) return res.status(400).json({ error: 'Código incorreto.' });
  try {
    const [rows] = await pool.query('SELECT id, nome, nome_empresa, cnpj, email, email_verificado, two_factor_enabled FROM dre_users WHERE id=?', [Number(userId)]);
    if (!rows.length) return res.status(404).json({ error: 'Usuário não encontrado' });
    pending2FA.delete(Number(userId));
    res.json({ token: makeToken(rows[0]), user: userPayload(rows[0]) });
  } catch (e) { console.error('[verify-2fa]', e.message); res.status(500).json({ error: 'Erro interno' }); }
});

// Ativar / desativar 2FA
app.put('/api/auth/toggle-2fa', auth, async (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'Campo enabled (boolean) obrigatório' });
  try {
    await pool.query('UPDATE dre_users SET two_factor_enabled=? WHERE id=?', [enabled ? 1 : 0, req.user.id]);
    res.json({ ok: true, two_factor_enabled: enabled });
  } catch (e) { console.error('[toggle-2fa]', e.message); res.status(500).json({ error: 'Erro interno' }); }
});

app.put('/api/auth/profile', auth, async (req, res) => {
  try {
    const { nome, nome_empresa, cnpj, senha_atual, nova_senha } = req.body;
    if (!nome?.trim()) return res.status(400).json({ error: 'Nome é obrigatório.' });
    if (nova_senha) {
      if (!senha_atual) return res.status(400).json({ error: 'Informe a senha atual para alterar.' });
      const [rows] = await pool.query('SELECT senha FROM dre_users WHERE id=?', [req.user.id]);
      if (!rows[0].senha) return res.status(400).json({ error: 'Esta conta usa login social.' });
      const valid = await bcrypt.compare(senha_atual, rows[0].senha);
      if (!valid) return res.status(400).json({ error: 'Senha atual incorreta.' });
    }
    let sets = 'nome=?, nome_empresa=?, cnpj=?';
    let params = [nome.trim(), nome_empresa?.trim() || null, cnpj?.trim() || null];
    if (nova_senha) { sets += ', senha=?'; params.push(await bcrypt.hash(nova_senha, 10)); }
    params.push(req.user.id);
    await pool.query(`UPDATE dre_users SET ${sets} WHERE id=?`, params);
    const [rows] = await pool.query('SELECT id, nome, nome_empresa, cnpj, email, email_verificado, two_factor_enabled FROM dre_users WHERE id=?', [req.user.id]);
    res.json({ user: userPayload(rows[0]) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erro interno' }); }
});

app.get('/api/auth/me', auth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, nome, nome_empresa, cnpj, email, email_verificado, two_factor_enabled FROM dre_users WHERE id = ?', [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'Usuário não encontrado' });
    res.json({ user: userPayload(rows[0]) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erro interno' }); }
});

// Excluir conta
app.delete('/api/auth/account', auth, async (req, res) => {
  try {
    await pool.query('DELETE FROM dre_users WHERE id=?', [req.user.id]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erro interno' }); }
});

// ── Google OAuth — fluxo browser (sem proxy Expo) ─────────────
app.get('/api/auth/google/start', (req, res) => {
  const { session, return: returnUrl } = req.query;
  if (!session) return res.status(400).send('session required');
  googleSessions.set(session, { returnUrl: returnUrl || '' });
  setTimeout(() => googleSessions.delete(session), 5 * 60 * 1000);
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_CALLBACK_URL,
    response_type: 'code',
    scope: 'openid email profile',
    state: session,
    prompt: 'select_account',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get('/api/auth/google/callback', async (req, res) => {
  const { code, state: session, error } = req.query;
  const sess = googleSessions.get(session);
  const failRedirect = sess?.returnUrl ? `${sess.returnUrl}?error=cancelled` : null;

  if (error || !code) {
    if (failRedirect) return res.redirect(failRedirect);
    return res.send('<p>Erro. Feche esta janela.</p>');
  }
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_CALLBACK_URL, grant_type: 'authorization_code',
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('no access_token');

    const gRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const gUser = await gRes.json();
    if (!gUser.email) throw new Error('no email');

    let [rows] = await pool.query('SELECT * FROM dre_users WHERE email = ?', [gUser.email.toLowerCase()]);
    let user;
    if (rows.length) {
      user = rows[0];
      await pool.query('UPDATE dre_users SET provider=?, provider_id=?, email_verificado=1 WHERE id=?', ['google', gUser.sub, user.id]);
    } else {
      const nome = gUser.name || gUser.email.split('@')[0];
      const [result] = await pool.query(
        'INSERT INTO dre_users (nome, email, provider, provider_id, email_verificado) VALUES (?, ?, ?, ?, 1)',
        [nome, gUser.email.toLowerCase(), 'google', gUser.sub]
      );
      user = { id: result.insertId, nome, email: gUser.email.toLowerCase(), nome_empresa: null, cnpj: null, email_verificado: true };
    }

    const jwtToken = makeToken(user);
    googleSessions.delete(session);

    if (sess?.returnUrl) {
      return res.redirect(`${sess.returnUrl}?token=${encodeURIComponent(jwtToken)}`);
    }
    res.send('<html><body style="background:#08090b;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:12px;"><div style="font-size:48px">✓</div><div style="font-size:20px;font-weight:700">Autenticado!</div><div style="color:#aaa">Volte ao app.</div></body></html>');
  } catch (e) {
    console.error('[Google callback]', e);
    if (failRedirect) return res.redirect(failRedirect);
    res.send('<p>Erro. Tente novamente.</p>');
  }
});

// Google OAuth (expo-auth-session access token)
app.post('/api/auth/google', async (req, res) => {
  const { accessToken } = req.body;
  if (!accessToken) return res.status(400).json({ error: 'accessToken obrigatório' });
  try {
    const gRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!gRes.ok) return res.status(401).json({ error: 'Token do Google inválido' });
    const gUser = await gRes.json();
    if (!gUser.email) return res.status(400).json({ error: 'E-mail não obtido do Google' });

    let [rows] = await pool.query('SELECT * FROM dre_users WHERE email = ?', [gUser.email.toLowerCase()]);
    let user;
    if (rows.length) {
      user = rows[0];
      await pool.query('UPDATE dre_users SET provider=?, provider_id=?, email_verificado=1 WHERE id=?', ['google', gUser.sub, user.id]);
    } else {
      const [result] = await pool.query(
        'INSERT INTO dre_users (nome, email, provider, provider_id, email_verificado) VALUES (?, ?, ?, ?, 1)',
        [gUser.name || gUser.email.split('@')[0], gUser.email.toLowerCase(), 'google', gUser.sub]
      );
      user = { id: result.insertId, nome: gUser.name || gUser.email.split('@')[0], email: gUser.email.toLowerCase(), nome_empresa: null, cnpj: null, email_verificado: true };
    }
    res.json({ token: makeToken(user), user: userPayload(user) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erro interno' }); }
});

// Social login (Google / Apple)
app.post('/api/auth/social', async (req, res) => {
  const { provider, token, email, name } = req.body;
  if (!provider || !token) return res.status(400).json({ error: 'provider e token obrigatórios' });
  try {
    let providerEmail = email, providerName = name, providerId = null;
    // Decode token payload (Google/Apple JWT) to get sub/email
    try {
      const parts = token.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
        providerId = payload.sub;
        providerEmail = providerEmail || payload.email;
        providerName  = providerName  || payload.name || payload.given_name;
      }
    } catch {}
    if (!providerEmail) return res.status(400).json({ error: 'E-mail não obtido do provedor' });

    let [rows] = await pool.query('SELECT * FROM dre_users WHERE email = ?', [providerEmail.toLowerCase()]);
    let user;
    if (rows.length) {
      user = rows[0];
      // update provider info if needed
      await pool.query('UPDATE dre_users SET provider=?, provider_id=?, email_verificado=1 WHERE id=?', [provider, providerId, user.id]);
    } else {
      const [result] = await pool.query(
        'INSERT INTO dre_users (nome, email, provider, provider_id, email_verificado) VALUES (?, ?, ?, ?, 1)',
        [providerName || providerEmail.split('@')[0], providerEmail.toLowerCase(), provider, providerId]
      );
      user = { id: result.insertId, nome: providerName || providerEmail.split('@')[0], email: providerEmail.toLowerCase(), email_verificado: true };
    }
    res.json({ token: makeToken(user), user: userPayload(user) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erro interno' }); }
});

// Página de verificação de e-mail (link do e-mail aponta aqui)
app.get('/verify', async (req, res) => {
  const { token } = req.query;
  const page = (icon, title, msg, cor) => `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Verificar e-mail — DRE Fácil</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#08090b;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
    .card{background:#13141a;border:1px solid #23242e;border-radius:16px;padding:40px 32px;width:100%;max-width:400px;text-align:center}
    .icon{font-size:56px;margin-bottom:20px}
    h1{font-size:22px;font-weight:700;color:${cor};margin-bottom:12px}
    p{color:#888;font-size:14px;line-height:22px}
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <h1>${title}</h1>
    <p>${msg}</p>
  </div>
</body>
</html>`;

  if (!token) return res.status(400).send(page('❌', 'Link inválido', 'Token não encontrado. Verifique se o link do e-mail está completo.', '#f87171'));
  try {
    const [rows] = await pool.query('SELECT id FROM dre_users WHERE verify_token = ?', [token]);
    if (!rows.length) return res.send(page('✅', 'E-mail já verificado', 'Sua conta já está ativa. Abra o app e faça login.', '#4ade80'));
    await pool.query('UPDATE dre_users SET email_verificado=1, verify_token=NULL WHERE id=?', [rows[0].id]);
    res.send(page('✅', 'E-mail verificado!', 'Sua conta está ativa. Volte ao app e faça login.', '#4ade80'));
  } catch (e) {
    console.error('[verify]', e);
    res.status(500).send(page('⚠️', 'Erro interno', 'Tente novamente em alguns instantes.', '#facc15'));
  }
});

// Verificar e-mail (API)
app.post('/api/auth/verify-email', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token obrigatório' });
  try {
    const [rows] = await pool.query('SELECT id FROM dre_users WHERE verify_token = ?', [token]);
    if (!rows.length) return res.status(400).json({ error: 'Token inválido ou já utilizado' });
    await pool.query('UPDATE dre_users SET email_verificado=1, verify_token=NULL WHERE id=?', [rows[0].id]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erro interno' }); }
});

// Reenviar verificação (sem auth — chamado logo após o cadastro)
app.post('/api/auth/resend-verify-email', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'E-mail obrigatório' });
  try {
    const [rows] = await pool.query('SELECT id, nome FROM dre_users WHERE email=? AND email_verificado=0', [email.toLowerCase()]);
    if (rows.length) {
      const verifyToken = crypto.randomBytes(32).toString('hex');
      await pool.query('UPDATE dre_users SET verify_token=? WHERE id=?', [verifyToken, rows[0].id]);
      await sendEmail(email, 'Confirme seu e-mail — DRE Fácil',
        `<p>Olá ${rows[0].nome},</p><p>Clique no link abaixo para verificar seu e-mail:</p><p><a href="${APP_URL}/verify?token=${verifyToken}">Verificar e-mail</a></p><p>Se não foi você, ignore este e-mail.</p>`
      );
    }
    res.json({ ok: true }); // sempre ok — não revela se e-mail existe
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erro interno' }); }
});

// Reenviar verificação (com auth — para usuários já logados)
app.post('/api/auth/resend-verify', auth, async (req, res) => {
  try {
    const verifyToken = crypto.randomBytes(32).toString('hex');
    await pool.query('UPDATE dre_users SET verify_token=? WHERE id=?', [verifyToken, req.user.id]);
    const [rows] = await pool.query('SELECT nome, email FROM dre_users WHERE id=?', [req.user.id]);
    const u = rows[0];
    await sendEmail(u.email, 'Confirme seu e-mail — DRE Fácil',
      `<p>Olá ${u.nome},</p><p><a href="${APP_URL}/verify?token=${verifyToken}">Verificar e-mail</a></p>`
    );
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erro interno' }); }
});

// Esqueci senha
app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'E-mail obrigatório' });
  try {
    const [rows] = await pool.query('SELECT id, nome FROM dre_users WHERE email=?', [email.toLowerCase()]);
    if (rows.length) {
      const resetToken = crypto.randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + 3600000); // 1h
      await pool.query('UPDATE dre_users SET reset_token=?, reset_expires=? WHERE id=?', [resetToken, expires, rows[0].id]);
      await sendEmail(email, 'Redefinir senha — DRE Fácil',
        `<p>Olá ${rows[0].nome},</p><p>Clique no link para redefinir sua senha (válido por 1 hora):</p><p><a href="${APP_URL}/reset-password?token=${resetToken}">Redefinir senha</a></p>`
      );
    }
    // Sempre retorna ok para não revelar se e-mail existe
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erro interno' }); }
});

// Página de redefinição de senha (link do e-mail aponta aqui)
app.get('/reset-password', (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('<p>Token inválido.</p>');
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Redefinir senha — DRE Fácil</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#08090b;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
    .card{background:#13141a;border:1px solid #23242e;border-radius:16px;padding:40px 32px;width:100%;max-width:400px}
    h1{font-size:22px;font-weight:700;margin-bottom:8px}
    p{color:#888;font-size:14px;margin-bottom:28px}
    label{display:block;font-size:13px;color:#aaa;margin-bottom:6px}
    input{width:100%;background:#0d0e13;border:1px solid #23242e;border-radius:10px;color:#fff;font-size:16px;padding:14px 16px;margin-bottom:16px;outline:none}
    input:focus{border-color:#7c6af7}
    button{width:100%;background:#7c6af7;color:#fff;border:none;border-radius:10px;font-size:16px;font-weight:600;padding:15px;cursor:pointer;margin-top:4px}
    button:disabled{opacity:0.5;cursor:not-allowed}
    .msg{border-radius:10px;padding:12px 16px;font-size:14px;margin-top:16px;text-align:center}
    .msg.ok{background:#0d2b1a;color:#4ade80;border:1px solid #166534}
    .msg.err{background:#2b0d0d;color:#f87171;border:1px solid #991b1b}
  </style>
</head>
<body>
  <div class="card">
    <h1>Nova senha</h1>
    <p>Digite e confirme sua nova senha abaixo.</p>
    <form id="form">
      <label>Nova senha</label>
      <input type="password" id="senha" placeholder="Mínimo 8 caracteres" minlength="8" required>
      <label>Confirmar senha</label>
      <input type="password" id="confirma" placeholder="Repita a senha" required>
      <button type="submit" id="btn">Redefinir senha</button>
    </form>
    <div id="msg"></div>
  </div>
  <script>
    document.getElementById('form').addEventListener('submit', async function(e) {
      e.preventDefault();
      const senha = document.getElementById('senha').value;
      const confirma = document.getElementById('confirma').value;
      const msg = document.getElementById('msg');
      const btn = document.getElementById('btn');
      msg.className = 'msg'; msg.textContent = '';
      if (senha !== confirma) {
        msg.className = 'msg err'; msg.textContent = 'As senhas não coincidem.'; return;
      }
      if (senha.length < 8) {
        msg.className = 'msg err'; msg.textContent = 'A senha deve ter pelo menos 8 caracteres.'; return;
      }
      btn.disabled = true; btn.textContent = 'Aguarde…';
      try {
        const r = await fetch('/api/auth/reset-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: '${token}', senha })
        });
        const data = await r.json();
        if (r.ok) {
          msg.className = 'msg ok';
          msg.textContent = 'Senha redefinida com sucesso! Abra o app e faça login.';
          document.getElementById('form').style.display = 'none';
        } else {
          msg.className = 'msg err';
          msg.textContent = data.error || 'Erro ao redefinir senha.';
          btn.disabled = false; btn.textContent = 'Redefinir senha';
        }
      } catch(err) {
        msg.className = 'msg err'; msg.textContent = 'Erro de conexão. Tente novamente.';
        btn.disabled = false; btn.textContent = 'Redefinir senha';
      }
    });
  </script>
</body>
</html>`);
});

// Redefinir senha
app.post('/api/auth/reset-password', async (req, res) => {
  const { token, senha } = req.body;
  if (!token || !senha) return res.status(400).json({ error: 'Token e senha obrigatórios' });
  if (senha.length < 8) return res.status(400).json({ error: 'Senha deve ter pelo menos 8 caracteres' });
  try {
    const [rows] = await pool.query('SELECT id FROM dre_users WHERE reset_token=? AND reset_expires > NOW()', [token]);
    if (!rows.length) return res.status(400).json({ error: 'Token inválido ou expirado' });
    const hash = await bcrypt.hash(senha, 10);
    await pool.query('UPDATE dre_users SET senha=?, reset_token=NULL, reset_expires=NULL WHERE id=?', [hash, rows[0].id]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erro interno' }); }
});

// ──────────────────────────────────────────────────────────
// AI SUGGEST CATEGORIES (onboarding — tipo "Outro")
// ──────────────────────────────────────────────────────────
app.post('/api/ai/suggest-categories', auth, async (req, res) => {
  const { description } = req.body;
  if (!description?.trim()) return res.status(400).json({ error: 'Descrição obrigatória' });
  const palette = ['#f87171','#60a5fa','#a78bfa','#fbbf24','#fb923c','#34d399','#94a3b8','#f472b6','#22d3ee','#818cf8'];
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `Você é um contador brasileiro especializado em MEI e pequenas empresas.
O usuário descreveu seu negócio assim: "${description.trim()}"

Gere categorias de custo/despesa para o DRE deste negócio e regras de palavras-chave para classificação automática.

Responda SOMENTE com JSON válido neste formato exato:
{
  "businessLabel": "Nome curto do tipo de negócio (máx 20 chars, ex: Pet Shop, Academia, Artesanato)",
  "categories": [
    { "name": "Nome da categoria", "cost": true }
  ],
  "rules": [
    { "keyword": "PALAVRA", "category": "Nome da categoria" }
  ]
}

Instruções:
- Gere entre 5 e 8 categorias de custo relevantes para este negócio específico
- Sempre inclua Impostos/Taxas e, se aplicável, Funcionários/Salários
- Keywords em MAIÚSCULO, referenciando categorias da lista acima
- Entre 8 e 15 regras de palavras-chave comuns para este setor no Brasil
- Apenas JSON, sem texto extra`,
      }],
    });
    const text = msg.content[0].text.trim();
    const match = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : text);
    parsed.categories = (parsed.categories || []).map((c, i) => ({ ...c, color: palette[i % palette.length] }));
    res.json(parsed);
  } catch (e) {
    console.error('[suggest-categories]', e.message);
    res.status(500).json({ error: 'Erro ao gerar categorias.' });
  }
});

// ──────────────────────────────────────────────────────────
// AI CLASSIFY (Claude — chave oculta no backend)
// ──────────────────────────────────────────────────────────
app.post('/api/ai/classify', auth, async (req, res) => {
  const { transactions, rules = [], fornConfig = [], categories = [], businessType = '' } = req.body;
  if (!transactions?.length) return res.status(400).json({ error: 'Transações obrigatórias' });
  try {
    const rulesText = rules.length
      ? `\nRegras personalizadas (prioridade MÁXIMA — sempre obedeça):\n${rules.map(r=>`- Se a descrição contiver "${r.keyword}" → categoria: "${r.category}"`).join('\n')}`
      : '';
    const fornText = fornConfig.length
      ? `\nFornecedores conhecidos desta empresa: ${fornConfig.map(f=>f.nome||f.name).join(', ')}`
      : '';
    const costCats = categories.filter(c => c.cost && !c.neutral).map(c => c.name);
    const otherCats = categories.filter(c => !c.cost || c.neutral).map(c => c.name);
    const hasCats = costCats.length > 0;
    const catList = hasCats
      ? `"Receita", ${costCats.map(c => `"${c}"`).join(', ')}${otherCats.length ? ', ' + otherCats.map(c => `"${c}"`).join(', ') : ''}, "Outros"`
      : '"Receita", "Fornecedores", "Operacional", "Marketing", "Impostos", "Pessoal", "Retirada PF", "Transferência Interna", "Outros"';
    const businessCtx = businessType ? `\nTipo de negócio: ${businessType}` : '';
    const sample = transactions.slice(0, 200);
    const catDescriptions = {
      'Fornecedores':         'compras de mercadoria, fábricas, fornecedores, frete de compra, matéria-prima',
      'Operacional':          'aluguel, energia, telefone, internet, sistema, embalagem, tarifas bancárias, taxas de marketplace, manutenção',
      'Marketing':            'anúncios, publicidade, influencer, Meta Ads, Google Ads, tráfego pago',
      'Impostos':             'DAS, DARF, INSS, FGTS, SIMPLES, GNRE, tributos, guia de pagamento fiscal',
      'Pessoal':              'salário, pró-labore, adiantamento, funcionário, folha de pagamento',
      'Retirada PF':          'saques, transferências para conta pessoal do sócio, retiradas do dono',
      'Transferência Interna':'transferência entre contas próprias, resgate de CDB/investimento, pagamento de fatura do próprio cartão',
      'Assinaturas':          'assinaturas mensais, software, SaaS, Netflix, Spotify, ferramentas digitais',
      'Alimentação':          'supermercado, restaurante, delivery, alimentação',
      'Transporte':           'combustível, Uber, transporte, pedágio, estacionamento',
      'Saúde':                'farmácia, médico, plano de saúde, exame',
    };
    const catDescText = costCats.map(c => catDescriptions[c] ? `- ${c}: ${catDescriptions[c]}` : `- ${c}`).join('\n');

    const prompt = `Você é um contador brasileiro especializado em DRE para MEI e pequenas empresas.${businessCtx}
${rulesText}${fornText}

CATEGORIAS DISPONÍVEIS (use SOMENTE estas, nunca invente outras):
${catList}

Descrição de cada categoria de custo:
${catDescText}

Regras de classificação:
- valor > 0 (entrada/crédito) → "Receita" (salvo se regra personalizada indicar diferente)
- Pix recebido, TED recebida, boleto recebido → "Receita"
- RESGATE DE CDB, resgate de investimento → "Transferência Interna"
- Pagamento de fatura de cartão (PGTO FAT, FAT CARTAO) → "Transferência Interna"
- Saques (SAQUE BANCO) → "Retirada PF" se disponível, senão "Outros"
- Transferência entre contas do mesmo titular → "Transferência Interna"
- Tarifas bancárias, IOF, SEGURO CONTA → "Operacional" ou categoria mais próxima
- Se tiver regra personalizada para a palavra-chave, ela tem PRIORIDADE MÁXIMA

Transações (id, descricao, valor):
${JSON.stringify(sample)}

Retorne SOMENTE JSON válido: [{"id":NUMBER,"categoria":"NOME_EXATO_DA_CATEGORIA"}]
Sem texto extra, sem markdown.`;

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });

    let results;
    try {
      const text = msg.content[0].text.trim();
      const match = text.match(/\[[\s\S]*\]/);
      results = JSON.parse(match ? match[0] : text);
    } catch {
      results = transactions.map(t => ({ id: t.id, categoria: t.valor < 0 ? 'Outros' : 'Receita' }));
    }

    res.json({ results });
  } catch (e) {
    console.error('[AI classify]', e.message);
    res.status(500).json({ error: 'Erro na classificação IA.' });
  }
});

app.post('/api/ai/parse-pdf', auth, async (req, res) => {
  const { base64, bankHint = 'auto' } = req.body;
  if (!base64) return res.status(400).json({ error: 'base64 obrigatório' });
  try {
    // Tenta extrair texto primeiro (PDFs em texto puro)
    const buffer = Buffer.from(base64, 'base64');
    let textLines = [];
    try {
      const pdf = await pdfParse(buffer);
      textLines = (pdf.text || '').split('\n').map(l => l.trim()).filter(l => l.length > 2);
      console.log(`[parse-pdf] banco=${bankHint} páginas=${pdf.numpages} linhas=${textLines.length}`);
    } catch (parseErr) {
      console.log('[parse-pdf] pdf-parse falhou, usando visão:', parseErr.message);
    }

    const prompt = `Você é um especialista em extratos bancários e faturas de cartão de crédito brasileiros.
${bankHint !== 'auto' ? `Banco/cartão: ${bankHint}.` : ''}
Identifique TODAS as transações financeiras neste documento.

Retorne SOMENTE JSON válido, sem texto extra:
{"transactions":[{"data":"DD/MM/AAAA ou vazio","descricao":"descrição","valor":número}]}

Regras: valor negativo=débito/saída, positivo=crédito/entrada.
Se não encontrar transações: {"transactions":[]}`;

    let msg;
    if (textLines.length >= 5) {
      // PDF com texto: envia o texto extraído
      const sample = textLines.slice(0, 150).join('\n');
      msg = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 8192,
        messages: [{ role: 'user', content: `${prompt}\n\nTexto do PDF:\n\`\`\`\n${sample}\n\`\`\`` }],
      });
    } else {
      // PDF escaneado: envia o PDF direto para o Claude com visão
      console.log('[parse-pdf] PDF escaneado — usando visão da IA');
      msg = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 8192,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: base64 },
            },
            { type: 'text', text: prompt },
          ],
        }],
      });
    }

    const text = msg.content[0].text.trim();
    console.log('[parse-pdf] resposta IA:', text.slice(0, 300));
    const match = text.match(/\{[\s\S]*\}/);
    const result = JSON.parse(match ? match[0] : text);
    console.log(`[parse-pdf] transações: ${result.transactions?.length ?? 0}`);
    res.json(result);
  } catch (e) {
    console.error('[AI parse-pdf]', e.message);
    res.status(500).json({ error: 'Não foi possível processar o PDF.' });
  }
});

app.post('/api/ai/parse-extract', auth, async (req, res) => {
  const { lines, bankHint = 'auto' } = req.body;
  if (!lines?.length) return res.status(400).json({ error: 'Linhas do extrato obrigatórias' });
  try {
    const sample = lines.slice(0, 30).join('\n');
    const prompt = `Você é um especialista em extratos bancários brasileiros.
Analise as primeiras linhas deste extrato bancário e identifique sua estrutura.
${bankHint !== 'auto' ? `Banco informado pelo usuário: ${bankHint}` : ''}

Linhas do arquivo:
\`\`\`
${sample}
\`\`\`

Retorne SOMENTE JSON válido com este formato exato:
{
  "banco": "nome do banco identificado",
  "separador": "," ou ";",
  "linhaHeader": NUMBER (índice 0-based da linha com cabeçalhos),
  "colunas": {
    "data": "nome exato da coluna de data ou null",
    "descricao": "nome exato da coluna de descrição/histórico",
    "valor": "nome exato da coluna de valor único ou null",
    "entrada": "nome exato da coluna de crédito/entrada ou null",
    "saida": "nome exato da coluna de débito/saída ou null",
    "tipo": "nome exato da coluna D/C ou null"
  },
  "observacoes": "qualquer observação relevante sobre o formato"
}
Sem texto extra.`;

    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = msg.content[0].text.trim();
    const match = text.match(/\{[\s\S]*\}/);
    const result = JSON.parse(match ? match[0] : text);
    res.json(result);
  } catch (e) {
    console.error('[AI parse-extract]', e.message);
    res.status(500).json({ error: 'Não foi possível identificar o formato do extrato.' });
  }
});

// ──────────────────────────────────────────────────────────
// DRE ROUTES
// ──────────────────────────────────────────────────────────
app.get('/api/dre/list', auth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT mes_key, period, receita, total_custo, lucro, saved_at FROM dre_historico WHERE user_id = ? ORDER BY mes_key DESC',
      [req.user.id]
    );
    res.json({ list: rows.map(r => ({ ...r, receita: parseFloat(r.receita), total_custo: parseFloat(r.total_custo), lucro: parseFloat(r.lucro) })) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erro interno' }); }
});

app.get('/api/dre/:mesKey', auth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM dre_historico WHERE user_id=? AND mes_key=?',
      [req.user.id, req.params.mesKey]
    );
    if (!rows.length) return res.status(404).json({ error: 'DRE não encontrada' });
    const r = rows[0];
    res.json({ dre: { ...r, receita: parseFloat(r.receita), total_custo: parseFloat(r.total_custo), lucro: parseFloat(r.lucro) } });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erro interno' }); }
});

app.post('/api/dre/save', auth, async (req, res) => {
  const { mes_key, period, receita, custos, total_custo, lucro, by_forn_raw, saved_at } = req.body;
  if (!mes_key) return res.status(400).json({ error: 'mes_key obrigatório' });
  try {
    await pool.query(
      `INSERT INTO dre_historico (user_id, mes_key, period, receita, custos, total_custo, lucro, by_forn_raw, saved_at)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE period=VALUES(period),receita=VALUES(receita),custos=VALUES(custos),
       total_custo=VALUES(total_custo),lucro=VALUES(lucro),by_forn_raw=VALUES(by_forn_raw),saved_at=VALUES(saved_at)`,
      [req.user.id, mes_key, period||null, receita??0, JSON.stringify(custos??{}), total_custo??0, lucro??0, JSON.stringify(by_forn_raw??{}), saved_at ? new Date(saved_at) : new Date()]
    );
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erro interno' }); }
});

app.delete('/api/dre/:mesKey', auth, async (req, res) => {
  try {
    await pool.query('DELETE FROM dre_historico WHERE user_id=? AND mes_key=?', [req.user.id, req.params.mesKey]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erro interno' }); }
});

// Legacy routes (compatibilidade com frontend web)
app.get('/api/historico', auth, async (req, res) => {
  const { data } = await require('axios').get(`http://localhost:${PORT}/api/dre/list`, { headers: { Authorization: req.headers.authorization } }).catch(()=>({data:{list:[]}}));
  res.json(data.list || []);
});

// ──────────────────────────────────────────────────────────
// CONFIG ROUTES
// ──────────────────────────────────────────────────────────
app.get('/api/config', auth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT categories, rules, fornecedores, business_type, memory FROM dre_config WHERE user_id=?', [req.user.id]);
    if (!rows.length) return res.json({ config: { categories: null, rules: [], fornecedores: [], business_type: null, memory: {} } });
    const r = rows[0];
    res.json({ config: { categories: r.categories, rules: r.rules || [], fornecedores: r.fornecedores || [], business_type: r.business_type || null, memory: r.memory || {} } });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erro interno' }); }
});

app.put('/api/config', auth, async (req, res) => {
  const { categories, rules, fornecedores, business_type, memory } = req.body;
  try {
    await pool.query(
      `INSERT INTO dre_config (user_id, categories, rules, fornecedores, business_type, memory)
       VALUES (?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE categories=VALUES(categories),rules=VALUES(rules),fornecedores=VALUES(fornecedores),business_type=VALUES(business_type),memory=VALUES(memory)`,
      [req.user.id, JSON.stringify(categories??null), JSON.stringify(rules??[]), JSON.stringify(fornecedores??[]), business_type||null, JSON.stringify(memory??{})]
    );
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erro interno' }); }
});

app.patch('/api/memory', auth, async (req, res) => {
  const { key, categoria } = req.body;
  if (!key || !categoria) return res.status(400).json({ error: 'key e categoria obrigatórios' });
  try {
    await pool.query(
      `INSERT INTO dre_config (user_id, memory) VALUES (?, JSON_OBJECT(?, ?))
       ON DUPLICATE KEY UPDATE memory = JSON_SET(COALESCE(memory, '{}'), CONCAT('$.', ?), ?)`,
      [req.user.id, key, categoria, key, categoria]
    );
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erro interno' }); }
});

// POST legado
app.post('/api/config', auth, async (req, res) => {
  req.method = 'PUT'; res.req = req;
  const { categories, rules, fornecedores } = req.body;
  try {
    await pool.query(
      `INSERT INTO dre_config (user_id, categories, rules, fornecedores) VALUES (?,?,?,?)
       ON DUPLICATE KEY UPDATE categories=VALUES(categories),rules=VALUES(rules),fornecedores=VALUES(fornecedores)`,
      [req.user.id, JSON.stringify(categories??null), JSON.stringify(rules??[]), JSON.stringify(fornecedores??[])]
    );
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Erro interno' }); }
});

// ──────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', version: '2.0' }));

const PORT = parseInt(process.env.PORT || '3001');

// Servidor sobe imediatamente — banco inicializa com retry em background
app.listen(PORT, () => console.log(`DRE Fácil API v2 rodando na porta ${PORT}`));

async function initDBWithRetry() {
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      await initDB();
      console.log('✓ Banco conectado e tabelas verificadas');
      return;
    } catch (e) {
      console.error(`[DB] Tentativa ${attempt} falhou: ${e.message} — nova tentativa em 15s`);
      await new Promise(r => setTimeout(r, 15000));
    }
  }
}
initDBWithRetry();
