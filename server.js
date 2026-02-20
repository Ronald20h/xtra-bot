require('dotenv').config();
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const app = express();

// استخدم /data لو موجود (Railway Volume) وإلا استخدم المجلد المحلي
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');

const CONFIG = {
  CLIENT_ID: process.env.CLIENT_ID,
  CLIENT_SECRET: process.env.CLIENT_SECRET,
  BOT_TOKEN: process.env.BOT_TOKEN,
  REDIRECT_URI: process.env.REDIRECT_URI,
  SESSION_SECRET: process.env.SESSION_SECRET || 'xtra-2025',
  PORT: process.env.PORT || 3000,
  ADMIN_IDS: (process.env.ADMIN_IDS || '').split(',').filter(Boolean),
  DB_PATH: path.join(DATA_DIR, 'Json-db', 'Bots'),
  PROTECT_PATH: path.join(DATA_DIR, 'protect-data.json'),
  PREMIUM_PATH: path.join(DATA_DIR, 'Json-db', 'Bots', 'tokenDB.json'),
};

const DISCORD_API = 'https://discord.com/api/v10';
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// إنشاء كل المجلدات المطلوبة عند التشغيل
const SESSION_DIR = path.join(DATA_DIR, 'sessions');
[CONFIG.DB_PATH, path.join(DATA_DIR,'Json-db'), SESSION_DIR, DATA_DIR].forEach(p => {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});
// إنشاء ملفات DB الأساسية لو مش موجودة
['tokenDB','systemDB','logsDB','ticketDB','suggestionsDB','rankDB','customCmdsDB','levelsConfigDB','rankRolesDB'].forEach(name => {
  const p = path.join(CONFIG.DB_PATH, `${name}.json`);
  if (!fs.existsSync(p)) fs.writeFileSync(p, '{}');
});
if (!fs.existsSync(CONFIG.PROTECT_PATH)) fs.writeFileSync(CONFIG.PROTECT_PATH, '{}');
if (!fs.existsSync(path.join(DATA_DIR,'Json-db','prefix.json'))) fs.writeFileSync(path.join(DATA_DIR,'Json-db','prefix.json'),'{}');

app.use(session({
  store: new FileStore({
    path: SESSION_DIR,
    ttl: 24 * 60 * 60,     // 24 ساعة بالثواني
    retries: 1,
    reapInterval: 3600,    // تنظيف كل ساعة
  }),
  secret: CONFIG.SESSION_SECRET,
  resave: true,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    secure: false,
    maxAge: 24 * 60 * 60 * 1000  // 24 ساعة
  }
}));

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

// إضافة البوت + تسجيل دخول في خطوة واحدة
app.get('/auth/add-bot/:guildId', (req,res) => {
  const { guildId } = req.params;
  // احفظ الـ guildId عشان بعد الـ callback نوديه للسيرفر ده
  req.session.pendingGuildId = guildId;
  const url = `https://discord.com/oauth2/authorize?client_id=${CONFIG.CLIENT_ID}&redirect_uri=${encodeURIComponent(CONFIG.REDIRECT_URI)}&response_type=code&scope=bot%20applications.commands%20identify%20guilds&permissions=8&guild_id=${guildId}&disable_guild_select=true`;
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
    // لو كان جاي من إضافة البوت، وديه للداشبورد مباشرة على السيرفر ده
    const targetGuild = req.session.pendingGuildId;
    if (targetGuild) {
      delete req.session.pendingGuildId;
      return res.redirect(`/dashboard?guild=${targetGuild}`);
    }
    res.redirect('/dashboard');
  } catch(err) { console.error('OAuth:',err.response?.data||err.message); res.redirect('/?error=oauth_failed'); }
});

app.get('/logout', (req,res) => { req.session.destroy(); res.redirect('/'); });

// ============ MIDDLEWARE ============
function auth(req,res,next) { if(!req.session.user) return res.status(401).json({error:'غير مسجل'}); next(); }
function adminOnly(req,res,next) {
  if(!req.session.user) return res.status(401).json({error:'غير مسجل - سجل دخول أولاً'});
  const uid = String(req.session.user.id);
  const admins = CONFIG.ADMIN_IDS.map(String);
  if(!admins.includes(uid)) {
    console.log(`[Admin Denied] User ${uid} | Allowed: [${admins.join(',')}]`);
    return res.status(403).json({error:`ليس لديك صلاحية أدمن. ID الخاص بك: ${uid}`});
  }
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
  res.json({ id:u.id, username:u.username, tag:u.discriminator==='0'?u.username:`${u.username}#${u.discriminator}`, avatar:u.avatar?`https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png`:`https://cdn.discordapp.com/embed/avatars/0.png`, isAdmin: CONFIG.ADMIN_IDS.map(String).includes(String(u.id)) });
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
    // جلب top members للـ leaderboard
    let members = [];
    try {
      const membersRes = await axios.get(`${DISCORD_API}/guilds/${id}/members?limit=1000`,{headers:{Authorization:`Bot ${CONFIG.BOT_TOKEN}`}});
      members = membersRes.data.map(m => ({id:m.user.id, username:m.user.username, avatar:m.user.avatar?`https://cdn.discordapp.com/avatars/${m.user.id}/${m.user.avatar}.png`:null}));
    } catch {}
    res.json({ guild:{id:gu.data.id,name:gu.data.name,memberCount:gu.data.approximate_member_count,icon:gu.data.icon?`https://cdn.discordapp.com/icons/${id}/${gu.data.icon}.png`:null}, channels:ch.data.filter(c=>c.type===0).map(c=>({id:c.id,name:c.name})), categories:ch.data.filter(c=>c.type===4).map(c=>({id:c.id,name:c.name})), roles:ro.data.filter(r=>r.name!=='@everyone').map(r=>({id:r.id,name:r.name,color:r.color})), members });
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
  console.log(`[PREMIUM GRANT] Guild: ${guildId} | Days: ${days||'unlimited'} | By: ${req.session.user.id}`);
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

// ============ XP / RANK SYSTEM ============
app.get('/api/guild/:id/rank', auth, guildAuth, (req,res) => {
  const {id}=req.params;
  const db = readDB('rankDB');
  const guildData = db[id] || {};
  const sorted = Object.entries(guildData)
    .sort(([,a],[,b]) => (b.level*1000+b.xp)-(a.level*1000+a.xp))
    .slice(0,50)
    .map(([userId,d],i) => ({rank:i+1, userId, level:d.level||1, xp:d.xp||0, messages:d.messages||0}));
  res.json({ leaderboard: sorted, total: Object.keys(guildData).length });
});

app.get('/api/guild/:id/rank/:userId', auth, guildAuth, (req,res) => {
  const {id, userId}=req.params;
  const db = readDB('rankDB');
  const guildData = db[id] || {};
  const user = guildData[userId] || {xp:0, level:1, messages:0};
  const sorted = Object.entries(guildData).sort(([,a],[,b])=>(b.level*1000+b.xp)-(a.level*1000+a.xp));
  const rank = sorted.findIndex(([uid])=>uid===userId)+1;
  res.json({...user, rank: rank||0, total: sorted.length});
});

app.post('/api/guild/:id/rank/reset', auth, guildAuth, (req,res) => {
  const {id}=req.params; const {userId}=req.body;
  const db = readDB('rankDB');
  if(!db[id]) return res.json({success:true});
  if(userId) delete db[id][userId];
  else db[id] = {};
  writeDB('rankDB',db);
  res.json({success:true});
});

app.get('/api/guild/:id/rank/settings', auth, guildAuth, (req,res) => {
  const {id}=req.params; const db=readDB('systemDB');
  res.json(db[id]?.rankSettings || {enabled:true, xpMin:5, xpMax:15, cooldown:60, levelUpChannel:null, levelUpMsg:'مبروك {user}! وصلت للمستوى **{level}** 🎉', noXpRoles:[], noXpChannels:[]});
});

app.post('/api/guild/:id/rank/settings', auth, guildAuth, (req,res) => {
  const {id}=req.params; const db=readDB('systemDB');
  if(!db[id]) db[id]={};
  db[id].rankSettings = {...(db[id].rankSettings||{}), ...req.body};
  writeDB('systemDB',db); res.json({success:true});
});

// ============ LEVELS SYSTEM ============
app.get('/api/guild/:id/levels', auth, guildAuth, (req,res) => {
  const {id}=req.params; const db=readDB('levelsConfigDB');
  res.json(db[id]||{enabled:false,channel:null,message:'مبروك {user}! وصلت للمستوى {level} 🎉',minXp:5,maxXp:15,multiplier:2,ignoredChannels:[]});
});
app.post('/api/guild/:id/levels', auth, guildAuth, (req,res) => {
  const {id}=req.params; const db=readDB('levelsConfigDB');
  db[id]={...db[id],...req.body}; writeDB('levelsConfigDB',db); res.json({success:true});
});
app.get('/api/guild/:id/levels/leaderboard', auth, guildAuth, async (req,res) => {
  const {id}=req.params; const db=readDB('rankDB');
  const guildData = db[id]||{};
  const sorted = Object.entries(guildData)
    .sort(([,a],[,b])=>(b.level*10000+b.xp)-(a.level*10000+a.xp))
    .slice(0,10);
  // Try to get usernames from Discord
  const result = await Promise.all(sorted.map(async ([userId,d])=>{
    let username=userId, avatar=null;
    try {
      const u = await axios.get(`https://discord.com/api/v10/users/${userId}`,{headers:{Authorization:`Bot ${CONFIG.BOT_TOKEN}`}});
      username = u.data.username;
      avatar = u.data.avatar ? `https://cdn.discordapp.com/avatars/${userId}/${u.data.avatar}.png` : null;
    } catch {}
    return {userId, username, avatar, level:d.level||1, xp:d.xp||0, messages:d.messages||0};
  }));
  res.json(result);
});

// ============ RANK ROLES ============
app.get('/api/guild/:id/rankroles', auth, guildAuth, (req,res) => {
  const {id}=req.params; const db=readDB('rankRolesDB');
  res.json(db[id]||[]);
});
app.post('/api/guild/:id/rankroles', auth, guildAuth, (req,res) => {
  const {id}=req.params; const {level,roleId,roleName}=req.body;
  if(!level||!roleId) return res.status(400).json({error:'level و roleId مطلوبان'});
  const db=readDB('rankRolesDB');
  if(!db[id]) db[id]=[];
  db[id]=db[id].filter(r=>r.level!==level); // no duplicates
  db[id].push({level:parseInt(level),roleId,roleName:roleName||roleId});
  writeDB('rankRolesDB',db);
  res.json({success:true,list:db[id]});
});
app.delete('/api/guild/:id/rankroles/:level', auth, guildAuth, (req,res) => {
  const {id,level}=req.params; const db=readDB('rankRolesDB');
  if(db[id]) db[id]=db[id].filter(r=>r.level!==parseInt(level));
  writeDB('rankRolesDB',db);
  res.json({success:true,list:db[id]||[]});
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
