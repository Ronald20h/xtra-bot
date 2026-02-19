const express = require('express');
const session = require('express-session');
const axios = require('axios');
const path = require('path');

const app = express();

// ✅ بيقرأ المعلومات من Render Environment Variables (آمن 100%)
const CONFIG = {
  CLIENT_ID: process.env.CLIENT_ID,
  CLIENT_SECRET: process.env.CLIENT_SECRET,
  BOT_TOKEN: process.env.BOT_TOKEN,
  REDIRECT_URI: process.env.REDIRECT_URI,
  SESSION_SECRET: process.env.SESSION_SECRET || 'xtra-secret-2025',
  PORT: process.env.PORT || 3000
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

// ===== ROUTES =====

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/dashboard', (req, res) => {
  if (!req.session.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// تسجيل الدخول بديسكورد
app.get('/auth/discord', (req, res) => {
  const url = `https://discord.com/oauth2/authorize?client_id=${CONFIG.CLIENT_ID}&redirect_uri=${encodeURIComponent(CONFIG.REDIRECT_URI)}&response_type=code&scope=identify%20guilds`;
  res.redirect(url);
});

// Callback
app.get('/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/?error=no_code');

  try {
    const tokenRes = await axios.post(
      `${DISCORD_API}/oauth2/token`,
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
    req.session.guilds = guildsRes.data.filter(g => g.owner === true);
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

// ===== API =====

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'غير مسجل' });
  next();
}

// بيانات المستخدم
app.get('/api/me', requireAuth, (req, res) => {
  const u = req.session.user;
  res.json({
    id: u.id,
    username: u.username,
    tag: `${u.username}#${u.discriminator}`,
    avatar: u.avatar
      ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png`
      : `https://cdn.discordapp.com/embed/avatars/0.png`
  });
});

// السيرفرات
app.get('/api/guilds', requireAuth, async (req, res) => {
  try {
    const guilds = req.session.guilds || [];
    const result = await Promise.all(guilds.map(async (g) => {
      let hasBot = false;
      try {
        await axios.get(`${DISCORD_API}/guilds/${g.id}`, {
          headers: { Authorization: `Bot ${CONFIG.BOT_TOKEN}` }
        });
        hasBot = true;
      } catch { hasBot = false; }

      return {
        id: g.id,
        name: g.name,
        icon: g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png` : null,
        hasBot
      };
    }));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'خطأ' });
  }
});

// قنوات ورتب السيرفر
app.get('/api/guild/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  if (!req.session.guilds?.find(g => g.id === id))
    return res.status(403).json({ error: 'لا صلاحية' });

  try {
    const [channels, roles] = await Promise.all([
      axios.get(`${DISCORD_API}/guilds/${id}/channels`, { headers: { Authorization: `Bot ${CONFIG.BOT_TOKEN}` } }),
      axios.get(`${DISCORD_API}/guilds/${id}/roles`, { headers: { Authorization: `Bot ${CONFIG.BOT_TOKEN}` } })
    ]);
    res.json({
      channels: channels.data.filter(c => c.type === 0),
      roles: roles.data
    });
  } catch (err) {
    res.status(500).json({ error: 'خطأ' });
  }
});

// حفظ إعدادات
app.post('/api/guild/:id/settings', requireAuth, (req, res) => {
  if (!req.session.guilds?.find(g => g.id === req.params.id))
    return res.status(403).json({ error: 'لا صلاحية' });
  console.log('Settings saved:', req.body);
  res.json({ success: true });
});

app.listen(CONFIG.PORT, () => {
  console.log(`⚡ Xtra Dashboard running on port ${CONFIG.PORT}`);
});
