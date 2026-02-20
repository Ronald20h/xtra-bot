require('dotenv').config();
const { spawn } = require('child_process');

console.log('⚡ Xtra System — Starting...\n');

function start(name, file) {
  const proc = spawn('node', [file], { stdio: 'inherit', env: process.env });
  proc.on('exit', (code) => {
    console.log(`\n⚠️  [${name}] توقف (code: ${code}) — إعادة التشغيل بعد 5 ثواني...`);
    setTimeout(() => start(name, file), 5000);
  });
  proc.on('error', (err) => console.error(`❌ [${name}]:`, err.message));
  console.log(`✅ [${name}] شغّال!`);
}

start('Dashboard', 'server.js');

// تأخير 3 ثواني عشان الـ DB يتهيأ أول
setTimeout(() => start('Bot', 'bot.js'), 3000);
