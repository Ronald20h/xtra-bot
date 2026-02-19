const express = require('express');
const session = require('express-session');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const app = express();

// ============================================
// ⚙️ الإعدادات - من Environment Variables
// ============================================
const CONFIG = {
  CLIENT_ID: process.env.CLIENT_ID,
  CLIENT_SECRET: process.env.CLIENT_SECRET,
  BOT_TOKEN: process.env.BOT_TOKEN,
  REDIRECT_URI: process.env.REDIRECT_URI,
  SESSION_SECRET: process.env.SESSION_SECRET || 'xtra-secret-2025',
  PORT: process.env.PORT || 3000,
  // مسارات قواعد البيانات
  DB_PATH: path.join(__dirname, 'Json-db', 'Bots'),
  PROTECT_PATH: path.join(__dirname, 'protect-data.json'),
};

const DISCORD_API = 'https://discord.com/api/v10';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: CONFIG.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

// ============================================
// 📂 قراءة وكتابة JSON databases
// ============================================
function readDB(name) {
  try {
    const p = path.join(CONFIG.DB_PATH, `${name}.json`);
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, 'utf8')) || {};
  } catch { return {}; }
}

function writeDB(name, data) {
  try {
    const p = path.join(CONFIG.DB_PATH, `${name}.json`);
    fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch { return false; }
}

function readProtect() {
  try {
    if (!fs.existsSync(CONFIG.PROTECT_PATH)) return {};
    return JSON.parse(fs.readFileSync(CONFIG.PROTECT_PATH, 'utf8')) || {};
  } catch { return {}; }
}

function writeProtect(data) {
  try {
    fs.writeFileSync(CONFIG.PROTECT_PATH, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch { return false; }
}

// ============================================
// 🔐 Auth Routes
// ============================================
app.get('/', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/dashboard', (req, res) => {
  if (!req.session.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/auth/discord', (req, res) => {
  const url = `https://discord.com/oauth2/authorize?client_id=${CONFIG.CLIENT_ID}&redirect_uri=${encodeURIComponent(CONFIG.REDIRECT_URI)}&response_type=code&scope=identify%20guilds`;
  res.redirect(url);
});

app.get('/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/?error=no_code');
  try {
    const tokenRes = await axios.post(`${DISCORD_API}/oauth2/token`,
      new URLSearchParams({
        client_id: CONFIG.CLIENT_ID,
        client_secret: CONFIG.CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: CONFIG.REDIRECT_URI,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const { access_token } = tokenRes.data;
    const [userRes, guildsRes] = await Promise.all([
      axios.get(`${DISCORD_API}/users/@me`, { headers: { Authorization: `Bearer ${access_token}` } }),
      axios.get(`${DISCORD_API}/users/@me/guilds`, { headers: { Authorization: `Bearer ${access_token}` } })
    ]);
    req.session.user = userRes.data;
    req.session.guilds = guildsRes.data.filter(g => (g.permissions & 0x8) === 0x8 || g.owner);
    req.session.accessToken = access_token;
    res.redirect('/dashboard');
  } catch (err) {
    console.error('OAuth Error:', err.response?.data || err.message);
    res.redirect('/?error=oauth_failed');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// ============================================
// 🔒 Middleware Auth
// ============================================
function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'غير مسجل' });
  next();
}

function requireGuild(req, res, next) {
  const { id } = req.params;
  const guild = req.session.guilds?.find(g => g.id === id);
  if (!guild) return res.status(403).json({ error: 'لا صلاحية' });
  req.guild = guild;
  next();
}

// ============================================
// 👤 API - المستخدم
// ============================================
app.get('/api/me', requireAuth, (req, res) => {
  const u = req.session.user;
  res.json({
    id: u.id,
    username: u.username,
    discriminator: u.discriminator,
    tag: u.discriminator === '0' ? u.username : `${u.username}#${u.discriminator}`,
    avatar: u.avatar
      ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png`
      : `https://cdn.discordapp.com/embed/avatars/${u.id % 5}.png`
  });
});

// ============================================
// 🖥️ API - السيرفرات
// ============================================
app.get('/api/guilds', requireAuth, async (req, res) => {
  try {
    const guilds = req.session.guilds || [];
    const result = await Promise.all(guilds.map(async (g) => {
      let hasBot = false, memberCount = 0;
      try {
        const gRes = await axios.get(`${DISCORD_API}/guilds/${g.id}?with_counts=true`, {
          headers: { Authorization: `Bot ${CONFIG.BOT_TOKEN}` }
        });
        hasBot = true;
        memberCount = gRes.data.approximate_member_count || 0;
      } catch { hasBot = false; }

      // تحقق من البريميوم
      const tokenDB = readDB('tokenDB');
      const isPremium = tokenDB[g.id]?.premium === true;

      return {
        id: g.id,
        name: g.name,
        icon: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png` : null,
        memberCount,
        hasBot,
        isPremium
      };
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'خطأ في جلب السيرفرات' });
  }
});

// ============================================
// ⚙️ API - معلومات سيرفر (قنوات + رتب)
// ============================================
app.get('/api/guild/:id/info', requireAuth, requireGuild, async (req, res) => {
  const { id } = req.params;
  try {
    const [channelsRes, rolesRes, guildRes] = await Promise.all([
      axios.get(`${DISCORD_API}/guilds/${id}/channels`, { headers: { Authorization: `Bot ${CONFIG.BOT_TOKEN}` } }),
      axios.get(`${DISCORD_API}/guilds/${id}/roles`, { headers: { Authorization: `Bot ${CONFIG.BOT_TOKEN}` } }),
      axios.get(`${DISCORD_API}/guilds/${id}?with_counts=true`, { headers: { Authorization: `Bot ${CONFIG.BOT_TOKEN}` } })
    ]);
    res.json({
      guild: {
        id: guildRes.data.id,
        name: guildRes.data.name,
        memberCount: guildRes.data.approximate_member_count,
        icon: guildRes.data.icon ? `https://cdn.discordapp.com/icons/${id}/${guildRes.data.icon}.png` : null
      },
      channels: channelsRes.data.filter(c => c.type === 0).map(c => ({ id: c.id, name: c.name })),
      roles: rolesRes.data.filter(r => r.name !== '@everyone').map(r => ({ id: r.id, name: r.name, color: r.color }))
    });
  } catch (err) {
    res.status(500).json({ error: 'البوت مش موجود في السيرفر' });
  }
});

// ============================================
// 🛡️ API - الحماية
// ============================================
app.get('/api/guild/:id/protection', requireAuth, requireGuild, (req, res) => {
  const { id } = req.params;
  const data = readProtect();
  res.json(data[id] || {
    antiRaid: false, antiSpam: false, antiLink: false,
    antiAd: false, antiMention: false, antiEmoji: false,
    raidLimit: 10, raidAction: 'lock', whitelistLinks: []
  });
});

app.post('/api/guild/:id/protection', requireAuth, requireGuild, (req, res) => {
  const { id } = req.params;
  const data = readProtect();
  data[id] = { ...data[id], ...req.body };
  writeProtect(data);
  res.json({ success: true });
});

// ============================================
// 📋 API - السجلات
// ============================================
app.get('/api/guild/:id/logs', requireAuth, requireGuild, (req, res) => {
  const { id } = req.params;
  const db = readDB('logsDB');
  res.json(db[id] || {
    enabled: false, channel: null,
    memberJoin: true, memberLeave: true,
    messageEdit: true, messageDelete: true,
    punishments: true, serverChanges: false,
    voiceEvents: false, ticketEvents: true
  });
});

app.post('/api/guild/:id/logs', requireAuth, requireGuild, (req, res) => {
  const { id } = req.params;
  const db = readDB('logsDB');
  db[id] = { ...db[id], ...req.body };
  writeDB('logsDB', db);
  res.json({ success: true });
});

// ============================================
// 🎫 API - التذاكر
// ============================================
app.get('/api/guild/:id/ticket', requireAuth, requireGuild, (req, res) => {
  const { id } = req.params;
  const db = readDB('ticketDB');
  res.json(db[id] || {
    enabled: false, channel: null, category: null,
    supportRole: null, title: '🎫 نظام التذاكر',
    description: 'اضغط الزر لفتح تذكرة دعم',
    color: '#5865F2', buttonText: '📩 فتح تذكرة',
    welcomeMsg: 'مرحباً {user}! سيرد عليك الفريق قريباً.'
  });
});

app.post('/api/guild/:id/ticket', requireAuth, requireGuild, (req, res) => {
  const { id } = req.params;
  const db = readDB('ticketDB');
  db[id] = { ...db[id], ...req.body };
  writeDB('ticketDB', db);
  res.json({ success: true });
});

// ============================================
// 👋 API - الترحيب
// ============================================
app.get('/api/guild/:id/welcome', requireAuth, requireGuild, (req, res) => {
  const { id } = req.params;
  const db = readDB('systemDB');
  res.json(db[id]?.welcome || {
    enabled: false, channel: null,
    message: 'مرحباً {user} في {server}! أنت العضو رقم {count} 🎉',
    leaveEnabled: false, leaveChannel: null,
    leaveMessage: 'وداعاً {user} 👋',
    autoRole: null
  });
});

app.post('/api/guild/:id/welcome', requireAuth, requireGuild, (req, res) => {
  const { id } = req.params;
  const db = readDB('systemDB');
  if (!db[id]) db[id] = {};
  db[id].welcome = { ...db[id]?.welcome, ...req.body };
  writeDB('systemDB', db);
  res.json({ success: true });
});

// ============================================
// 🤖 API - الرد التلقائي
// ============================================
app.get('/api/guild/:id/autoresponse', requireAuth, requireGuild, (req, res) => {
  const { id } = req.params;
  const db = readDB('systemDB');
  res.json(db[id]?.autoResponse || []);
});

app.post('/api/guild/:id/autoresponse', requireAuth, requireGuild, (req, res) => {
  const { id } = req.params;
  const db = readDB('systemDB');
  if (!db[id]) db[id] = {};
  db[id].autoResponse = req.body.responses || [];
  writeDB('systemDB', db);
  res.json({ success: true });
});

// ============================================
// 👑 API - البريميوم
// ============================================
app.get('/api/guild/:id/premium', requireAuth, requireGuild, (req, res) => {
  const { id } = req.params;
  const db = readDB('tokenDB');
  res.json(db[id] || { premium: false, expiresAt: null });
});

// ============================================
// 📊 API - إحصائيات
// ============================================
app.get('/api/guild/:id/stats', requireAuth, requireGuild, async (req, res) => {
  const { id } = req.params;
  try {
    const guildRes = await axios.get(`${DISCORD_API}/guilds/${id}?with_counts=true`, {
      headers: { Authorization: `Bot ${CONFIG.BOT_TOKEN}` }
    });
    const tokenDB = readDB('tokenDB');
    const ticketDB = readDB('ticketDB');
    const openTickets = Object.values(ticketDB).filter(t => t.guildId === id && t.status === 'open').length;
    res.json({
      memberCount: guildRes.data.approximate_member_count || 0,
      onlineCount: guildRes.data.approximate_presence_count || 0,
      openTickets,
      isPremium: tokenDB[id]?.premium === true
    });
  } catch {
    res.json({ memberCount: 0, onlineCount: 0, openTickets: 0, isPremium: false });
  }
});

// ============================================
// 🚀 Start Server
// ============================================
app.listen(CONFIG.PORT, () => {
  console.log(`⚡ Xtra Dashboard running on port ${CONFIG.PORT}`);
});
