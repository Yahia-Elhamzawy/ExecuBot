require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const path = require('path');
const fs = require('fs');

const db = require('./db');
const whatsapp = require('./whatsapp');
const gemini = require('./ai/gemini');
const nemotron = require('./ai/nemotron');
const tts = require('./audio/tts');
const profileModule = require('./ai/profile');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(path.resolve(__dirname, '../frontend')));

// WebSocket Broadcast
function broadcast(type, data) {
  const payload = JSON.stringify({ type, data });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

// ربط محرك الواتساب بـ WebSocket
whatsapp.setEventEmitter((event, data) => {
  broadcast(event, data);
});

// ===================== REST APIs ===================== //

// حالة الاتصال ورمز QR
app.get('/api/status', (req, res) => {
  res.json(whatsapp.getStatus());
});

app.post('/api/connect', async (req, res) => {
  whatsapp.startWhatsApp();
  res.json({ success: true, message: 'WhatsApp connection initiated' });
});

app.post('/api/logout', async (req, res) => {
  await whatsapp.logout();
  res.json({ success: true, message: 'Logged out successfully' });
});

// إدارة الجروبات
app.get('/api/groups', (req, res) => {
  const groups = db.getAllGroups();
  res.json(groups);
});

app.post('/api/groups/sync', async (req, res) => {
  const groups = await whatsapp.syncGroups();
  res.json({ success: true, count: groups.length });
});

app.post('/api/groups/:id/settings', (req, res) => {
  const { id } = req.params;
  const { is_monitored, auto_reply, reply_mode, keywords } = req.body;
  const ok = db.updateGroupSettings(id, { is_monitored, auto_reply, reply_mode, keywords });
  broadcast('groups_updated', db.getAllGroups());
  res.json({ success: ok });
});

// الرسائل وسجل المحادثات
app.get('/api/messages/:groupId', (req, res) => {
  const { groupId } = req.params;
  const limit = parseInt(req.query.limit, 10) || 50;
  const messages = db.getRecentMessages(groupId, limit);
  res.json(messages);
});

// الردود السريعة
app.post('/api/messages/reply-quick', async (req, res) => {
  const { jid, text, mode } = req.body;
  if (!jid || !text) {
    return res.status(400).json({ error: 'JID and text are required' });
  }

  try {
    if (mode === 'voice') {
      const voice = db.getSetting('default_voice', process.env.DEFAULT_VOICE || 'ar-EG-ShakirNeural');
      const oggFile = await tts.textToSpeechPTT(text, voice);
      if (fs.existsSync(oggFile)) {
        await whatsapp.sendBotMessage(jid, {
          audio: fs.readFileSync(oggFile),
          mimetype: 'audio/ogg; codecs=opus',
          ptt: true
        });
        fs.unlinkSync(oggFile);
      }
    } else {
      await whatsapp.sendBotMessage(jid, { text: text });
    }

    db.saveMessage({
      id: 'quick_' + Date.now(),
      group_id: jid,
      sender_id: 'owner',
      sender_name: 'You',
      message_type: mode === 'voice' ? 'audio' : 'text',
      content: text,
      transcript: text,
      timestamp: Math.floor(Date.now() / 1000)
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// جهات الاتصال وطلبات المتصلين
app.get('/api/contacts', (req, res) => {
  res.json(db.getAllContacts());
});

app.post('/api/contacts/:id/settings', (req, res) => {
  const { id } = req.params;
  const { auto_reply, reply_mode } = req.body;
  const ok = db.updateContactSettings(id, { auto_reply, reply_mode });
  broadcast('contacts_updated', db.getAllContacts());
  res.json({ success: ok });
});

app.post('/api/contacts/reset-takeover', (req, res) => {
  db.resetAllHumanTakeovers();
  broadcast('contacts_updated', db.getAllContacts());
  res.json({ success: true, message: 'All temporary takeover silences cleared.' });
});

app.post('/api/contacts/:id/clear-takeover', (req, res) => {
  const { id } = req.params;
  db.clearHumanTakeover(id);
  broadcast('contacts_updated', db.getAllContacts());
  res.json({ success: true, message: 'Temporary takeover cleared for this contact.' });
});

app.get('/api/inquiries', (req, res) => {
  res.json(db.getAllInquiries());
});

app.post('/api/inquiries/:id/resolve', (req, res) => {
  const { id } = req.params;
  db.resolveInquiry(parseInt(id, 10));
  broadcast('inquiries_updated', db.getAllInquiries());
  res.json({ success: true });
});

// التقارير والملخصات
app.get('/api/summaries', (req, res) => {
  const { groupId } = req.query;
  const summaries = db.getSummaries(groupId);
  res.json(summaries);
});

app.post('/api/summaries/generate', async (req, res) => {
  const { groupId } = req.body;
  if (!groupId) {
    return res.status(400).json({ error: 'groupId is required' });
  }

  const group = db.getGroupById(groupId);
  if (!group) {
    return res.status(404).json({ error: 'Group not found' });
  }

  const messages = db.getUnsummarizedMessages(groupId);
  if (messages.length === 0) {
    return res.json({ message: 'No new messages to summarize', summary: null });
  }

  try {
    const lang = db.getSetting('app_lang', 'en');
    const summaryText = await nemotron.generateDailySummary(group.name, messages, lang);
    db.saveSummary(groupId, summaryText);
    db.markMessagesSummarized(messages.map(m => m.id));

    broadcast('summary_ready', { groupId, summary: summaryText });
    res.json({ success: true, summary: summaryText });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// شات المساعد الشخصي
app.post('/api/chat/ask', async (req, res) => {
  const { question } = req.body;
  if (!question) {
    return res.status(400).json({ error: 'Question is required' });
  }

  try {
    const monitoredGroups = db.getAllGroups().filter(g => g.is_monitored === 1);
    let allRecentMessages = [];
    for (const g of monitoredGroups) {
      const msgs = db.getRecentMessages(g.id, 20);
      allRecentMessages = allRecentMessages.concat(msgs);
    }

    allRecentMessages.sort((a, b) => b.timestamp - a.timestamp);
    const context = allRecentMessages.slice(0, 50);

    const answer = await nemotron.askQuestionAboutHistory(question, context);
    res.json({ answer });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===================== الإعدادات والموديلات وملف المستخدم ===================== //

// استرجاع الإعدادات الكاملة
app.get('/api/settings', (req, res) => {
  const all = db.getAllSettings();
  const profile = db.getUserProfile();
  res.json({
    gemini_api_key: all.gemini_api_key || process.env.GEMINI_API_KEY || '',
    gemini_model: all.gemini_model || process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite',
    nvidia_api_key: all.nvidia_api_key || process.env.NVIDIA_API_KEY || '',
    nvidia_model: all.nvidia_model || process.env.NVIDIA_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b',
    nvidia_base_url: all.nvidia_base_url || process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1',
    default_voice: all.default_voice || process.env.DEFAULT_VOICE || 'ar-EG-ShakirNeural',
    app_lang: all.app_lang || 'en',
    contacts_auto_reply_enabled: all.contacts_auto_reply_enabled !== '0',
    profile: profile,
    is_setup_completed: Boolean(all.is_setup_completed === '1' && (all.gemini_api_key || process.env.GEMINI_API_KEY))
  });
});

// حفظ إعدادات الـ API والـ Models
app.post('/api/settings/keys', (req, res) => {
  const {
    gemini_api_key,
    gemini_model,
    nvidia_api_key,
    nvidia_model,
    nvidia_base_url
  } = req.body;

  if (gemini_api_key !== undefined) db.setSetting('gemini_api_key', gemini_api_key);
  if (gemini_model !== undefined) db.setSetting('gemini_model', gemini_model);
  if (nvidia_api_key !== undefined) db.setSetting('nvidia_api_key', nvidia_api_key);
  if (nvidia_model !== undefined) db.setSetting('nvidia_model', nvidia_model);
  if (nvidia_base_url !== undefined) db.setSetting('nvidia_base_url', nvidia_base_url);

  res.json({ success: true, message: 'AI Engine keys and models updated successfully.' });
});

// حفظ بطاقة المعرفة الشخصية
app.post('/api/settings/profile', (req, res) => {
  const profileData = req.body;
  const saved = db.saveUserProfile(profileData);
  res.json({ success: true, profile: saved });
});

// برومبت الاستجواب الذكي لـ ChatGPT / Claude
app.get('/api/settings/chatgpt-prompt', (req, res) => {
  res.json({ prompt: profileModule.getChatGPTProfilePrompt() });
});

// تغيير لغة التطبيق
app.post('/api/settings/language', (req, res) => {
  const { lang } = req.body;
  if (lang === 'en' || lang === 'ar') {
    db.setSetting('app_lang', lang);
    res.json({ success: true, lang });
  } else {
    res.status(400).json({ error: 'Unsupported language' });
  }
});

// تبديل تشغيل/إيقاف رد المساعد على الخاص
app.post('/api/settings/contacts-autoreply', (req, res) => {
  const { enabled } = req.body;
  db.setSetting('contacts_auto_reply_enabled', enabled ? '1' : '0');
  broadcast('settings_updated', { contacts_auto_reply_enabled: Boolean(enabled) });
  res.json({ success: true, contacts_auto_reply_enabled: Boolean(enabled) });
});

// إكمال معالج الإعداد الأولي (Onboarding Wizard)
app.post('/api/settings/complete-setup', (req, res) => {
  const {
    lang,
    gemini_api_key,
    gemini_model,
    nvidia_api_key,
    nvidia_model,
    profile
  } = req.body;

  if (lang) db.setSetting('app_lang', lang);
  if (gemini_api_key) db.setSetting('gemini_api_key', gemini_api_key);
  if (gemini_model) db.setSetting('gemini_model', gemini_model);
  if (nvidia_api_key) db.setSetting('nvidia_api_key', nvidia_api_key);
  if (nvidia_model) db.setSetting('nvidia_model', nvidia_model);
  if (profile) db.saveUserProfile(profile);

  db.setSetting('is_setup_completed', '1');
  res.json({ success: true, message: 'Onboarding completed!' });
});

app.post('/api/settings/voice', (req, res) => {
  const { voice } = req.body;
  if (voice) {
    db.setSetting('default_voice', voice);
  }
  res.json({ success: true });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 ExecuBot Server listening on: http://localhost:${PORT}`);
  // محاولة الاتصال التلقائي بالواتساب إذا كان الإعداد مكتملاً
  const isSetupDone = db.getSetting('is_setup_completed', '0') === '1' || process.env.GEMINI_API_KEY;
  if (isSetupDone) {
    whatsapp.startWhatsApp();
  }
});
