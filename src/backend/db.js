const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const dbDir = path.resolve(__dirname, '../../data');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const dbPath = path.join(dbDir, 'assistant.db');
const db = new DatabaseSync(dbPath);

// Initialize Tables
db.exec(`
  CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    name TEXT,
    is_monitored INTEGER DEFAULT 0,
    auto_reply INTEGER DEFAULT 0,
    reply_mode TEXT DEFAULT 'voice',
    keywords TEXT DEFAULT '',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    group_id TEXT,
    sender_id TEXT,
    sender_name TEXT,
    message_type TEXT,
    content TEXT,
    audio_path TEXT,
    transcript TEXT,
    is_summarized INTEGER DEFAULT 0,
    timestamp INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id TEXT,
    summary_date TEXT,
    summary_text TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY,
    name TEXT,
    phone TEXT,
    auto_reply INTEGER DEFAULT 1,
    reply_mode TEXT DEFAULT 'text',
    last_inquiry TEXT DEFAULT '',
    human_takeover_until INTEGER DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS inquiries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id TEXT,
    contact_name TEXT,
    summary TEXT,
    action_items TEXT,
    is_urgent INTEGER DEFAULT 0,
    decision_trace TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Groups
function upsertGroup(group) {
  const stmt = db.prepare(`
    INSERT INTO groups (id, name, updated_at) 
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET 
      name = excluded.name,
      updated_at = CURRENT_TIMESTAMP
  `);
  stmt.run(group.id, group.name);
}

function getAllGroups() {
  return db.prepare('SELECT * FROM groups ORDER BY updated_at DESC').all();
}

function getGroupById(id) {
  return db.prepare('SELECT * FROM groups WHERE id = ?').get(id);
}

function updateGroupSettings(id, { is_monitored, auto_reply, reply_mode, keywords }) {
  const current = getGroupById(id);
  if (!current) return false;

  const stmt = db.prepare(`
    UPDATE groups 
    SET is_monitored = ?, auto_reply = ?, reply_mode = ?, keywords = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  stmt.run(
    is_monitored !== undefined ? (is_monitored ? 1 : 0) : current.is_monitored,
    auto_reply !== undefined ? (auto_reply ? 1 : 0) : current.auto_reply,
    reply_mode !== undefined ? reply_mode : current.reply_mode,
    keywords !== undefined ? keywords : current.keywords,
    id
  );
  return true;
}

// Messages
function saveMessage(msg) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO messages (id, group_id, sender_id, sender_name, message_type, content, audio_path, transcript, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    msg.id,
    msg.group_id,
    msg.sender_id,
    msg.sender_name,
    msg.message_type || 'text',
    msg.content || '',
    msg.audio_path || '',
    msg.transcript || '',
    msg.timestamp || Math.floor(Date.now() / 1000)
  );
}

function updateMessageTranscript(id, transcript) {
  const stmt = db.prepare('UPDATE messages SET transcript = ? WHERE id = ?');
  stmt.run(transcript, id);
}

function getRecentMessages(groupId, limit = 10) {
  const stmt = db.prepare(`
    SELECT * FROM messages 
    WHERE group_id = ? 
    ORDER BY timestamp DESC 
    LIMIT ?
  `);
  return stmt.all(groupId, limit);
}

function getUnsummarizedMessages(groupId) {
  const stmt = db.prepare(`
    SELECT * FROM messages 
    WHERE group_id = ? AND is_summarized = 0 
    ORDER BY timestamp ASC
  `);
  return stmt.all(groupId);
}

function markMessagesSummarized(messageIds) {
  if (!messageIds || messageIds.length === 0) return;
  const placeholders = messageIds.map(() => '?').join(',');
  const stmt = db.prepare(`UPDATE messages SET is_summarized = 1 WHERE id IN (${placeholders})`);
  stmt.run(...messageIds);
}

// Summaries
function saveSummary(groupId, text) {
  const today = new Date().toISOString().split('T')[0];
  const stmt = db.prepare(`
    INSERT INTO summaries (group_id, summary_date, summary_text)
    VALUES (?, ?, ?)
  `);
  stmt.run(groupId, today, text);
}

function getSummaries(groupId) {
  let query = 'SELECT s.*, g.name as group_name FROM summaries s JOIN groups g ON s.group_id = g.id ORDER BY s.created_at DESC';
  if (groupId) {
    query = 'SELECT s.*, g.name as group_name FROM summaries s JOIN groups g ON s.group_id = g.id WHERE s.group_id = ? ORDER BY s.created_at DESC';
    return db.prepare(query).all(groupId);
  }
  return db.prepare(query).all();
}

// Settings
function getSetting(key, defaultValue = null) {
  const stmt = db.prepare('SELECT value FROM settings WHERE key = ?');
  const result = stmt.get(key);
  return result ? result.value : defaultValue;
}

function setSetting(key, value) {
  const stmt = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  stmt.run(key, String(value));
}

function getAllSettings() {
  const rows = db.prepare('SELECT * FROM settings').all();
  const settingsObj = {};
  for (const r of rows) {
    settingsObj[r.key] = r.value;
  }
  return settingsObj;
}

// User Profile (Knowledge Card)
function getUserProfile() {
  const raw = getSetting('user_profile', null);
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch (e) {}
  }
  return {
    name: 'Executive User',
    title: 'Professional',
    tone: 'casual',
    phone: '',
    about: '',
    skills: [],
    work_context: '',
    privacy_rules: 'Never disclose passwords, credentials, bank info, or make financial promises without explicit consent.',
    is_configured: false
  };
}

function saveUserProfile(profile) {
  profile.is_configured = true;
  profile.updated_at = new Date().toISOString();
  setSetting('user_profile', JSON.stringify(profile));
  return profile;
}

// Contacts
function upsertContact(contact) {
  const stmt = db.prepare(`
    INSERT INTO contacts (id, name, phone, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      name = CASE WHEN excluded.name != 'مستخدم' AND excluded.name != 'User' THEN excluded.name ELSE contacts.name END,
      phone = excluded.phone,
      updated_at = CURRENT_TIMESTAMP
  `);
  stmt.run(contact.id, contact.name, contact.phone || '');
}

function getAllContacts() {
  return db.prepare('SELECT * FROM contacts ORDER BY updated_at DESC').all();
}

function getContactById(id) {
  return db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
}

function updateContactSettings(id, { auto_reply, reply_mode }) {
  const current = getContactById(id);
  if (!current) return false;

  const stmt = db.prepare(`
    UPDATE contacts
    SET auto_reply = ?, reply_mode = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  stmt.run(
    auto_reply !== undefined ? (auto_reply ? 1 : 0) : current.auto_reply,
    reply_mode !== undefined ? reply_mode : current.reply_mode,
    id
  );
  return true;
}

// Inquiries
function saveInquiry(inquiry) {
  const stmt = db.prepare(`
    INSERT INTO inquiries (contact_id, contact_name, summary, action_items, is_urgent, decision_trace, status)
    VALUES (?, ?, ?, ?, ?, ?, 'pending')
  `);
  stmt.run(
    inquiry.contact_id,
    inquiry.contact_name,
    inquiry.summary,
    inquiry.action_items || '',
    inquiry.is_urgent ? 1 : 0,
    inquiry.decision_trace || ''
  );
}

function getAllInquiries() {
  return db.prepare('SELECT * FROM inquiries ORDER BY created_at DESC').all();
}

function resolveInquiry(id) {
  db.prepare("UPDATE inquiries SET status = 'resolved' WHERE id = ?").run(id);
}

// Human Takeover
function setHumanTakeover(contactId, minutes = 15) {
  const until = Date.now() + minutes * 60 * 1000;
  db.prepare("UPDATE contacts SET human_takeover_until = ? WHERE id = ?").run(until, contactId);
}

function clearHumanTakeover(contactId) {
  db.prepare("UPDATE contacts SET human_takeover_until = 0 WHERE id = ?").run(contactId);
}

function resetAllHumanTakeovers() {
  db.prepare("UPDATE contacts SET human_takeover_until = 0").run();
}

function isHumanTakeoverActive(contactId) {
  const row = db.prepare("SELECT human_takeover_until FROM contacts WHERE id = ?").get(contactId);
  return row ? (Number(row.human_takeover_until) > Date.now()) : false;
}

module.exports = {
  db,
  upsertGroup,
  getAllGroups,
  getGroupById,
  updateGroupSettings,
  saveMessage,
  updateMessageTranscript,
  getRecentMessages,
  getUnsummarizedMessages,
  markMessagesSummarized,
  saveSummary,
  getSummaries,
  getSetting,
  setSetting,
  getAllSettings,
  getUserProfile,
  saveUserProfile,
  upsertContact,
  getAllContacts,
  getContactById,
  updateContactSettings,
  saveInquiry,
  getAllInquiries,
  resolveInquiry,
  setHumanTakeover,
  clearHumanTakeover,
  resetAllHumanTakeovers,
  isHumanTakeoverActive
};
