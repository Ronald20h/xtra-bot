# 🚀 دليل نشر Xtra System على Railway

## الخطوة 1: رفع الملفات على GitHub

```bash
git init
git add .
git commit -m "Xtra System v2"
git branch -M main
git remote add origin https://github.com/USERNAME/xtra-system.git
git push -u origin main
```

## الخطوة 2: إنشاء مشروع على Railway

1. روح **railway.app** → سجل بـ GitHub
2. اضغط **New Project** → **Deploy from GitHub repo**
3. اختار الـ repo بتاعك
4. انتظر لحد ما يكمل البيلد

## الخطوة 3: الحصول على الرابط

1. اضغط على الـ Service
2. روح **Settings** → **Networking** → **Generate Domain**
3. هيديك رابط شكله: `xtra-system.up.railway.app`

## الخطوة 4: إعداد Environment Variables

في Railway → الـ Service → تبويب **Variables**، أضف:

```
CLIENT_ID         = [Application ID من Discord Developer Portal]
CLIENT_SECRET     = [Client Secret من Discord Developer Portal]
BOT_TOKEN         = [Bot Token من Discord Developer Portal]
REDIRECT_URI      = https://xtra-system.up.railway.app/callback
SESSION_SECRET    = xtra_secret_anything_random_2025
ADMIN_IDS         = [Discord User ID بتاعك]
PORT              = 3000
```

## الخطوة 5: إعداد Discord Developer Portal

1. روح **discord.com/developers/applications**
2. اختار تطبيقك
3. **OAuth2** → **Redirects** → احذف القديم وأضف:
   ```
   https://xtra-system.up.railway.app/callback
   ```
4. اضغط **Save Changes** 💾

## الخطوة 6: صلاحيات البوت

في Discord Developer Portal → **Bot**:
- فعّل **MESSAGE CONTENT INTENT** ✅
- فعّل **SERVER MEMBERS INTENT** ✅
- فعّل **PRESENCE INTENT** ✅

## الخطوة 7: إضافة البوت للسيرفر

استخدم هذا الرابط (استبدل CLIENT_ID بـ ID تطبيقك):
```
https://discord.com/oauth2/authorize?client_id=CLIENT_ID&permissions=8&scope=bot%20applications.commands
```

## ✅ تحقق من نجاح النشر

في Railway → **Logs** المفروض تشوف:
```
✅ Xtra#1234 شغّال!
✅ Slash commands registered
⚡ Xtra Dashboard on port 3000
```

## كيف تعطي بريميوم لسيرفر

1. سجل دخول على الداشبورد بحسابك (اللي ID بتاعه في ADMIN_IDS)
2. اضغط **🔧 لوحة الأدمن** في الـ sidebar
3. اضغط **+ إعطاء بريميوم**
4. حط ID السيرفر والمدة → اضغط **👑 إعطاء**

## استكشاف الأخطاء

| المشكلة | الحل |
|---------|------|
| redirect_uri error | تأكد إن REDIRECT_URI مطابق بالضبط في Railway وDiscord |
| البوت مش شغال | تحقق من BOT_TOKEN وإن الـ Intents مفعّلة |
| مش ظاهر أدمن | تأكد إن ADMIN_IDS فيه ID بتاعك بالظبط |
| الجلسة بتنتهي | عادي — كل 10 دقائق بدون نشاط |
