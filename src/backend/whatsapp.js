const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  generateMessageID
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');

const db = require('./db');
const gemini = require('./ai/gemini');
const nemotron = require('./ai/nemotron');
const tts = require('./audio/tts');
const { getActiveProfile } = require('./ai/profile');

const authDir = path.resolve(__dirname, '../../data/auth_session');
if (!fs.existsSync(authDir)) {
  fs.mkdirSync(authDir, { recursive: true });
}

const logFile = path.resolve(__dirname, '../../data/bot.log');
function logBot(...args) {
  const line = `[${new Date().toLocaleTimeString()}] ` + args.join(' ');
  console.log(line);
  try {
    fs.appendFileSync(logFile, line + '\n', 'utf8');
  } catch (e) {}
}

let sock = null;
let currentQR = null;
let currentQRDataUrl = null;
let connectionStatus = 'disconnected'; // 'connecting', 'connected', 'disconnected', 'logged_out'
let eventEmitterCallback = null;

// تتبع معرفات الرسائل التي أرسلها البوت نفسه لمنع الخلط بينها وبين التدخل البشري
const botOutgoingMessageIds = new Set();

async function sendBotMessage(targetJid, content) {
  if (!sock) return null;
  const customId = generateMessageID();
  botOutgoingMessageIds.add(customId);
  setTimeout(() => botOutgoingMessageIds.delete(customId), 60000);
  return await sock.sendMessage(targetJid, content, { messageId: customId });
}

function setEventEmitter(cb) {
  eventEmitterCallback = cb;
}

function emitEvent(event, data) {
  if (eventEmitterCallback) {
    eventEmitterCallback(event, data);
  }
}

// سماحية دقيقتين قبل وقت تشغيل البوت لتفادي أي فروق في توقيت الخوادم
let botStartTime = Math.floor(Date.now() / 1000) - 120;

function getStatus() {
  return {
    status: connectionStatus,
    qr: currentQRDataUrl
  };
}

/**
 * بدء اتصال الواتساب
 */
async function startWhatsApp() {
  try {
    botStartTime = Math.floor(Date.now() / 1000) - 120;
    logBot(`⏱️ ExecuBot start timestamp: ${botStartTime}`);

    connectionStatus = 'connecting';
    emitEvent('status_change', { status: connectionStatus });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['ExecuBot Executive', 'Chrome', '124.0.0.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQR = qr;
        try {
          currentQRDataUrl = await QRCode.toDataURL(qr);
          qrcodeTerminal.generate(qr, { small: true });
        } catch (e) {
          logBot('Error converting QR code:', e);
        }
        connectionStatus = 'qr_ready';
        emitEvent('qr', { qr: currentQRDataUrl });
        emitEvent('status_change', { status: connectionStatus, qr: currentQRDataUrl });
      }

      if (connection === 'close') {
        currentQR = null;
        currentQRDataUrl = null;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        logBot(`Connection closed. Code: ${statusCode}. Reconnect: ${shouldReconnect}`);

        if (statusCode === DisconnectReason.loggedOut) {
          connectionStatus = 'logged_out';
          emitEvent('status_change', { status: connectionStatus });
        } else {
          connectionStatus = 'disconnected';
          emitEvent('status_change', { status: connectionStatus });
          if (shouldReconnect) {
            setTimeout(startWhatsApp, 3000);
          }
        }
      } else if (connection === 'open') {
        currentQR = null;
        currentQRDataUrl = null;
        connectionStatus = 'connected';
        logBot('✅ Connected successfully to WhatsApp as Linked Device!');
        emitEvent('status_change', { status: connectionStatus });

        syncGroups();
      }
    });

    // استماع للرسائل الواردة
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      for (const msg of messages) {
        handleIncomingMessage(msg);
      }
    });

  } catch (error) {
    logBot('Error starting WhatsApp engine:', error);
    connectionStatus = 'error';
    emitEvent('status_change', { status: connectionStatus, error: error.message });
  }
}

/**
 * تسجيل الخروج وحذف الجلسة
 */
async function logout() {
  try {
    if (sock) {
      await sock.logout();
      sock = null;
    }
  } catch (e) {}

  connectionStatus = 'logged_out';
  currentQR = null;
  currentQRDataUrl = null;

  try {
    if (fs.existsSync(authDir)) {
      fs.rmSync(authDir, { recursive: true, force: true });
    }
  } catch (e) {}

  emitEvent('status_change', { status: connectionStatus });
}

/**
 * مزامنة قائمة الجروبات
 */
async function syncGroups() {
  if (!sock) return [];
  try {
    const groups = await sock.groupFetchAllParticipating();
    const groupList = [];

    for (const jid in groups) {
      const g = groups[jid];
      const groupData = {
        id: g.id,
        name: g.subject || 'Group'
      };
      db.upsertGroup(groupData);
      groupList.push(groupData);
    }

    emitEvent('groups_updated', db.getAllGroups());
    return groupList;
  } catch (error) {
    logBot('Error syncing groups:', error.message);
    return [];
  }
}

// ذاكرة مؤقتة لتجميع رسائل المتصل المتتالية (Smart Message Debouncing)
const contactBuffers = new Map();

/**
 * معالجة الرسالة الواردة (جروبات + جهات اتصال خاصة)
 */
async function handleIncomingMessage(msg) {
  try {
    const jid = msg.key.remoteJid;
    if (!jid || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) {
      return;
    }

    const isGroup = jid.endsWith('@g.us');

    // ================= فحص رسائل البوت ورسائل صاحب الحساب ================= //
    if (msg.key.fromMe) {
      if (botOutgoingMessageIds.has(msg.key.id)) {
        botOutgoingMessageIds.delete(msg.key.id);
        return;
      }
      if (!isGroup) {
        // صاحب الحساب نفسه يكتب حالياً في هذا الشات الخاص
        db.setHumanTakeover(jid, 15);
        logBot(`👤 Owner replied manually in (${jid}) - temporary silence enabled for 15 mins.`);
      }
      return;
    }

    const rawTs = msg.messageTimestamp;
    const messageTimestamp = (typeof rawTs === 'object' && rawTs?.toNumber) 
      ? rawTs.toNumber() 
      : (Number(rawTs) || Math.floor(Date.now() / 1000));

    // شرط الأمان: تجاهل أي رسالة سبقت بدء تشغيل البرنامج
    if (messageTimestamp < botStartTime) {
      return;
    }

    const senderJid = msg.key.participant || msg.key.remoteJid;
    let senderName = msg.pushName || 'User';
    const messageContent = msg.message;
    if (!messageContent) return;

    // تمييز ما إذا كان المتصل هو صاحب الحساب نفسه من رقمه الخاص للطوارئ
    const profile = getActiveProfile();
    const privatePhone = db.getSetting('private_phone', process.env.PRIVATE_PHONE_NUMBER || profile.phone || '');
    const cleanJid = jid.replace('@s.whatsapp.net', '').replace('@lid', '');
    const isOwnerHimself = (privatePhone && (jid.includes(privatePhone) || cleanJid.includes(privatePhone)));
    if (isOwnerHimself) {
      senderName = `${profile.name} (Account Owner)`;
    }

    // فحص نوع الرسالة: نصية أم صوتية
    let messageType = 'text';
    let text = messageContent.conversation || 
               messageContent.extendedTextMessage?.text || 
               '';
    let transcript = '';

    const isAudio = Boolean(messageContent.audioMessage);

    if (isAudio) {
      messageType = 'audio';
      try {
        logBot(`🎙️ Voice note received from ${senderName}. Transcribing via Gemini...`);
        const buffer = await downloadMediaMessage(
          msg,
          'buffer',
          {},
          { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
        );

        if (buffer) {
          transcript = await gemini.transcribeAudio(buffer, messageContent.audioMessage.mimetype || 'audio/ogg');
          logBot(`✅ Voice transcription: ${transcript.slice(0, 100)}...`);
        }
      } catch (err) {
        logBot('❌ Audio transcription failed:', err.message);
        transcript = '[Audio transcription error]';
      }
    }

    // ================= 1. في حالة المحادثات الخاصة مع جهات الاتصال (1-on-1 Direct Chat) ================= //
    if (!isGroup) {
      logBot(`📩 Direct chat from: ${senderName} (${jid}) - Content: "${text || transcript}"`);

      // 1. تسجيل جهة الاتصال والرسالة أولاً لحفظ السجل وعرضه في الشاشة المباشرة
      const contactData = {
        id: jid,
        name: senderName,
        phone: cleanJid
      };
      db.upsertContact(contactData);
      const contact = db.getContactById(jid);

      const messageRecord = {
        id: msg.key.id,
        group_id: jid,
        sender_id: senderJid,
        sender_name: senderName,
        message_type: messageType,
        content: text,
        transcript: transcript,
        timestamp: messageTimestamp
      };
      db.saveMessage(messageRecord);
      emitEvent('new_message', { groupName: senderName, ...messageRecord });

      // 2. فحص هل صاحب الحساب يتحدث حالياً مع هذا الشخص (انسحاب مؤقت 15 دقيقة)
      if (!isOwnerHimself && db.isHumanTakeoverActive(jid)) {
        logBot(`🤫 Temporary takeover active: Owner is actively chatting with ${senderName}. Skipping.`);
        return;
      }

      // 3. فحص المفتاح العام للرد
      const isGlobalContactsReplyEnabled = db.getSetting('contacts_auto_reply_enabled', '1') === '1';
      if (!isGlobalContactsReplyEnabled || (contact && contact.auto_reply !== 1)) {
        logBot(`⏸️ Auto-reply disabled for ${senderName}`);
        return;
      }

      // 4. ميكانيزم التجميع الذكي (Smart Debounce - 4 ثواني)
      if (contactBuffers.has(jid)) {
        clearTimeout(contactBuffers.get(jid).timer);
      }

      const timer = setTimeout(() => {
        contactBuffers.delete(jid);
        handleContactReception(contact, messageRecord);
      }, 4000);

      contactBuffers.set(jid, { timer, lastMsg: messageRecord });
      return;
    }

    // ================= 2. في حالة رسائل الجروبات (@g.us) ================= //
    if (isGroup) {
      const group = db.getGroupById(jid);
      if (!group || group.is_monitored !== 1) {
        return;
      }

      logBot(`👥 Group message in [${group.name}] from ${senderName}: "${text || transcript}"`);

      const messageRecord = {
        id: msg.key.id,
        group_id: jid,
        sender_id: senderJid,
        sender_name: senderName,
        message_type: messageType,
        content: text,
        transcript: transcript,
        timestamp: messageTimestamp
      };

      db.saveMessage(messageRecord);
      emitEvent('new_message', { groupName: group.name, ...messageRecord });

      if (group.auto_reply === 1) {
        handleAutoReply(group, messageRecord);
      }
    }

  } catch (error) {
    logBot('Error handling incoming message:', error.message);
  }
}

/**
 * خدمة اتخاذ وتنفيذ قرارات الوكيل الذكي المستقل (Autonomous Agent Action Execution)
 */
async function handleContactReception(contact, incomingMessage) {
  try {
    const isOwnerHimself = contact.name.includes('Owner') || contact.name.includes('صاحب الحساب');

    if (!isOwnerHimself && db.isHumanTakeoverActive(contact.id)) {
      logBot(`🤫 Owner intervened during debounce. Assistant paused for ${contact.name}.`);
      return;
    }

    const recentMessages = db.getRecentMessages(contact.id, 8);
    logBot(`🧠 ExecuBot analyzing context with "${contact.name}" via Gemini Flash-Lite...`);

    const lang = db.getSetting('app_lang', 'en');
    const decision = await gemini.handleContactInquiry(contact.name, recentMessages, lang);
    if (!decision) return;

    logBot(`📊 ExecuBot Decision: Action = [${decision.action}] | Priority = [${decision.priority}]`);

    // 1. تسجيل الطلب والـ Decision Trace
    db.saveInquiry({
      contact_id: contact.id,
      contact_name: contact.name,
      summary: decision.inquiry_summary || '',
      action_items: decision.action_items || '',
      is_urgent: decision.is_urgent || (decision.action === 'ESCALATE_TO_OWNER'),
      decision_trace: decision.decision_trace || ''
    });

    if (decision.inquiry_summary) {
      db.upsertContact({ id: contact.id, last_inquiry: decision.inquiry_summary });
    }
    emitEvent('inquiries_updated', db.getAllInquiries());
    emitEvent('contacts_updated', db.getAllContacts());

    // 2. تصعيد الطوارئ لرقم صاحب الحساب إن وجد
    const profile = getActiveProfile();
    const privatePhone = db.getSetting('private_phone', process.env.PRIVATE_PHONE_NUMBER || profile.phone || '');
    const privateJid = privatePhone ? `${privatePhone}@s.whatsapp.net` : null;

    if (!isOwnerHimself && (decision.is_urgent || decision.action === 'ESCALATE_TO_OWNER') && sock && privateJid) {
      logBot(`🚨 Emergency escalation to owner for ${contact.name}...`);
      const alertMsg = `🚨 *ExecuBot Urgent Alert:*
━━━━━━━━━━━━━━━━━━
👤 *Sender:* ${contact.name} (${contact.phone})
💬 *Last Message:* ${incomingMessage.content || incomingMessage.transcript}
⚠️ *Reason:* ${decision.urgency_reason || decision.decision_trace || 'Urgent Escalation'}
📝 *Summary:* ${decision.inquiry_summary}
━━━━━━━━━━━━━━━━━━`;
      await sendBotMessage(privateJid, { text: alertMsg });
    }

    // 3. تنفيذ القرار المتخذ
    if (decision.action === 'SILENT') {
      logBot(`🤫 ExecuBot chose silence (natural conversational completion).`);
      return;
    }

    if (decision.action === 'REACTION') {
      const emoji = decision.reaction_emoji || '👍';
      logBot(`🤲 ExecuBot reacting with (${emoji}) to message from ${contact.name}...`);
      try {
        const reactRes = await sock.sendMessage(contact.id, {
          react: {
            text: emoji,
            key: {
              remoteJid: contact.id,
              id: incomingMessage.id
            }
          }
        });
        if (reactRes?.key?.id) {
          botOutgoingMessageIds.add(reactRes.key.id);
          setTimeout(() => botOutgoingMessageIds.delete(reactRes.key.id), 60000);
        }

        db.saveMessage({
          id: 'bot_react_' + Date.now(),
          group_id: contact.id,
          sender_id: 'assistant',
          sender_name: 'ExecuBot',
          message_type: 'reaction',
          content: emoji,
          transcript: '',
          timestamp: Math.floor(Date.now() / 1000)
        });
      } catch (err) {
        logBot('❌ Failed to send reaction:', err.message);
      }
      return;
    }

    const replyText = decision.reply_text;
    if (!replyText || replyText.trim() === '') return;

    if (decision.action === 'VOICE') {
      const voice = db.getSetting('default_voice', process.env.DEFAULT_VOICE || 'ar-EG-ShakirNeural');
      logBot(`🗣️ ExecuBot replying with Voice Note (PTT) to ${contact.name}...`);
      const oggFile = await tts.textToSpeechPTT(replyText, voice);
      if (fs.existsSync(oggFile)) {
        await sendBotMessage(contact.id, {
          audio: fs.readFileSync(oggFile),
          mimetype: 'audio/ogg; codecs=opus',
          ptt: true
        });
        fs.unlinkSync(oggFile);
      }
    } else {
      // REPLY or ESCALATE_TO_OWNER
      logBot(`💬 ExecuBot sending direct text to ${contact.name}: "${replyText}"`);
      await sendBotMessage(contact.id, { text: replyText });
    }

    db.saveMessage({
      id: 'bot_' + Date.now(),
      group_id: contact.id,
      sender_id: 'assistant',
      sender_name: 'ExecuBot',
      message_type: decision.action === 'VOICE' ? 'audio' : 'text',
      content: replyText,
      transcript: replyText,
      timestamp: Math.floor(Date.now() / 1000)
    });

  } catch (error) {
    logBot('❌ Error executing contact inquiry:', error.message);
  }
}

/**
 * معالجة الرد التلقائي الذكي في الجروبات
 */
async function handleAutoReply(group, incomingMessage) {
  try {
    const recentMessages = db.getRecentMessages(group.id, 5);
    logBot(`🤖 Synthesizing group auto-reply for "${group.name}" via Nemotron...`);

    const lang = db.getSetting('app_lang', 'en');
    const replyText = await nemotron.generateAutoReply(group.name, recentMessages, lang);
    if (!replyText || replyText.trim() === '') return;

    if (group.reply_mode === 'voice') {
      const voice = db.getSetting('default_voice', process.env.DEFAULT_VOICE || 'ar-EG-ShakirNeural');
      logBot(`🗣️ Converting reply to Voice Note (PTT)...`);
      const oggFile = await tts.textToSpeechPTT(replyText, voice);

      if (fs.existsSync(oggFile)) {
        await sendBotMessage(group.id, {
          audio: fs.readFileSync(oggFile),
          mimetype: 'audio/ogg; codecs=opus',
          ptt: true
        });
        fs.unlinkSync(oggFile);
        logBot(`✅ Voice auto-reply sent in "${group.name}".`);
      }
    } else {
      await sendBotMessage(group.id, { text: replyText });
      logBot(`✅ Text auto-reply sent in "${group.name}".`);
    }

  } catch (error) {
    logBot('❌ Error in group auto-reply:', error.message);
  }
}

module.exports = {
  startWhatsApp,
  logout,
  getStatus,
  syncGroups,
  setEventEmitter,
  sendBotMessage
};
