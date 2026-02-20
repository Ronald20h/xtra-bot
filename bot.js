require('dotenv').config();
const {
  Client, GatewayIntentBits, Partials, EmbedBuilder,
  PermissionFlagsBits, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, ChannelType, Events, REST, Routes
} = require('discord.js');
const fs   = require('fs');
const path = require('path');

// =====================================================
// =================== DB HELPERS =====================
// =====================================================
const DATA_DIR     = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
const DB_PATH      = path.join(DATA_DIR, 'Json-db', 'Bots');
const PROTECT_PATH = path.join(DATA_DIR, 'protect-data.json');
const PREFIX_PATH  = path.join(DATA_DIR, 'Json-db', 'prefix.json');

[DB_PATH, path.join(DATA_DIR,'Json-db'), path.join(DATA_DIR,'sessions'), DATA_DIR].forEach(p=>{
  if(!fs.existsSync(p)) fs.mkdirSync(p,{recursive:true});
});

function readDB(name){
  try{const p=path.join(DB_PATH,`${name}.json`);if(!fs.existsSync(p))return{};return JSON.parse(fs.readFileSync(p,'utf8'))||{};}catch{return{};}
}
function writeDB(name,data){
  try{fs.writeFileSync(path.join(DB_PATH,`${name}.json`),JSON.stringify(data,null,2));return true;}catch{return false;}
}
function readProtect(){
  try{if(!fs.existsSync(PROTECT_PATH))return{};return JSON.parse(fs.readFileSync(PROTECT_PATH,'utf8'))||{};}catch{return{};}
}
function getPrefix(guildId){
  try{if(!fs.existsSync(PREFIX_PATH))return'!';return JSON.parse(fs.readFileSync(PREFIX_PATH,'utf8'))[guildId]||'!';}catch{return'!';}
}
function isPremium(guildId){
  const db=readDB('tokenDB'),prem=db[guildId];
  if(!prem||!prem.premium)return false;
  if(prem.expiresAt&&new Date(prem.expiresAt)<new Date()){db[guildId].premium=false;writeDB('tokenDB',db);return false;}
  return true;
}
function getRankSettings(guildId){
  return readDB('systemDB')[guildId]?.rankSettings||{enabled:true,xpMin:5,xpMax:15,cooldown:60,levelUpChannel:null,levelUpMsg:'مبروك {user}! وصلت للمستوى **{level}** 🎉',noXpRoles:[],noXpChannels:[]};
}

// =====================================================
// =================== CLIENT =========================
// =====================================================
const client = new Client({
  intents:[
    GatewayIntentBits.Guilds,GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildPresences,GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildVoiceStates,GatewayIntentBits.DirectMessages,
  ],
  partials:[Partials.Message,Partials.Channel,Partials.GuildMember]
});

const spamTracker = new Map();
const raidTracker = new Map();
const afkUsers    = new Map();
const xpCooldown  = new Map();

// =====================================================
// =================== EMBEDS =========================
// =====================================================
const C={success:'#57f287',error:'#ed4245',info:'#5865F2',warn:'#fee75c',prem:'#f5a742'};

function E(color,title,desc,fields=[]){
  const e=new EmbedBuilder().setColor(C[color]||color).setTimestamp();
  if(title)e.setTitle(title);
  if(desc) e.setDescription(desc);
  if(fields.length)e.addFields(fields);
  return e;
}
function noPerms(msg,perm=''){return msg.reply({embeds:[E('error','❌ لا صلاحية',`تحتاج صلاحية **${perm}** لاستخدام هذا الأمر.`)]});}
function botNoPerms(msg){return msg.reply({embeds:[E('error','❌ البوت بدون صلاحية','تأكد إن رتبة البوت فوق رتبة العضو المستهدف.')]});}
function premReq(msg){return msg.reply({embeds:[E('prem','👑 ميزة بريميوم',
  'هذا الأمر متاح فقط للسيرفرات **بريميوم**!\n\n**للاشتراك بـ $1 فقط:**\n> افتح تكت: https://discord.com/channels/1440311353922555917/1447358530926547086\n> سيرفر الدعم: https://discord.gg/U3HNCzccbP'
)]});}
function parseDur(s){
  if(!s)return null;
  const m=s.match(/^(\d+)(s|m|h|d)$/i);
  if(!m)return null;
  const n=parseInt(m[1]);
  return{s:n*1000,m:n*60000,h:n*3600000,d:n*86400000}[m[2].toLowerCase()]||null;
}
function durTxt(ms){
  if(ms>=86400000)return`${Math.floor(ms/86400000)} يوم`;
  if(ms>=3600000) return`${Math.floor(ms/3600000)} ساعة`;
  if(ms>=60000)   return`${Math.floor(ms/60000)} دقيقة`;
  return`${Math.floor(ms/1000)} ثانية`;
}

// =====================================================
// =================== LOG ============================
// =====================================================
async function sendLog(guild,type,embedData){
  try{
    const cfg=readDB('logsDB')[guild.id];
    if(!cfg?.enabled||!cfg?.channel)return;
    const map={memberJoin:'memberJoin',memberLeave:'memberLeave',messageEdit:'messageEdit',messageDelete:'messageDelete',punishment:'punishments',ticket:'ticketEvents',voice:'voiceEvents',role:'roleChanges',channel:'channelChanges',server:'serverChanges'};
    const field=map[type];
    if(field&&cfg[field]===false)return;
    const ch=await guild.channels.fetch(cfg.channel).catch(()=>null);
    if(ch)await ch.send({embeds:[embedData]});
  }catch{}
}

// =====================================================
// =================== XP SYSTEM ======================
// =====================================================
async function addXP(message){
  const guildId=message.guild.id,userId=message.author.id;
  const cfg=getRankSettings(guildId);
  if(cfg.enabled===false)return;
  const key=userId+guildId,now=Date.now();
  const cdMs=(cfg.cooldown||60)*1000;
  if(xpCooldown.has(key)&&now-xpCooldown.get(key)<cdMs)return;
  xpCooldown.set(key,now);
  if((cfg.noXpChannels||[]).includes(message.channelId))return;
  if((cfg.noXpRoles||[]).some(r=>message.member?.roles.cache.has(r)))return;
  const db=readDB('rankDB');
  if(!db[guildId])db[guildId]={};
  if(!db[guildId][userId])db[guildId][userId]={xp:0,level:1,messages:0};
  const user=db[guildId][userId];
  const multi=isPremium(guildId)?(cfg.multiplier||2):1;
  const xpGain=Math.floor(Math.random()*((cfg.xpMax||15)-(cfg.xpMin||5)+1)+(cfg.xpMin||5))*multi;
  user.xp+=xpGain;user.messages++;
  const nextXp=user.level*100;
  if(user.xp>=nextXp){
    user.level++;user.xp=0;
    const lvlMsg=(cfg.levelUpMsg||'مبروك {user}! وصلت للمستوى **{level}** 🎉')
      .replace(/{user}/g,`${message.author}`).replace(/{level}/g,user.level).replace(/{xp}/g,nextXp);
    let notifCh=message.channel;
    if(cfg.levelUpChannel)notifCh=await message.guild.channels.fetch(cfg.levelUpChannel).catch(()=>message.channel);
    await notifCh.send({embeds:[E('prem','⭐ ترقية مستوى!',lvlMsg)]});
    // Rank roles
    const rr=(readDB('rankRolesDB')[guildId]||[]).find(r=>r.level===user.level);
    if(rr){
      const role=message.guild.roles.cache.get(rr.roleId);
      if(role&&message.member){
        await message.member.roles.add(role).catch(()=>{});
        await notifCh.send({embeds:[E('prem','🏆 رتبة جديدة!',`${message.author} حصل على رتبة **${role.name}** للمستوى **${user.level}**! 🎉`)]});
      }
    }
  }
  writeDB('rankDB',db);
}

// =====================================================
// =================== READY ==========================
// =====================================================
client.once(Events.ClientReady,async()=>{
  console.log(`✅ ${client.user.tag} شغّال!`);
  client.user.setActivity('⚡ Xtra System | !help',{type:2});
  const slashCmds=[
    {name:'ping',description:'سرعة استجابة البوت'},
    {name:'help',description:'قائمة الأوامر'},
    {name:'serverinfo',description:'معلومات السيرفر'},
    {name:'userinfo',description:'معلومات عضو',options:[{name:'user',description:'العضو',type:6,required:false}]},
    {name:'avatar',description:'صورة البروفايل',options:[{name:'user',description:'العضو',type:6,required:false}]},
    {name:'rank',description:'مستواك وXP',options:[{name:'user',description:'العضو',type:6,required:false}]},
    {name:'leaderboard',description:'لوحة المتصدرين'},
    {name:'ban',description:'حظر عضو',options:[{name:'user',description:'العضو',type:6,required:true},{name:'reason',description:'السبب',type:3,required:false}]},
    {name:'kick',description:'طرد عضو',options:[{name:'user',description:'العضو',type:6,required:true},{name:'reason',description:'السبب',type:3,required:false}]},
    {name:'warn',description:'تحذير عضو',options:[{name:'user',description:'العضو',type:6,required:true},{name:'reason',description:'السبب',type:3,required:true}]},
    {name:'warns',description:'تحذيرات عضو',options:[{name:'user',description:'العضو',type:6,required:false}]},
    {name:'mute',description:'كتم عضو',options:[{name:'user',description:'العضو',type:6,required:true},{name:'duration',description:'المدة (10m,1h)',type:3,required:false},{name:'reason',description:'السبب',type:3,required:false}]},
    {name:'unmute',description:'رفع كتم',options:[{name:'user',description:'العضو',type:6,required:true}]},
    {name:'purge',description:'حذف رسائل',options:[{name:'amount',description:'العدد',type:4,required:true,min_value:1,max_value:100}]},
    {name:'poll',description:'تصويت',options:[{name:'question',description:'السؤال',type:3,required:true},{name:'option1',description:'خيار 1',type:3,required:true},{name:'option2',description:'خيار 2',type:3,required:true}]},
  ];
  try{
    const rest=new REST({version:'10'}).setToken(process.env.BOT_TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id),{body:slashCmds});
    console.log('✅ Slash commands registered');
  }catch(e){console.error('Slash error:',e.message);}
});

// =====================================================
// ================ MESSAGE HANDLER ===================
// =====================================================
client.on(Events.MessageCreate,async message=>{
  if(!message.guild||message.author.bot)return;
  const guildId=message.guild.id;
  const prefix=getPrefix(guildId);
  const prem=isPremium(guildId);

  // XP
  await addXP(message).catch(()=>{});
  // Protection
  await handleProtection(message,guildId).catch(()=>{});
  // Auto Response
  await handleAutoResponse(message,guildId).catch(()=>{});

  // AFK check - if user comes back
  if(afkUsers.has(message.author.id)){
    afkUsers.delete(message.author.id);
    message.reply({embeds:[E('info','👋 أهلاً بعودتك!','تم إلغاء وضع AFK الخاص بك.')]}).catch(()=>{});
  }
  // Mention AFK user
  message.mentions.users.forEach(u=>{
    if(afkUsers.has(u.id)){
      const a=afkUsers.get(u.id);
      message.reply({embeds:[E('warn',`💤 ${u.username} في وضع AFK`,`**السبب:** ${a.reason}\n**منذ:** <t:${Math.floor(a.time/1000)}:R>`)]}).catch(()=>{});
    }
  });

  if(!message.content.startsWith(prefix))return;
  const args=message.content.slice(prefix.length).trim().split(/\s+/);
  const rawCmd=args.shift().toLowerCase();

  // Custom command names reverse lookup
  const customDB=readDB('customCmdsDB')[guildId]||{};
  const revMap={};
  Object.entries(customDB).forEach(([orig,c])=>{if(c.name)revMap[c.name.toLowerCase()]=orig;});
  const cmd=revMap[rawCmd]||rawCmd;

  await runCmd(message,cmd,args,guildId,prem,prefix).catch(err=>{
    console.error(`[CMD:${cmd}]`,err.message);
    message.reply({embeds:[E('error','❌ خطأ',err.message.slice(0,200))]}).catch(()=>{});
  });
});

// =====================================================
// ============= PREFIX COMMANDS ======================
// =====================================================
async function runCmd(msg,cmd,args,gid,prem,prefix){
  const m=msg.member,g=msg.guild;
  switch(cmd){
    // ── MOD ──────────────────────────────────────────
    case'ban':{
      if(!m.permissions.has(PermissionFlagsBits.BanMembers))return noPerms(msg,'Ban Members');
      const t=msg.mentions.members.first()||await g.members.fetch(args[0]).catch(()=>null);
      if(!t)return msg.reply({embeds:[E('error','❌ خطأ','اذكر العضو أو ID.')]});
      const reason=args.slice(1).join(' ')||'لم يُذكر سبب';
      if(!t.bannable)return botNoPerms(msg);
      await t.ban({reason});
      await msg.reply({embeds:[E('success','🔨 تم الحظر',`**${t.user.username}** — السبب: ${reason}`)]});
      await sendLog(g,'punishment',E('error','🔨 حظر',`**العضو:** ${t.user.tag}\n**بواسطة:** ${msg.author.tag}\n**السبب:** ${reason}`));
      break;
    }
    case'unban':{
      if(!m.permissions.has(PermissionFlagsBits.BanMembers))return noPerms(msg,'Ban Members');
      if(!args[0])return msg.reply({embeds:[E('error','❌ خطأ','اذكر ID العضو.')]});
      await g.members.unban(args[0]).catch(()=>null);
      await msg.reply({embeds:[E('success','✅ رفع الحظر',`تم رفع الحظر عن **${args[0]}**`)]});
      break;
    }
    case'kick':{
      if(!m.permissions.has(PermissionFlagsBits.KickMembers))return noPerms(msg,'Kick Members');
      const t=msg.mentions.members.first();
      if(!t)return msg.reply({embeds:[E('error','❌ خطأ','منشن العضو.')]});
      const reason=args.slice(1).join(' ')||'لم يُذكر سبب';
      if(!t.kickable)return botNoPerms(msg);
      await t.kick(reason);
      await msg.reply({embeds:[E('success','👢 تم الطرد',`**${t.user.username}** — السبب: ${reason}`)]});
      await sendLog(g,'punishment',E('error','👢 طرد',`**العضو:** ${t.user.tag}\n**بواسطة:** ${msg.author.tag}\n**السبب:** ${reason}`));
      break;
    }
    case'mute':case'timeout':{
      if(!m.permissions.has(PermissionFlagsBits.ModerateMembers))return noPerms(msg,'Moderate Members');
      const t=msg.mentions.members.first();
      if(!t)return msg.reply({embeds:[E('error','❌ خطأ','منشن العضو.')]});
      const ds=args[1]||'10m',reason=args.slice(2).join(' ')||'لم يُذكر سبب';
      const dur=parseDur(ds)||600000;
      await t.timeout(dur,reason);
      await msg.reply({embeds:[E('success','🔇 تم الكتم',`**${t.user.username}** لمدة **${durTxt(dur)}** — السبب: ${reason}`)]});
      await sendLog(g,'punishment',E('warn','🔇 كتم',`**العضو:** ${t.user.tag}\n**المدة:** ${durTxt(dur)}\n**بواسطة:** ${msg.author.tag}`));
      break;
    }
    case'unmute':case'untimeout':{
      if(!m.permissions.has(PermissionFlagsBits.ModerateMembers))return noPerms(msg,'Moderate Members');
      const t=msg.mentions.members.first();
      if(!t)return msg.reply({embeds:[E('error','❌ خطأ','منشن العضو.')]});
      await t.timeout(null);
      await msg.reply({embeds:[E('success','🔊 رفع الكتم',`تم رفع الكتم عن **${t.user.username}**`)]});
      break;
    }
    case'warn':{
      if(!m.permissions.has(PermissionFlagsBits.ModerateMembers))return noPerms(msg,'Moderate Members');
      const t=msg.mentions.members.first();
      if(!t)return msg.reply({embeds:[E('error','❌ خطأ','منشن العضو.')]});
      const reason=args.slice(1).join(' ')||'لم يُذكر سبب';
      const db=readDB('systemDB');
      if(!db[gid])db[gid]={};
      if(!db[gid].warns)db[gid].warns={};
      if(!db[gid].warns[t.id])db[gid].warns[t.id]=[];
      db[gid].warns[t.id].push({reason,by:msg.author.id,at:Date.now()});
      writeDB('systemDB',db);
      const count=db[gid].warns[t.id].length;
      await msg.reply({embeds:[E('warn','⚠️ تحذير',`تم تحذير **${t.user.username}**\n**السبب:** ${reason}\n**الإجمالي:** ${count}`)]});
      await sendLog(g,'punishment',E('warn','⚠️ تحذير',`**العضو:** ${t.user.tag}\n**بواسطة:** ${msg.author.tag}\n**السبب:** ${reason} (${count})`));
      break;
    }
    case'warns':{
      const t=msg.mentions.members.first()||msg.member;
      const warns=readDB('systemDB')[gid]?.warns?.[t.id]||[];
      if(!warns.length)return msg.reply({embeds:[E('success','✅ لا تحذيرات',`لا يوجد تحذيرات لـ **${t.user.username}**`)]});
      await msg.reply({embeds:[E('warn',`⚠️ تحذيرات ${t.user.username} (${warns.length})`,warns.map((w,i)=>`**${i+1}.** ${w.reason} — <t:${Math.floor(w.at/1000)}:R>`).join('\n'))]});
      break;
    }
    case'clearwarns':{
      if(!m.permissions.has(PermissionFlagsBits.ModerateMembers))return noPerms(msg,'Moderate Members');
      const t=msg.mentions.members.first();
      if(!t)return msg.reply({embeds:[E('error','❌ خطأ','منشن العضو.')]});
      const db=readDB('systemDB');
      if(db[gid]?.warns)db[gid].warns[t.id]=[];
      writeDB('systemDB',db);
      await msg.reply({embeds:[E('success','✅ مسح التحذيرات',`تم مسح كل تحذيرات **${t.user.username}**`)]});
      break;
    }
    case'purge':{
      if(!m.permissions.has(PermissionFlagsBits.ManageMessages))return noPerms(msg,'Manage Messages');
      const n=Math.min(parseInt(args[0])||10,100);
      const msgs=await msg.channel.messages.fetch({limit:n+1});
      await msg.channel.bulkDelete(msgs,true).catch(()=>{});
      const r=await msg.channel.send({embeds:[E('success','🗑️ تم الحذف',`تم حذف **${Math.min(n,msgs.size-1)}** رسالة`)]});
      setTimeout(()=>r.delete().catch(()=>{}),4000);
      break;
    }
    case'slowmode':{
      if(!m.permissions.has(PermissionFlagsBits.ManageChannels))return noPerms(msg,'Manage Channels');
      const s=parseInt(args[0])||0;
      await msg.channel.setRateLimitPerUser(s);
      await msg.reply({embeds:[E('success','⏱️ Slowmode',s===0?'تم إلغاء Slowmode':`تم تفعيل Slowmode: **${s} ثانية**`)]});
      break;
    }
    case'lock':{
      if(!m.permissions.has(PermissionFlagsBits.ManageChannels))return noPerms(msg,'Manage Channels');
      const ch=msg.mentions.channels.first()||msg.channel;
      await ch.permissionOverwrites.edit(g.roles.everyone,{SendMessages:false});
      await msg.reply({embeds:[E('error','🔒 قُفلت القناة',`تم قفل ${ch}`)]});
      break;
    }
    case'unlock':{
      if(!m.permissions.has(PermissionFlagsBits.ManageChannels))return noPerms(msg,'Manage Channels');
      const ch=msg.mentions.channels.first()||msg.channel;
      await ch.permissionOverwrites.edit(g.roles.everyone,{SendMessages:null});
      await msg.reply({embeds:[E('success','🔓 فُتحت القناة',`تم فتح ${ch}`)]});
      break;
    }
    case'lockall':{
      if(!prem)return premReq(msg);
      if(!m.permissions.has(PermissionFlagsBits.Administrator))return noPerms(msg,'Administrator');
      let count=0;
      for(const[,ch]of g.channels.cache.filter(c=>c.type===ChannelType.GuildText)){
        await ch.permissionOverwrites.edit(g.roles.everyone,{SendMessages:false}).catch(()=>{});count++;
      }
      await msg.reply({embeds:[E('error','🔒 قفل السيرفر',`تم قفل **${count}** قناة — حالة طوارئ!`)]});
      break;
    }
    case'unlockall':{
      if(!prem)return premReq(msg);
      if(!m.permissions.has(PermissionFlagsBits.Administrator))return noPerms(msg,'Administrator');
      let count=0;
      for(const[,ch]of g.channels.cache.filter(c=>c.type===ChannelType.GuildText)){
        await ch.permissionOverwrites.edit(g.roles.everyone,{SendMessages:null}).catch(()=>{});count++;
      }
      await msg.reply({embeds:[E('success','🔓 فتح السيرفر',`تم فتح **${count}** قناة`)]});
      break;
    }
    case'addrole':{
      if(!m.permissions.has(PermissionFlagsBits.ManageRoles))return noPerms(msg,'Manage Roles');
      const t=msg.mentions.members.first(),role=msg.mentions.roles.first();
      if(!t||!role)return msg.reply({embeds:[E('error','❌ خطأ','الصيغة: `!addrole @user @role`')]});
      await t.roles.add(role);
      await msg.reply({embeds:[E('success','✅ تم الإضافة',`تم إضافة ${role} لـ **${t.user.username}**`)]});
      break;
    }
    case'removerole':{
      if(!m.permissions.has(PermissionFlagsBits.ManageRoles))return noPerms(msg,'Manage Roles');
      const t=msg.mentions.members.first(),role=msg.mentions.roles.first();
      if(!t||!role)return msg.reply({embeds:[E('error','❌ خطأ','الصيغة: `!removerole @user @role`')]});
      await t.roles.remove(role);
      await msg.reply({embeds:[E('success','✅ تم السحب',`تم سحب ${role} من **${t.user.username}**`)]});
      break;
    }
    case'nick':{
      if(!m.permissions.has(PermissionFlagsBits.ManageNicknames))return noPerms(msg,'Manage Nicknames');
      const t=msg.mentions.members.first();
      if(!t)return msg.reply({embeds:[E('error','❌ خطأ','منشن العضو.')]});
      const newNick=args.slice(1).join(' ')||null;
      await t.setNickname(newNick);
      await msg.reply({embeds:[E('success','✅ تم التغيير',`تم تغيير اسم **${t.user.username}** إلى **${newNick||'الاسم الأصلي'}**`)]});
      break;
    }
    case'announce':{
      if(!prem)return premReq(msg);
      if(!m.permissions.has(PermissionFlagsBits.ManageGuild))return noPerms(msg,'Manage Guild');
      const ch=msg.mentions.channels.first();
      const text=args.slice(ch?2:1).join(' ');
      if(!text)return msg.reply({embeds:[E('error','❌ خطأ','الصيغة: `!announce #قناة النص`')]});
      const target=ch||msg.channel;
      await target.send({embeds:[E('info',`📢 إعلان من ${g.name}`,text).setThumbnail(g.iconURL())]});
      await msg.reply({embeds:[E('success','✅ تم الإرسال',`تم إرسال الإعلان في ${target}`)]});
      break;
    }
    // ── GENERAL ──────────────────────────────────────
    case'help':{await msg.reply({embeds:[buildHelp(prem,prefix)]});break;}
    case'ping':{
      const sent=await msg.reply({embeds:[E('info','🏓 جاري القياس...','...')]});
      await sent.edit({embeds:[E('success','🏓 Pong!',`📡 **WS:** ${client.ws.ping}ms\n⚡ **API:** ${Date.now()-msg.createdTimestamp}ms`)]});
      break;
    }
    case'info':{
      await msg.reply({embeds:[E('info','⚡ Xtra System',
        `**المطور:** STEVEN\n**السيرفرات:** ${client.guilds.cache.size}\n**الأعضاء:** ${client.guilds.cache.reduce((a,g)=>a+g.memberCount,0).toLocaleString()}\n**Ping:** ${client.ws.ping}ms\n\n**الدعم:** https://discord.gg/U3HNCzccbP`
      ).setThumbnail(client.user.displayAvatarURL())]});break;
    }
    case'serverinfo':{await msg.reply({embeds:[await buildServerInfo(g)]});break;}
    case'userinfo':{
      const t=msg.mentions.users.first()||msg.author;
      await msg.reply({embeds:[buildUserInfo(t,g.members.cache.get(t.id)||msg.member)]});break;
    }
    case'avatar':{
      const t=msg.mentions.users.first()||msg.author;
      await msg.reply({embeds:[new EmbedBuilder().setColor(C.info).setTitle(`🖼️ ${t.username}`).setImage(t.displayAvatarURL({size:1024})).setTimestamp()]});break;
    }
    case'roleinfo':{
      const role=msg.mentions.roles.first();
      if(!role)return msg.reply({embeds:[E('error','❌ خطأ','منشن الرتبة.')]});
      await msg.reply({embeds:[E('info',`👑 ${role.name}`,null,[
        {name:'🎨 اللون',value:role.hexColor,inline:true},{name:'👥 الأعضاء',value:`${role.members.size}`,inline:true},{name:'📌 منشن',value:role.mentionable?'✅':'❌',inline:true},{name:'📋 ID',value:role.id,inline:true}
      ]).setColor(role.hexColor||C.info)]});break;
    }
    case'rank':{
      const t=msg.mentions.members.first()||msg.member;
      const u=readDB('rankDB')[gid]?.[t.id]||{xp:0,level:1,messages:0};
      const nxp=u.level*100,p=Math.floor((u.xp/nxp)*20);
      await msg.reply({embeds:[E('info',`⭐ مستوى ${t.user.username}`,
        `**المستوى:** ${u.level}\n**XP:** ${u.xp} / ${nxp}\n**الرسائل:** ${u.messages}\n\n\`${'█'.repeat(p)}${'░'.repeat(20-p)}\``
      ).setThumbnail(t.user.displayAvatarURL())]});break;
    }
    case'leaderboard':case'lb':{
      const data=readDB('rankDB')[gid]||{};
      const sorted=Object.entries(data).sort(([,a],[,b])=>(b.level*10000+b.xp)-(a.level*10000+a.xp)).slice(0,10);
      if(!sorted.length)return msg.reply({embeds:[E('info','🏆 المتصدرون','لا يوجد بيانات بعد.')]});
      const medals=['🥇','🥈','🥉'];
      await msg.reply({embeds:[E('prem','🏆 لوحة المتصدرين',sorted.map(([id,d],i)=>`${medals[i]||`**${i+1}.**`} <@${id}> — Lv.${d.level} (${d.xp} XP)`).join('\n'))]});break;
    }
    case'afk':{
      const reason=args.join(' ')||'غير متاح';
      afkUsers.set(msg.author.id,{reason,time:Date.now()});
      await msg.reply({embeds:[E('info','💤 وضع AFK','تم التفعيل — سأخبر من يمنشنك!')]});break;
    }
    case'report':{
      const t=msg.mentions.members.first();
      if(!t)return msg.reply({embeds:[E('error','❌ خطأ','منشن العضو.')]});
      const reason=args.slice(1).join(' ')||'لم يُذكر سبب';
      const scfg=readDB('suggestionsDB')[gid];
      if(scfg?.staffChannel){
        const ch=await g.channels.fetch(scfg.staffChannel).catch(()=>null);
        if(ch)await ch.send({embeds:[E('error','🚨 بلاغ جديد',`**عن:** ${t.user.tag}\n**بواسطة:** ${msg.author.tag}\n**السبب:** ${reason}`)]});
      }
      await msg.reply({embeds:[E('success','✅ تم الإرسال','تم إرسال البلاغ للإدارة.')]});break;
    }
    case'suggest':{
      const txt=args.join(' ');
      if(!txt)return msg.reply({embeds:[E('error','❌ خطأ','اكتب اقتراحك.')]});
      const scfg=readDB('suggestionsDB')[gid];
      if(!scfg?.enabled||!scfg?.channel)return msg.reply({embeds:[E('error','❌ خطأ','نظام الاقتراحات غير مفعّل.')]});
      const ch=await g.channels.fetch(scfg.channel).catch(()=>null);
      if(!ch)return msg.reply({embeds:[E('error','❌ خطأ','قناة الاقتراحات غير موجودة.')]});
      const sm=await ch.send({embeds:[E('info','💡 اقتراح جديد',txt).setAuthor({name:msg.author.tag,iconURL:msg.author.displayAvatarURL()})]});
      await sm.react('✅');await sm.react('❌');
      if(scfg.autoThread)await sm.startThread({name:`اقتراح — ${msg.author.username}`}).catch(()=>{});
      await msg.reply({embeds:[E('success','✅ تم الإرسال','تم إرسال اقتراحك!')]});break;
    }
    case'poll':{
      const parts=args.join(' ').split('|');
      if(parts.length<3)return msg.reply({embeds:[E('error','❌ خطأ','الصيغة: `!poll السؤال | خيار1 | خيار2`')]});
      const[q,...opts]=parts.map(p=>p.trim());
      const emojis=['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣'];
      const pm=await msg.channel.send({embeds:[E('info',`📊 ${q}`,opts.map((o,i)=>`${emojis[i]} ${o}`).join('\n')).setFooter({text:`بواسطة ${msg.author.username}`})]});
      for(let i=0;i<opts.length&&i<5;i++)await pm.react(emojis[i]);
      await msg.delete().catch(()=>{});break;
    }
    case'giveaway':{
      if(!prem)return premReq(msg);
      if(!m.permissions.has(PermissionFlagsBits.ManageGuild))return noPerms(msg,'Manage Guild');
      const ds=args[0],prize=args.slice(1).join(' ');
      if(!ds||!prize)return msg.reply({embeds:[E('error','❌ خطأ','الصيغة: `!giveaway 1h الجائزة`')]});
      const dur=parseDur(ds);
      if(!dur)return msg.reply({embeds:[E('error','❌ خطأ','المدة غير صحيحة (10m, 1h, 1d)')]});
      const end=Date.now()+dur;
      const gm=await msg.channel.send({embeds:[E('prem','🎉 مسابقة!',`**الجائزة:** ${prize}\n**ينتهي:** <t:${Math.floor(end/1000)}:R>\n\n> اضغط 🎉 للمشاركة!`).setFooter({text:`بواسطة ${msg.author.username}`})]});
      await gm.react('🎉');
      await msg.delete().catch(()=>{});
      setTimeout(async()=>{
        try{
          const ref=await gm.fetch();
          const rxn=ref.reactions.cache.get('🎉');
          const users=await rxn.users.fetch();
          const parts=users.filter(u=>!u.bot);
          if(!parts.size)return gm.reply({embeds:[E('error','😢 لا مشاركين','لم يشارك أحد.')]});
          const winner=parts.random();
          await gm.reply({embeds:[E('success','🎉 الفائز!',`مبروك ${winner}! فزت بـ **${prize}** 🎊`)]});
        }catch{}
      },dur);break;
    }
    case'8ball':{
      if(!args.length)return msg.reply({embeds:[E('error','❌ خطأ','اكتب سؤالك!')]});
      const ans=['نعم بالتأكيد! ✅','لا أعتقد ❌','ربما... 🤔','بالطبع لا ❌','نعم! ✅','الإجابة غير واضحة 🔮','الوقت سيخبرك ⏳','المؤشرات تقول نعم ✅','لا تعتمد عليه ❌','بلا شك ✅'];
      await msg.reply({embeds:[E('info','🎱 Magic 8-Ball',`**سؤالك:** ${args.join(' ')}\n**الإجابة:** ${ans[Math.floor(Math.random()*ans.length)]}`)]});break;
    }
    case'flip':{await msg.reply({embeds:[E('info','🪙 العملة',`**النتيجة:** ${Math.random()<0.5?'👑 صورة':'🗒️ كتابة'}`)]});break;}
    case'roll':{
      const max=parseInt(args[0])||6;
      await msg.reply({embeds:[E('info',`🎲 نرد (1-${max})`,`**النتيجة:** ${Math.floor(Math.random()*max)+1}`)]});break;
    }
  }
}

// =====================================================
// ============= SLASH COMMANDS =======================
// =====================================================
client.on(Events.InteractionCreate,async interaction=>{
  if(interaction.isButton()){
    if(interaction.customId.startsWith('ticket_open_'))await openTicket(interaction).catch(()=>{});
    if(interaction.customId.startsWith('ticket_close_'))await closeTicket(interaction).catch(()=>{});
    return;
  }
  if(!interaction.isChatInputCommand())return;
  const gid=interaction.guildId,prem=isPremium(gid);
  const{commandName:cmd,options}=interaction;
  await interaction.deferReply().catch(()=>{});
  try{
    switch(cmd){
      case'ping':await interaction.editReply({embeds:[E('success','🏓 Pong!',`📡 **WS:** ${client.ws.ping}ms`)]});break;
      case'help':await interaction.editReply({embeds:[buildHelp(prem,getPrefix(gid))]});break;
      case'serverinfo':await interaction.editReply({embeds:[await buildServerInfo(interaction.guild)]});break;
      case'userinfo':{
        const t=options.getUser('user')||interaction.user;
        const mem=await interaction.guild.members.fetch(t.id).catch(()=>null);
        await interaction.editReply({embeds:[buildUserInfo(t,mem)]});break;
      }
      case'avatar':{
        const t=options.getUser('user')||interaction.user;
        await interaction.editReply({embeds:[new EmbedBuilder().setColor(C.info).setTitle(`🖼️ ${t.username}`).setImage(t.displayAvatarURL({size:1024})).setTimestamp()]});break;
      }
      case'rank':{
        const t=options.getMember('user')||interaction.member;
        const u=readDB('rankDB')[gid]?.[t.id]||{xp:0,level:1,messages:0};
        const nxp=u.level*100,p=Math.floor((u.xp/nxp)*20);
        await interaction.editReply({embeds:[E('info',`⭐ مستوى ${t.user?.username||t.displayName}`,
          `**المستوى:** ${u.level}\n**XP:** ${u.xp} / ${nxp}\n**الرسائل:** ${u.messages}\n\n\`${'█'.repeat(p)}${'░'.repeat(20-p)}\``
        ).setThumbnail(t.user?.displayAvatarURL()||null)]});break;
      }
      case'leaderboard':{
        const data=readDB('rankDB')[gid]||{};
        const sorted=Object.entries(data).sort(([,a],[,b])=>(b.level*10000+b.xp)-(a.level*10000+a.xp)).slice(0,10);
        const medals=['🥇','🥈','🥉'];
        const list=sorted.length?sorted.map(([id,d],i)=>`${medals[i]||`**${i+1}.**`} <@${id}> — Lv.${d.level} (${d.xp} XP)`).join('\n'):'لا بيانات بعد.';
        await interaction.editReply({embeds:[E('prem','🏆 لوحة المتصدرين',list)]});break;
      }
      case'ban':{
        if(!interaction.member.permissions.has(PermissionFlagsBits.BanMembers))return interaction.editReply({embeds:[E('error','❌ لا صلاحية','')]});
        const t=options.getUser('user'),reason=options.getString('reason')||'لم يُذكر سبب';
        await interaction.guild.members.ban(t.id,{reason});
        await interaction.editReply({embeds:[E('success','🔨 تم الحظر',`**${t.username}** — ${reason}`)]});
        await sendLog(interaction.guild,'punishment',E('error','🔨 حظر',`**العضو:** ${t.tag}\n**بواسطة:** ${interaction.user.tag}\n**السبب:** ${reason}`));break;
      }
      case'kick':{
        if(!interaction.member.permissions.has(PermissionFlagsBits.KickMembers))return interaction.editReply({embeds:[E('error','❌ لا صلاحية','')]});
        const t=options.getMember('user'),reason=options.getString('reason')||'لم يُذكر سبب';
        await t.kick(reason);
        await interaction.editReply({embeds:[E('success','👢 تم الطرد',`**${t.user.username}** — ${reason}`)]});break;
      }
      case'warn':{
        if(!interaction.member.permissions.has(PermissionFlagsBits.ModerateMembers))return interaction.editReply({embeds:[E('error','❌ لا صلاحية','')]});
        const t=options.getUser('user'),reason=options.getString('reason');
        const db=readDB('systemDB');
        if(!db[gid])db[gid]={};if(!db[gid].warns)db[gid].warns={};if(!db[gid].warns[t.id])db[gid].warns[t.id]=[];
        db[gid].warns[t.id].push({reason,by:interaction.user.id,at:Date.now()});writeDB('systemDB',db);
        const count=db[gid].warns[t.id].length;
        await interaction.editReply({embeds:[E('warn','⚠️ تحذير',`**${t.username}** — ${reason} (${count} تحذير)`)]});break;
      }
      case'warns':{
        const t=options.getMember('user')||interaction.member;
        const warns=readDB('systemDB')[gid]?.warns?.[t.id]||[];
        const list=warns.length?warns.map((w,i)=>`**${i+1}.** ${w.reason} — <t:${Math.floor(w.at/1000)}:R>`).join('\n'):'لا تحذيرات.';
        await interaction.editReply({embeds:[E('warn',`⚠️ تحذيرات ${t.user?.username||t.displayName} (${warns.length})`,list)]});break;
      }
      case'mute':{
        if(!interaction.member.permissions.has(PermissionFlagsBits.ModerateMembers))return interaction.editReply({embeds:[E('error','❌ لا صلاحية','')]});
        const t=options.getMember('user'),ds=options.getString('duration')||'10m',reason=options.getString('reason')||'لم يُذكر سبب';
        const dur=parseDur(ds)||600000;
        await t.timeout(dur,reason);
        await interaction.editReply({embeds:[E('success','🔇 تم الكتم',`**${t.user.username}** لمدة **${durTxt(dur)}** — ${reason}`)]});break;
      }
      case'unmute':{
        if(!interaction.member.permissions.has(PermissionFlagsBits.ModerateMembers))return interaction.editReply({embeds:[E('error','❌ لا صلاحية','')]});
        const t=options.getMember('user');await t.timeout(null);
        await interaction.editReply({embeds:[E('success','🔊 رفع الكتم',`تم رفع الكتم عن **${t.user.username}**`)]});break;
      }
      case'purge':{
        if(!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages))return interaction.editReply({embeds:[E('error','❌ لا صلاحية','')]});
        const n=options.getInteger('amount');
        const deleted=await interaction.channel.bulkDelete(n,true).catch(()=>null);
        await interaction.editReply({embeds:[E('success','🗑️ تم الحذف',`تم حذف **${deleted?.size||0}** رسالة`)]});
        setTimeout(()=>interaction.deleteReply().catch(()=>{}),4000);break;
      }
      case'poll':{
        const q=options.getString('question'),o1=options.getString('option1'),o2=options.getString('option2');
        await interaction.editReply({embeds:[E('info',`📊 ${q}`,`✅ ${o1}\n❌ ${o2}`).setFooter({text:`بواسطة ${interaction.user.username}`})]});
        const reply=await interaction.fetchReply();await reply.react('✅');await reply.react('❌');break;
      }
      default:await interaction.editReply({embeds:[E('error','❌ غير موجود','')]});
    }
  }catch(err){
    console.error('Slash error:',err);
    await interaction.editReply({embeds:[E('error','❌ حدث خطأ',err.message.slice(0,200))]}).catch(()=>{});
  }
});

// =====================================================
// ================ PROTECTION ========================
// =====================================================
async function handleProtection(message,gid){
  const cfg=readProtect()[gid];if(!cfg)return;
  const m=message.member;
  if(!m||m.permissions.has(PermissionFlagsBits.Administrator))return;
  if(cfg.ignoredChannels?.includes(message.channelId))return;
  if(cfg.ignoredRoles?.some(r=>m.roles.cache.has(r)))return;
  const c=message.content;
  // Anti-Spam
  if(cfg.antiSpam){
    const key=message.author.id+gid,now=Date.now();
    const msgs=(spamTracker.get(key)||[]).filter(t=>now-t<5000);msgs.push(now);spamTracker.set(key,msgs);
    if(msgs.length>=(cfg.spamLimit||5)){
      await message.delete().catch(()=>{});
      await message.member.timeout(60000,'Anti-Spam').catch(()=>{});
      const r=await message.channel.send({embeds:[E('error','💬 Anti-Spam',`${message.author} تم كتمك بسبب السبام!`)]});
      setTimeout(()=>r.delete().catch(()=>{}),5000);spamTracker.set(key,[]);return;
    }
  }
  // Anti-Ad
  if(cfg.antiAd&&/discord\.gg\/[^\s]+/i.test(c)){
    await message.delete().catch(()=>{});
    const r=await message.channel.send({embeds:[E('error','📢 Anti-Ad',`${message.author} لا يسمح بإرسال دعوات ديسكورد!`)]});
    setTimeout(()=>r.delete().catch(()=>{}),5000);return;
  }
  // Anti-Link
  if(cfg.antiLink&&/https?:\/\/[^\s]+/i.test(c)){
    const wl=cfg.whitelistLinks||[];
    if(!wl.some(w=>c.includes(w))){
      await message.delete().catch(()=>{});
      const r=await message.channel.send({embeds:[E('error','🔗 Anti-Link',`${message.author} لا يسمح بإرسال الروابط!`)]});
      setTimeout(()=>r.delete().catch(()=>{}),5000);return;
    }
  }
  // Anti-Caps
  if(cfg.antiCaps&&c.length>10){
    const up=(c.match(/[A-Z]/g)||[]).length,let2=(c.match(/[a-zA-Z]/g)||[]).length;
    if(let2>5&&up/let2>0.7){
      await message.delete().catch(()=>{});
      const r=await message.channel.send({embeds:[E('error','🔠 Anti-Caps',`${message.author} لا يسمح بالحروف الكبيرة المفرطة!`)]});
      setTimeout(()=>r.delete().catch(()=>{}),5000);return;
    }
  }
  // Anti-Emoji
  if(cfg.antiEmoji&&(c.match(/\p{Emoji}/gu)||[]).length>10){
    await message.delete().catch(()=>{});
    const r=await message.channel.send({embeds:[E('error','😂 Anti-Emoji',`${message.author} كثرة الإيموجي!`)]});
    setTimeout(()=>r.delete().catch(()=>{}),5000);return;
  }
  // Anti-Mention
  if(cfg.antiMention&&message.mentions.users.size>4){
    await message.delete().catch(()=>{});
    await message.member.timeout(300000,'Anti-Mention').catch(()=>{});
    const r=await message.channel.send({embeds:[E('error','📣 Anti-Mention',`${message.author} منشن مفرط!`)]});
    setTimeout(()=>r.delete().catch(()=>{}),5000);
  }
}

// =====================================================
// ================ AUTO RESPONSE =====================
// =====================================================
async function handleAutoResponse(message,gid){
  const responses=readDB('systemDB')[gid]?.autoResponse||[];
  const low=message.content.toLowerCase();
  for(const ar of responses){
    const tl=ar.trigger.toLowerCase();
    const match=ar.type==='exact'?low===tl:ar.type==='startsWith'?low.startsWith(tl):low.includes(tl);
    if(match){await message.reply({embeds:[E('info',null,ar.response)]});break;}
  }
}

// =====================================================
// ================== WELCOME =========================
// =====================================================
client.on(Events.GuildMemberAdd,async member=>{
  const cfg=readDB('systemDB')[member.guild.id]?.welcome;
  if(cfg?.enabled&&cfg?.channel){
    const vars=s=>s.replace(/{user}/g,`${member}`).replace(/{username}/g,member.user.username).replace(/{server}/g,member.guild.name).replace(/{count}/g,member.guild.memberCount).replace(/{mention}/g,`${member}`);
    const ch=await member.guild.channels.fetch(cfg.channel).catch(()=>null);
    if(ch)await ch.send({embeds:[E('success',`👋 أهلاً في ${member.guild.name}!`,vars(cfg.message||'مرحباً {user}!')).setThumbnail(member.user.displayAvatarURL())]});
    if(cfg.autoRole)await member.roles.add(cfg.autoRole).catch(()=>{});
    if(cfg.dmEnabled&&cfg.dmMessage)await member.user.send({embeds:[E('info',`مرحباً في ${member.guild.name}!`,vars(cfg.dmMessage))]}).catch(()=>{});
  }
  await sendLog(member.guild,'memberJoin',E('success','👋 عضو جديد',`**العضو:** ${member.user.tag}\n**ID:** ${member.id}\n**تاريخ الحساب:** <t:${Math.floor(member.user.createdTimestamp/1000)}:R>`).setThumbnail(member.user.displayAvatarURL()));
  // Anti-Raid
  const protCfg=readProtect()[member.guild.id];
  if(protCfg?.antiRaid){
    const now=Date.now();
    const joins=(raidTracker.get(member.guild.id)||[]).filter(t=>now-t<60000);joins.push(now);raidTracker.set(member.guild.id,joins);
    if(joins.length>=(protCfg.raidLimit||10)){
      raidTracker.set(member.guild.id,[]);const action=protCfg.raidAction||'lock';
      if(action==='ban')await member.ban({reason:'Anti-Raid'}).catch(()=>{});
      if(action==='kick')await member.kick('Anti-Raid').catch(()=>{});
      if(action==='lock')for(const[,ch]of member.guild.channels.cache.filter(c=>c.type===ChannelType.GuildText))await ch.permissionOverwrites.edit(member.guild.roles.everyone,{SendMessages:false}).catch(()=>{});
      await sendLog(member.guild,'punishment',E('error','🚨 Anti-Raid تفعّل!',`تم رصد **${joins.length}** انضمام في دقيقة!\n**الإجراء:** ${action}`));
    }
  }
});
client.on(Events.GuildMemberRemove,async member=>{
  const cfg=readDB('systemDB')[member.guild.id]?.welcome;
  if(cfg?.leaveEnabled&&cfg?.leaveChannel){
    const ch=await member.guild.channels.fetch(cfg.leaveChannel).catch(()=>null);
    const vars=s=>s.replace(/{user}/g,member.user.username).replace(/{server}/g,member.guild.name);
    if(ch)await ch.send({embeds:[E('error',null,vars(cfg.leaveMessage||'وداعاً {user} 👋'))]});
  }
  await sendLog(member.guild,'memberLeave',E('error','🚪 عضو غادر',`**العضو:** ${member.user.tag}\n**ID:** ${member.id}`));
});

// =====================================================
// ================== TICKET SYSTEM ===================
// =====================================================
async function openTicket(interaction){
  if(!interaction.customId.startsWith('ticket_open_'))return;
  const gid=interaction.guildId,db=readDB('ticketDB'),cfg=db[gid]?.settings;
  if(!cfg?.enabled)return;
  const existing=interaction.guild.channels.cache.find(c=>c.topic?.includes(`ticket:${interaction.user.id}`));
  if(existing)return interaction.reply({content:`❌ لديك تذكرة مفتوحة: ${existing}`,ephemeral:true});
  await interaction.deferReply({ephemeral:true});
  const perms=[
    {id:interaction.guild.roles.everyone,deny:[PermissionFlagsBits.ViewChannel]},
    {id:interaction.user.id,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages]},
  ];
  if(cfg.supportRole)perms.push({id:cfg.supportRole,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages]});
  const tCh=await interaction.guild.channels.create({
    name:`ticket-${interaction.user.username}`,type:ChannelType.GuildText,
    parent:cfg.category||null,topic:`ticket:${interaction.user.id}`,permissionOverwrites:perms
  });
  const row=new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`ticket_close_${tCh.id}`).setLabel('🔒 إغلاق التذكرة').setStyle(ButtonStyle.Danger));
  const vars=s=>s.replace(/{user}/g,`${interaction.user}`).replace(/{username}/g,interaction.user.username);
  await tCh.send({
    content:`${interaction.user}${cfg.supportRole?` <@&${cfg.supportRole}>`:''}`,
    embeds:[E('info','🎫 تذكرة جديدة',vars(cfg.welcomeMsg||'مرحباً {user}! سيرد عليك الفريق قريباً 👋'))],
    components:[row]
  });
  const tDB=readDB('ticketDB');if(!tDB.tickets)tDB.tickets={};
  tDB.tickets[tCh.id]={guildId:gid,userId:interaction.user.id,status:'open',createdAt:Date.now()};
  writeDB('ticketDB',tDB);
  await interaction.editReply({content:`✅ تم إنشاء تذكرتك: ${tCh}`});
  await sendLog(interaction.guild,'ticket',E('info','🎫 تذكرة جديدة',`**بواسطة:** ${interaction.user.tag}\n**القناة:** ${tCh}`));
}
async function closeTicket(interaction){
  if(!interaction.customId.startsWith('ticket_close_'))return;
  const chId=interaction.customId.replace('ticket_close_','');
  if(interaction.channelId!==chId)return;
  await interaction.reply({content:'🔒 جاري الإغلاق...',ephemeral:true});
  await interaction.channel.permissionOverwrites.set([{id:interaction.guild.roles.everyone,deny:[PermissionFlagsBits.ViewChannel]}]);
  const tDB=readDB('ticketDB');
  if(tDB.tickets?.[chId]){tDB.tickets[chId].status='closed';tDB.tickets[chId].closedAt=Date.now();tDB.tickets[chId].closedBy=interaction.user.id;writeDB('ticketDB',tDB);}
  await sendLog(interaction.guild,'ticket',E('error','🔒 تذكرة مغلقة',`**القناة:** ${interaction.channel.name}\n**أُغلقت بواسطة:** ${interaction.user.tag}`));
  setTimeout(()=>interaction.channel.delete().catch(()=>{}),5000);
}

// =====================================================
// =================== LOGS ===========================
// =====================================================
client.on(Events.MessageUpdate,async(o,n)=>{
  if(!o.guild||o.author?.bot||o.content===n.content)return;
  await sendLog(o.guild,'messageEdit',E('warn','✏️ رسالة معدّلة',`**العضو:** ${o.author?.tag}\n**القناة:** ${o.channel}\n**قبل:** ${(o.content||'').slice(0,400)}\n**بعد:** ${(n.content||'').slice(0,400)}`));
});
client.on(Events.MessageDelete,async msg=>{
  if(!msg.guild||msg.author?.bot)return;
  await sendLog(msg.guild,'messageDelete',E('error','🗑️ رسالة محذوفة',`**العضو:** ${msg.author?.tag}\n**القناة:** ${msg.channel}\n**المحتوى:** ${(msg.content||'').slice(0,400)}`));
});

// =====================================================
// ================= HELP BUILDERS ====================
// =====================================================
function buildHelp(prem,prefix){
  return new EmbedBuilder().setColor(C.info)
    .setTitle('⚡ Xtra System — قائمة الأوامر')
    .setDescription(`**البرفكس:** \`${prefix}\` | **الدعم:** https://discord.gg/U3HNCzccbP`)
    .addFields(
      {name:'🔨 الإشراف',value:`\`ban\` \`unban\` \`kick\` \`mute\` \`unmute\` \`warn\` \`warns\` \`clearwarns\` \`purge\` \`lock\` \`unlock\` \`addrole\` \`removerole\` \`nick\` \`slowmode\``,inline:false},
      {name:'👑 الإشراف Premium',value:`\`lockall\` \`unlockall\` \`announce\` ${prem?'✅':'🔒'}`,inline:false},
      {name:'🎮 عامة',value:`\`help\` \`ping\` \`info\` \`serverinfo\` \`userinfo\` \`avatar\` \`roleinfo\` \`afk\` \`report\` \`suggest\` \`poll\` \`8ball\` \`flip\` \`roll\` \`rank\` \`lb\``,inline:false},
      {name:'⭐ عامة Premium',value:`\`giveaway\` ${prem?'✅':'🔒'}`,inline:false},
      {name:'📡 Slash',value:`\`/ban\` \`/kick\` \`/warn\` \`/mute\` \`/purge\` \`/poll\` \`/rank\` \`/leaderboard\` \`/ping\` \`/help\` \`/serverinfo\` \`/userinfo\``,inline:false},
    )
    .setFooter({text:`👨‍💻 STEVEN • ${prem?'👑 Premium Active':'⚡ Free Plan'}`})
    .setTimestamp();
}
async function buildServerInfo(guild){
  await guild.fetch().catch(()=>{});
  const owner=await guild.fetchOwner().catch(()=>null);
  return E('info',`🖥️ ${guild.name}`,null,[
    {name:'👑 المالك',value:owner?.user.tag||'؟',inline:true},{name:'👥 الأعضاء',value:`${guild.memberCount}`,inline:true},
    {name:'📅 الإنشاء',value:`<t:${Math.floor(guild.createdTimestamp/1000)}:R>`,inline:true},
    {name:'📝 القنوات',value:`${guild.channels.cache.size}`,inline:true},{name:'🎭 الرتب',value:`${guild.roles.cache.size}`,inline:true},
    {name:'📋 ID',value:guild.id,inline:true},
  ]).setThumbnail(guild.iconURL());
}
function buildUserInfo(user,member){
  const fields=[{name:'📋 ID',value:user.id,inline:true},{name:'📅 تاريخ الحساب',value:`<t:${Math.floor(user.createdTimestamp/1000)}:R>`,inline:true}];
  if(member?.joinedTimestamp)fields.push({name:'📅 انضم',value:`<t:${Math.floor(member.joinedTimestamp/1000)}:R>`,inline:true});
  if(member){const roles=member.roles.cache.filter(r=>r.name!=='@everyone').map(r=>`${r}`).slice(0,8).join(' ')||'لا يوجد';fields.push({name:'🎭 الرتب',value:roles,inline:false});}
  return E('info',`👤 ${user.username}`,null,fields).setThumbnail(user.displayAvatarURL());
}

// =====================================================
// ===================== START ========================
// =====================================================
client.login(process.env.BOT_TOKEN).catch(err=>{
  console.error('❌ فشل تسجيل الدخول:',err.message);process.exit(1);
});
