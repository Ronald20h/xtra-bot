require('dotenv').config();
const express = require('express');
const session = require('express-session');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const app = express();

const CONFIG = {
  CLIENT_ID: process.env.CLIENT_ID,
  CLIENT_SECRET: process.env.CLIENT_SECRET,
  BOT_TOKEN: process.env.BOT_TOKEN,
  REDIRECT_URI: process.env.REDIRECT_URI,
  SESSION_SECRET: process.env.SESSION_SECRET || 'xtra-2025',
  PORT: process.env.PORT || 3000,
  // ← ضع هنا ID حسابك على ديسكورد عشان تكون أدمن
  ADMIN_IDS: (process.env.ADMIN_IDS || '').split(',').filter(Boolean),
  DB_PATH: path.join(__dirname, 'Json-db', 'Bots'),
  PROTECT_PATH: path.join(__dirname, 'protect-data.json'),
  PREMIUM_PATH: path.join(__dirname, 'Json-db', 'Bots', 'tokenDB.json'),
};

const DISCORD_API = 'https://discord.com/api/v10';
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({ secret: CONFIG.SESSION_SECRET, resave: false, saveUninitialized: false, cookie: { secure: false, maxAge: 7*24*60*60*1000 } }));

// ============ DB HELPERS ============
function readDB(name) {
  try { const p = path.join(CONFIG.DB_PATH, `${name}.json`); if (!fs.existsSync(p)) return {}; return JSON.parse(fs.readFileSync(p,'utf8'))||{}; } catch { return {}; }
}
function writeDB(name, data) {
  try { fs.writeFileSync(path.join(CONFIG.DB_PATH,`${name}.json`), JSON.stringify(data,null,2),'utf8'); return true; } catch { return false; }
}
function readProtect() {
  try { if(!fs.existsSync(CONFIG.PROTECT_PATH)) return {}; return JSON.parse(fs.readFileSync(CONFIG.PROTECT_PATH,'utf8'))||{}; } catch { return {}; }
}
function writeProtect(data) {
  try { fs.writeFileSync(CONFIG.PROTECT_PATH, JSON.stringify(data,null,2),'utf8'); return true; } catch { return false; }
}

// ============ AUTH ============
app.get('/', (req,res) => { if(req.session.user) return res.redirect('/dashboard'); res.sendFile(path.join(__dirname,'public','index.html')); });
app.get('/dashboard', (req,res) => { if(!req.session.user) return res.redirect('/'); res.sendFile(path.join(__dirname,'public','dashboard.html')); });
app.get('/admin', (req,res) => { if(!req.session.user) return res.redirect('/'); if(!CONFIG.ADMIN_IDS.includes(req.session.user.id)) return res.redirect('/dashboard'); res.sendFile(path.join(__dirname,'public','admin.html')); });

app.get('/auth/discord', (req,res) => {
  const url = `https://discord.com/oauth2/authorize?client_id=${CONFIG.CLIENT_ID}&redirect_uri=${encodeURIComponent(CONFIG.REDIRECT_URI)}&response_type=code&scope=identify%20guilds`;
  res.redirect(url);
});

app.get('/callback', async (req,res) => {
  const { code } = req.query;
  if(!code) return res.redirect('/?error=no_code');
  try {
    const tokenRes = await axios.post(`${DISCORD_API}/oauth2/token`, new URLSearchParams({ client_id:CONFIG.CLIENT_ID, client_secret:CONFIG.CLIENT_SECRET, grant_type:'authorization_code', code, redirect_uri:CONFIG.REDIRECT_URI }), { headers:{'Content-Type':'application/x-www-form-urlencoded'} });
    const { access_token } = tokenRes.data;
    const [userRes,guildsRes] = await Promise.all([
      axios.get(`${DISCORD_API}/users/@me`, { headers:{Authorization:`Bearer ${access_token}`} }),
      axios.get(`${DISCORD_API}/users/@me/guilds`, { headers:{Authorization:`Bearer ${access_token}`} })
    ]);
    req.session.user = userRes.data;
    req.session.guilds = guildsRes.data.filter(g => (g.permissions & 0x8)===0x8 || g.owner);
    req.session.accessToken = access_token;
    res.redirect('/dashboard');
  } catch(err) { console.error('OAuth:',err.response?.data||err.message); res.redirect('/?error=oauth_failed'); }
});

app.get('/logout', (req,res) => { req.session.destroy(); res.redirect('/'); });

// ============ MIDDLEWARE ============
function auth(req,res,next) { if(!req.session.user) return res.status(401).json({error:'غير مسجل'}); next(); }
function adminOnly(req,res,next) {
  if(!req.session.user) return res.status(401).json({error:'غير مسجل'});
  if(!CONFIG.ADMIN_IDS.includes(req.session.user.id)) return res.status(403).json({error:'ليس لديك صلاحية أدمن'});
  next();
}
function guildAuth(req,res,next) {
  const {id}=req.params;
  const g = req.session.guilds?.find(g=>g.id===id);
  if(!g) return res.status(403).json({error:'لا صلاحية'});
  req.guild=g; next();
}

// ============ USER API ============
// ============ CONFIG (public) ============
app.get('/api/config', (req,res) => {
  res.json({ clientId: CONFIG.CLIENT_ID || '' });
});

app.get('/api/me', auth, (req,res) => {
  const u = req.session.user;
  res.json({ id:u.id, username:u.username, tag:u.discriminator==='0'?u.username:`${u.username}#${u.discriminator}`, avatar:u.avatar?`https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png`:`https://cdn.discordapp.com/embed/avatars/0.png`, isAdmin: CONFIG.ADMIN_IDS.includes(u.id) });
});

// ============ GUILDS API ============
app.get('/api/guilds', auth, async (req,res) => {
  try {
    const guilds = req.session.guilds||[];
    const tokenDB = readDB('tokenDB');
    const result = await Promise.all(guilds.map(async g => {
      let hasBot=false, memberCount=0;
      try { const r = await axios.get(`${DISCORD_API}/guilds/${g.id}?with_counts=true`,{headers:{Authorization:`Bot ${CONFIG.BOT_TOKEN}`}}); hasBot=true; memberCount=r.data.approximate_member_count||0; } catch {}
      const prem = tokenDB[g.id];
      return { id:g.id, name:g.name, icon:g.icon?`https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png`:null, memberCount, hasBot, isPremium:prem?.premium===true, premiumExpiry:prem?.expiresAt||null };
    }));
    res.json(result);
  } catch { res.status(500).json({error:'خطأ'}); }
});

app.get('/api/guild/:id/info', auth, guildAuth, async (req,res) => {
  const {id}=req.params;
  try {
    const [ch,ro,gu] = await Promise.all([
      axios.get(`${DISCORD_API}/guilds/${id}/channels`,{headers:{Authorization:`Bot ${CONFIG.BOT_TOKEN}`}}),
      axios.get(`${DISCORD_API}/guilds/${id}/roles`,{headers:{Authorization:`Bot ${CONFIG.BOT_TOKEN}`}}),
      axios.get(`${DISCORD_API}/guilds/${id}?with_counts=true`,{headers:{Authorization:`Bot ${CONFIG.BOT_TOKEN}`}})
    ]);
    res.json({ guild:{id:gu.data.id,name:gu.data.name,memberCount:gu.data.approximate_member_count,icon:gu.data.icon?`https://cdn.discordapp.com/icons/${id}/${gu.data.icon}.png`:null}, channels:ch.data.filter(c=>c.type===0).map(c=>({id:c.id,name:c.name})), categories:ch.data.filter(c=>c.type===4).map(c=>({id:c.id,name:c.name})), roles:ro.data.filter(r=>r.name!=='@everyone').map(r=>({id:r.id,name:r.name,color:r.color})) });
  } catch { res.status(500).json({error:'البوت مش موجود في السيرفر'}); }
});

app.get('/api/guild/:id/stats', auth, guildAuth, async (req,res) => {
  const {id}=req.params;
  try {
    const gu = await axios.get(`${DISCORD_API}/guilds/${id}?with_counts=true`,{headers:{Authorization:`Bot ${CONFIG.BOT_TOKEN}`}});
    const tokenDB=readDB('tokenDB'), ticketDB=readDB('ticketDB'), systemDB=readDB('systemDB');
    const openTickets = Object.values(ticketDB).filter(t=>t?.guildId===id&&t?.status==='open').length;
    const warns = Object.values(systemDB[id]?.warns||{}).reduce((a,b)=>a+(b?.length||0),0);
    res.json({ memberCount:gu.data.approximate_member_count||0, onlineCount:gu.data.approximate_presence_count||0, openTickets, warns, isPremium:tokenDB[id]?.premium===true });
  } catch { res.json({memberCount:0,onlineCount:0,openTickets:0,warns:0,isPremium:false}); }
});

// ============ PROTECTION ============
app.get('/api/guild/:id/protection', auth, guildAuth, (req,res) => {
  const {id}=req.params; const d=readProtect();
  res.json(d[id]||{antiRaid:false,antiSpam:false,antiLink:false,antiAd:false,antiMention:false,antiEmoji:false,antiCaps:false,antiSlowmode:false,raidLimit:10,spamLimit:5,raidAction:'lock',whitelistLinks:[],ignoredChannels:[],ignoredRoles:[]});
});
app.post('/api/guild/:id/protection', auth, guildAuth, (req,res) => {
  const {id}=req.params; const d=readProtect(); d[id]={...d[id],...req.body}; writeProtect(d); res.json({success:true});
});

// ============ LOGS ============
app.get('/api/guild/:id/logs', auth, guildAuth, (req,res) => {
  const {id}=req.params; const db=readDB('logsDB');
  res.json(db[id]||{enabled:false,channel:null,memberJoin:true,memberLeave:true,messageEdit:true,messageDelete:true,punishments:true,serverChanges:false,voiceEvents:false,ticketEvents:true,roleChanges:false,channelChanges:false});
});
app.post('/api/guild/:id/logs', auth, guildAuth, (req,res) => {
  const {id}=req.params; const db=readDB('logsDB'); db[id]={...db[id],...req.body}; writeDB('logsDB',db); res.json({success:true});
});

// ============ WELCOME ============
app.get('/api/guild/:id/welcome', auth, guildAuth, (req,res) => {
  const {id}=req.params; const db=readDB('systemDB');
  res.json(db[id]?.welcome||{enabled:false,channel:null,message:'مرحباً {user} في {server}! أنت العضو رقم {count} 🎉',leaveEnabled:false,leaveChannel:null,leaveMessage:'وداعاً {user} 👋',autoRole:null,dmEnabled:false,dmMessage:'أهلاً بك في {server}! 🌟'});
});
app.post('/api/guild/:id/welcome', auth, guildAuth, (req,res) => {
  const {id}=req.params; const db=readDB('systemDB'); if(!db[id])db[id]={}; db[id].welcome={...db[id]?.welcome,...req.body}; writeDB('systemDB',db); res.json({success:true});
});

// ============ AUTO RESPONSE ============
app.get('/api/guild/:id/autoresponse', auth, guildAuth, (req,res) => {
  const {id}=req.params; const db=readDB('systemDB'); res.json(db[id]?.autoResponse||[]);
});
app.post('/api/guild/:id/autoresponse', auth, guildAuth, (req,res) => {
  const {id}=req.params; const db=readDB('systemDB'); if(!db[id])db[id]={}; db[id].autoResponse=req.body.responses||[]; writeDB('systemDB',db); res.json({success:true});
});

// ============ TICKET ============
app.get('/api/guild/:id/ticket', auth, guildAuth, (req,res) => {
  const {id}=req.params; const db=readDB('ticketDB');
  res.json(db[id]?.settings||{enabled:false,channel:null,category:null,supportRole:null,title:'🎫 نظام التذاكر',description:'اضغط الزر لفتح تذكرة دعم ✅',color:'#5865F2',buttonText:'📩 فتح تذكرة',welcomeMsg:'مرحباً {user}! سيرد عليك الفريق قريباً 👋',maxTickets:1,types:[]});
});
app.post('/api/guild/:id/ticket', auth, guildAuth, (req,res) => {
  const {id}=req.params; const db=readDB('ticketDB'); if(!db[id])db[id]={}; db[id].settings={...db[id]?.settings,...req.body}; writeDB('ticketDB',db); res.json({success:true});
});

// ============ PREFIX/COMMANDS ============
app.get('/api/guild/:id/prefix', auth, guildAuth, (req,res) => {
  const {id}=req.params;
  try { const pf=JSON.parse(fs.readFileSync(path.join(__dirname,'Json-db','prefix.json'),'utf8')||'{}'); res.json({prefix:pf[id]||'!'}); } catch { res.json({prefix:'!'}); }
});
app.post('/api/guild/:id/prefix', auth, guildAuth, (req,res) => {
  const {id}=req.params; const {prefix}=req.body;
  try { const p=path.join(__dirname,'Json-db','prefix.json'); const pf=JSON.parse(fs.existsSync(p)?fs.readFileSync(p,'utf8')||'{}':'{}'); pf[id]=prefix||'!'; fs.writeFileSync(p,JSON.stringify(pf,null,2),'utf8'); res.json({success:true}); } catch { res.status(500).json({error:'خطأ'}); }
});

// ============ SUGGESTIONS ============
app.get('/api/guild/:id/suggestions', auth, guildAuth, (req,res) => {
  const {id}=req.params; const db=readDB('suggestionsDB');
  res.json(db[id]||{enabled:false,channel:null,staffChannel:null,autoThread:false});
});
app.post('/api/guild/:id/suggestions', auth, guildAuth, (req,res) => {
  const {id}=req.params; const db=readDB('suggestionsDB'); db[id]={...db[id],...req.body}; writeDB('suggestionsDB',db); res.json({success:true});
});

// ============ PREMIUM ============
app.get('/api/guild/:id/premium', auth, guildAuth, (req,res) => {
  const {id}=req.params; const db=readDB('tokenDB');
  res.json(db[id]||{premium:false,expiresAt:null,grantedBy:null,grantedAt:null});
});

// ============ ADMIN API ============
// جلب كل السيرفرات المسجلة
app.get('/api/admin/guilds', adminOnly, async (req,res) => {
  try {
    const tokenDB=readDB('tokenDB');
    const guildsRes = await axios.get(`${DISCORD_API}/users/@me/guilds`,{headers:{Authorization:`Bot ${CONFIG.BOT_TOKEN}`}});
    const guilds = guildsRes.data.map(g => ({
      id:g.id, name:g.name,
      icon:g.icon?`https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png`:null,
      premium:tokenDB[g.id]?.premium===true,
      premiumExpiry:tokenDB[g.id]?.expiresAt||null,
      grantedBy:tokenDB[g.id]?.grantedBy||null
    }));
    res.json(guilds);
  } catch(err) { console.error('Admin guilds error:', err.response?.data||err.message); res.json([]); }
});

// إعطاء بريميوم
app.post('/api/admin/premium/grant', adminOnly, (req,res) => {
  const {guildId, days} = req.body;
  if(!guildId) return res.status(400).json({error:'guildId مطلوب'});
  const db=readDB('tokenDB');
  const expiry = days ? new Date(Date.now()+(days*24*60*60*1000)).toISOString() : null;
  db[guildId] = { premium:true, expiresAt:expiry, grantedBy:req.session.user.id, grantedAt:new Date().toISOString() };
  writeDB('tokenDB',db);
  res.json({success:true, message:`تم إعطاء البريميوم للسيرفر ${guildId}`, expiry});
});

// سحب بريميوم
app.post('/api/admin/premium/revoke', adminOnly, (req,res) => {
  const {guildId}=req.body;
  if(!guildId) return res.status(400).json({error:'guildId مطلوب'});
  const db=readDB('tokenDB');
  db[guildId]={premium:false,expiresAt:null,revokedBy:req.session.user.id,revokedAt:new Date().toISOString()};
  writeDB('tokenDB',db);
  res.json({success:true,message:'تم سحب البريميوم'});
});

// كل السيرفرات البريميوم
app.get('/api/admin/premium/list', adminOnly, (req,res) => {
  const db=readDB('tokenDB');
  const premiums = Object.entries(db).filter(([,v])=>v?.premium===true).map(([id,v])=>({guildId:id,...v}));
  res.json(premiums);
});

// إحصائيات الأدمن
app.get('/api/admin/stats', adminOnly, async (req,res) => {
  try {
    const tokenDB=readDB('tokenDB');
    const premiumCount = Object.values(tokenDB).filter(v=>v?.premium===true).length;
    let totalGuilds=0;
    try { const r=await axios.get(`${DISCORD_API}/users/@me/guilds`,{headers:{Authorization:`Bot ${CONFIG.BOT_TOKEN}`}}); totalGuilds=r.data.length; } catch {}
    res.json({ totalGuilds, premiumGuilds:premiumCount, freeGuilds:totalGuilds-premiumCount });
  } catch { res.json({totalGuilds:0,premiumGuilds:0,freeGuilds:0}); }
});

// ============ CUSTOM COMMANDS NAMES ============
app.get('/api/guild/:id/custom-cmds', auth, guildAuth, (req,res) => {
  const {id}=req.params; const db=readDB('customCmdsDB');
  res.json(db[id]||{});
});
app.post('/api/guild/:id/custom-cmds', auth, guildAuth, (req,res) => {
  const {id}=req.params; const {cmdKey, newName, newDesc} = req.body;
  if(!cmdKey) return res.status(400).json({error:'cmdKey مطلوب'});
  // Validate: no spaces, no slash, max 32 chars
  if(newName && (newName.includes(' ') || newName.includes('/') || newName.length > 32))
    return res.status(400).json({error:'اسم الأمر غير صالح — بدون مسافات أو سلاش، أقصاه 32 حرف'});
  const db=readDB('customCmdsDB');
  if(!db[id]) db[id]={};
  db[id][cmdKey] = { name: newName||null, desc: newDesc||null };
  writeDB('customCmdsDB', db);
  res.json({success:true});
});
app.delete('/api/guild/:id/custom-cmds/:cmdKey', auth, guildAuth, (req,res) => {
  const {id, cmdKey}=req.params; const db=readDB('customCmdsDB');
  if(db[id]) delete db[id][cmdKey];
  writeDB('customCmdsDB', db);
  res.json({success:true});
});

app.listen(CONFIG.PORT, () => console.log(`⚡ Xtra Dashboard on port ${CONFIG.PORT}`));
