let currentLang = 'en';
let translations = {};
let currentGroups = [];
let currentContacts = [];
let currentInquiries = [];

// ===================== i18n Translation Engine ===================== //

async function loadLocale(lang) {
  try {
    const res = await fetch(`locales/${lang}.json`);
    translations = await res.json();
    currentLang = lang;
    applyTranslations();
  } catch (e) {
    console.error('Failed to load locale:', e);
  }
}

function applyTranslations() {
  document.body.classList.toggle('rtl', currentLang === 'ar');
  document.documentElement.lang = currentLang;

  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (translations[key]) {
      el.innerText = translations[key];
    }
  });
}

async function setLanguage(lang) {
  await loadLocale(lang);
  try {
    await fetch('/api/settings/language', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lang })
    });
  } catch (e) {}
}

document.getElementById('btnLangEn').addEventListener('click', () => setLanguage('en'));
document.getElementById('btnLangAr').addEventListener('click', () => setLanguage('ar'));

// ===================== WebSocket Connection ===================== //

let socket;
function initWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;
  socket = new WebSocket(wsUrl);

  socket.onopen = () => {
    console.log('Connected to ExecuBot WebSocket server');
  };

  socket.onmessage = (event) => {
    try {
      const { type, data } = JSON.parse(event.data);
      handleServerEvent(type, data);
    } catch (e) {}
  };

  socket.onclose = () => {
    setTimeout(initWebSocket, 3000);
  };
}

function handleServerEvent(type, data) {
  switch (type) {
    case 'status_change':
      updateStatus(data.status, data.qr);
      break;
    case 'qr':
      updateStatus('qr_ready', data.qr);
      break;
    case 'groups_updated':
      currentGroups = data;
      renderGroups(data);
      break;
    case 'contacts_updated':
      currentContacts = data;
      renderContacts(data);
      break;
    case 'inquiries_updated':
      currentInquiries = data;
      renderInquiries(data);
      break;
    case 'new_message':
      loadInquiries();
      loadContacts();
      break;
  }
}

// ===================== Status & QR ===================== //

const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const qrWrapper = document.getElementById('qrWrapper');
const qrImage = document.getElementById('qrImage');
const qrLoading = document.getElementById('qrLoading');
const connectedBadge = document.getElementById('connectedBadge');

async function checkStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    updateStatus(data.status, data.qr);
  } catch (e) {
    updateStatus('disconnected');
  }
}

function updateStatus(status, qr) {
  statusDot.className = 'status-dot ' + status;

  if (status === 'connected') {
    statusText.innerText = translations['status_connected'] || 'Connected';
    qrWrapper.style.display = 'none';
    qrLoading.style.display = 'none';
    connectedBadge.style.display = 'block';
  } else if (status === 'qr_ready') {
    statusText.innerText = translations['status_qr_ready'] || 'Scan QR Code';
    connectedBadge.style.display = 'none';
    qrLoading.style.display = 'none';
    if (qr) {
      qrImage.src = qr;
      qrWrapper.style.display = 'block';
    }
  } else if (status === 'connecting') {
    statusText.innerText = translations['status_connecting'] || 'Connecting...';
    qrLoading.style.display = 'block';
    qrWrapper.style.display = 'none';
    connectedBadge.style.display = 'none';
  } else {
    statusText.innerText = translations['status_disconnected'] || 'Disconnected';
    qrWrapper.style.display = 'none';
    qrLoading.style.display = 'none';
    connectedBadge.style.display = 'none';
  }
}

document.getElementById('btnReconnect').addEventListener('click', () => {
  fetch('/api/connect', { method: 'POST' });
});

document.getElementById('btnLogout').addEventListener('click', () => {
  if (confirm('Are you sure you want to log out and delete session credentials?')) {
    fetch('/api/logout', { method: 'POST' });
  }
});

// ===================== Navigation Pages ===================== //

const navItems = document.querySelectorAll('.nav-item');
const pages = document.querySelectorAll('.content-page');

navItems.forEach(item => {
  item.addEventListener('click', () => {
    const pageId = item.getAttribute('data-page');

    navItems.forEach(i => i.classList.remove('active'));
    pages.forEach(p => p.classList.remove('active'));

    item.classList.add('active');
    document.getElementById(pageId)?.classList.add('active');

    if (pageId === 'page-groups') loadGroups();
    if (pageId === 'page-contacts') { loadInquiries(); loadContacts(); }
    if (pageId === 'page-reports') loadReports();
    if (pageId === 'page-settings') loadSettings();
  });
});

// Tabs in Settings
const tabBtns = document.querySelectorAll('.tab-btn');
const tabContents = document.querySelectorAll('.tab-content');

tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.getAttribute('data-tab');
    tabBtns.forEach(b => b.classList.remove('active'));
    tabContents.forEach(c => c.style.display = 'none');

    btn.classList.add('active');
    document.getElementById(target).style.display = 'block';
  });
});

// ===================== Groups Management ===================== //

async function loadGroups() {
  try {
    const res = await fetch('/api/groups');
    currentGroups = await res.json();
    renderGroups(currentGroups);
  } catch (e) {}
}

function renderGroups(groups) {
  const container = document.getElementById('groupsGrid');
  const search = document.getElementById('groupSearchInput').value.toLowerCase();
  const filtered = groups.filter(g => (g.name || '').toLowerCase().includes(search));

  if (filtered.length === 0) {
    container.innerHTML = `<div style="grid-column: 1/-1; padding: 20px; text-align: center; color: var(--text-secondary);">${translations['groups_empty'] || 'No groups found'}</div>`;
    return;
  }

  container.innerHTML = filtered.map(g => {
    const isMonitored = g.is_monitored === 1;
    const isAutoReply = g.auto_reply === 1;
    const initial = (g.name || 'G').charAt(0);

    return `
      <div class="group-card">
        <div class="group-header">
          <div class="group-avatar">${escapeHtml(initial)}</div>
          <div class="group-info">
            <h3 title="${escapeHtml(g.name)}">${escapeHtml(g.name)}</h3>
            <span>ID: ${escapeHtml(g.id.split('@')[0])}</span>
          </div>
        </div>
        <div class="group-controls">
          <div class="control-row">
            <span>Monitor & Synthesize:</span>
            <label class="fluent-switch">
              <input type="checkbox" ${isMonitored ? 'checked' : ''} onchange="toggleGroupSetting('${g.id}', 'is_monitored', this.checked)">
              <span class="switch-slider"></span>
            </label>
          </div>
          <div class="control-row">
            <span>Group Auto-Reply:</span>
            <label class="fluent-switch">
              <input type="checkbox" ${isAutoReply ? 'checked' : ''} onchange="toggleGroupSetting('${g.id}', 'auto_reply', this.checked)">
              <span class="switch-slider"></span>
            </label>
          </div>
          <div class="control-row" style="margin-top: 10px;">
            <button class="fluent-btn primary" style="width: 100%; font-size: 11.5px; padding: 5px;" onclick="generateSummaryNow('${g.id}')">📊 Generate Daily Report Now</button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

async function toggleGroupSetting(id, key, val) {
  const payload = {};
  payload[key] = val;
  await fetch(`/api/groups/${id}/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  loadGroups();
}

document.getElementById('groupSearchInput').addEventListener('input', () => renderGroups(currentGroups));
document.getElementById('btnSyncGroups').addEventListener('click', async () => {
  const btn = document.getElementById('btnSyncGroups');
  btn.innerText = 'Syncing...';
  try {
    await fetch('/api/groups/sync', { method: 'POST' });
    await loadGroups();
  } finally {
    btn.innerText = translations['btn_sync_groups'] || 'Sync Groups';
  }
});

// ===================== Inquiries & Contacts ===================== //

async function loadInquiries() {
  try {
    const res = await fetch('/api/inquiries');
    currentInquiries = await res.json();
    renderInquiries(currentInquiries);
  } catch (e) {}
}

function renderInquiries(inquiries) {
  const container = document.getElementById('inquiriesList');
  if (!inquiries || inquiries.length === 0) {
    container.innerHTML = `<div class="fluent-card" style="text-align: center; color: var(--text-secondary); padding: 30px;">${translations['inquiries_empty'] || 'No inquiries yet.'}</div>`;
    return;
  }

  container.innerHTML = inquiries.map(inq => {
    const isUrgent = inq.is_urgent === 1;
    const isResolved = inq.status === 'resolved';
    const dateStr = new Date(inq.created_at).toLocaleTimeString();

    return `
      <div class="inquiry-card ${isUrgent ? 'urgent' : ''}">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <div>
            <strong>👤 ${escapeHtml(inq.contact_name)}</strong>
            <span style="font-size: 11.5px; color: var(--text-secondary); margin-left: 6px;">(${dateStr})</span>
          </div>
          <div>
            ${isUrgent ? '<span class="badge-urgent">🚨 URGENT</span>' : '<span class="badge-normal">🟢 NORMAL</span>'}
          </div>
        </div>
        <div style="font-size: 13.5px; margin-bottom: 8px;">
          <strong>Request Summary:</strong> ${escapeHtml(inq.summary)}
        </div>
        ${inq.action_items ? `
          <div style="font-size: 12.5px; color: #EAA300; background: rgba(234, 163, 0, 0.08); padding: 6px 10px; border-radius: 4px; margin-bottom: 8px;">
            <strong>📌 Action Items:</strong> ${escapeHtml(inq.action_items)}
          </div>
        ` : ''}
        ${inq.decision_trace ? `
          <div style="font-family: monospace; font-size: 11px; background: rgba(0, 120, 212, 0.08); border: 1px solid rgba(0, 120, 212, 0.2); color: #60A5FA; padding: 4px 10px; border-radius: 4px;">
            ⚡ <strong>Decision Trace:</strong> ${escapeHtml(inq.decision_trace)}
          </div>
        ` : ''}
        ${!isResolved ? `
          <div style="margin-top: 10px; display: flex; gap: 8px; flex-wrap: wrap;">
            <button class="chip-btn" onclick="quickReply('${inq.contact_id}', 'Thanks! I received your message and will get back to you shortly.', 'text')">💬 Quick Reply: Will follow up</button>
            <button class="fluent-btn" style="padding: 3px 10px; font-size: 11.5px; margin-left: auto;" onclick="resolveInquiry(${inq.id})">✅ Mark Resolved</button>
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
}

async function resolveInquiry(id) {
  await fetch(`/api/inquiries/${id}/resolve`, { method: 'POST' });
  loadInquiries();
}

async function quickReply(jid, text, mode) {
  try {
    await fetch('/api/messages/reply-quick', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jid, text, mode })
    });
    alert('Quick reply sent successfully!');
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

async function loadContacts() {
  try {
    const res = await fetch('/api/contacts');
    currentContacts = await res.json();
    renderContacts(currentContacts);
  } catch (e) {}
}

function renderContacts(contacts) {
  const container = document.getElementById('contactsGrid');
  if (!contacts || contacts.length === 0) {
    container.innerHTML = `<div style="grid-column: 1/-1; padding: 20px; text-align: center; color: var(--text-secondary);">No contacts recorded yet.</div>`;
    return;
  }

  container.innerHTML = contacts.map(c => {
    const isAutoReply = c.auto_reply === 1;
    const isTakeover = c.human_takeover_until && Number(c.human_takeover_until) > Date.now();
    const initial = (c.name || 'U').charAt(0);

    return `
      <div class="group-card">
        <div class="group-header">
          <div class="group-avatar" style="color: #4ADE80;">${escapeHtml(initial)}</div>
          <div class="group-info">
            <h3 title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</h3>
            <span>📱 ${escapeHtml(c.phone || '')}</span>
          </div>
        </div>
        <div class="group-controls">
          ${isTakeover ? `
            <div class="control-row" style="background: rgba(239, 68, 68, 0.1); padding: 5px 8px; border-radius: 4px; border: 1px solid rgba(239, 68, 68, 0.2);">
              <span style="color: #F87171; font-size: 11.5px;">🤫 Takeover Active</span>
              <button class="chip-btn" style="color: #4ADE80;" onclick="clearContactTakeover('${c.id}')">Resume</button>
            </div>
          ` : ''}
          <div class="control-row">
            <span>Auto-Reply:</span>
            <label class="fluent-switch">
              <input type="checkbox" ${isAutoReply ? 'checked' : ''} onchange="toggleContactSetting('${c.id}', 'auto_reply', this.checked)">
              <span class="switch-slider"></span>
            </label>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

async function clearContactTakeover(id) {
  await fetch(`/api/contacts/${id}/clear-takeover`, { method: 'POST' });
  loadContacts();
}

async function toggleContactSetting(id, key, val) {
  const payload = {};
  payload[key] = val;
  await fetch(`/api/contacts/${id}/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  loadContacts();
}

document.getElementById('btnResetTakeovers').addEventListener('click', async () => {
  await fetch('/api/contacts/reset-takeover', { method: 'POST' });
  loadContacts();
  alert('All temporary takeover silences have been cleared!');
});

document.getElementById('toggleGlobalContactsReply').addEventListener('change', async (e) => {
  await fetch('/api/settings/contacts-autoreply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: e.target.checked })
  });
});

// ===================== Summaries & Chat ===================== //

async function generateSummaryNow(groupId) {
  alert('Generating summary with Nemotron... Please check Daily Reports shortly.');
  await fetch('/api/summaries/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ groupId })
  });
  loadReports();
}

async function loadReports() {
  const container = document.getElementById('reportsList');
  try {
    const res = await fetch('/api/summaries');
    const summaries = await res.json();
    if (!summaries || summaries.length === 0) {
      container.innerHTML = `<div class="fluent-card" style="text-align: center; color: var(--text-secondary); padding: 30px;">No daily reports yet.</div>`;
      return;
    }

    container.innerHTML = summaries.map(s => `
      <div class="fluent-card" style="margin-bottom: 16px;">
        <div style="display: flex; justify-content: space-between; margin-bottom: 10px;">
          <strong style="color: #60A5FA;">👥 ${escapeHtml(s.group_name)}</strong>
          <span style="font-size: 12px; color: var(--text-secondary);">${new Date(s.created_at).toLocaleDateString()}</span>
        </div>
        <div style="font-size: 13.5px; line-height: 1.7; white-space: pre-wrap;">${escapeHtml(s.summary_text)}</div>
      </div>
    `).join('');
  } catch (e) {}
}

document.getElementById('btnSendChat').addEventListener('click', sendChatMessage);
document.getElementById('chatInput').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') sendChatMessage();
});

async function sendChatMessage() {
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text) return;

  appendChatBubble(text, 'user');
  input.value = '';

  const botBubbleId = appendChatBubble('Thinking...', 'bot');

  try {
    const res = await fetch('/api/chat/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: text })
    });
    const data = await res.json();
    document.getElementById(botBubbleId).innerText = data.answer || 'No answer generated.';
  } catch (e) {
    document.getElementById(botBubbleId).innerText = 'Error: ' + e.message;
  }
}

function appendChatBubble(text, role) {
  const id = 'msg_' + Date.now();
  const div = document.createElement('div');
  div.id = id;
  div.className = `chat-bubble ${role}`;
  div.innerText = text;
  document.getElementById('chatMessages').appendChild(div);
  document.getElementById('chatMessages').scrollTop = document.getElementById('chatMessages').scrollHeight;
  return id;
}

// ===================== Settings, Keys & Profile ===================== //

async function loadSettings() {
  try {
    const res = await fetch('/api/settings');
    const data = await res.json();

    document.getElementById('inputGeminiKey').value = data.gemini_api_key || '';
    document.getElementById('inputGeminiModel').value = data.gemini_model || 'gemini-2.5-flash-lite';
    document.getElementById('inputNvidiaKey').value = data.nvidia_api_key || '';
    document.getElementById('inputNvidiaModel').value = data.nvidia_model || 'nvidia/nemotron-3-ultra-550b-a55b';

    if (data.profile) {
      document.getElementById('inputProfileName').value = data.profile.name || '';
      document.getElementById('inputProfileTitle').value = data.profile.title || '';
      document.getElementById('inputProfileTone').value = data.profile.tone || '';
      document.getElementById('inputProfilePhone').value = data.profile.phone || '';
      document.getElementById('inputProfileWork').value = data.profile.work_context || '';
      document.getElementById('inputProfilePrivacy').value = data.profile.privacy_rules || '';
    }

    if (!data.is_setup_completed) {
      openWizard();
    }
  } catch (e) {}
}

document.getElementById('btnSaveKeys').addEventListener('click', async () => {
  const payload = {
    gemini_api_key: document.getElementById('inputGeminiKey').value.trim(),
    gemini_model: document.getElementById('inputGeminiModel').value.trim(),
    nvidia_api_key: document.getElementById('inputNvidiaKey').value.trim(),
    nvidia_model: document.getElementById('inputNvidiaModel').value.trim()
  };

  await fetch('/api/settings/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  alert('AI Engine keys and models saved successfully!');
});

document.getElementById('btnSaveProfile').addEventListener('click', async () => {
  const payload = {
    name: document.getElementById('inputProfileName').value.trim(),
    title: document.getElementById('inputProfileTitle').value.trim(),
    tone: document.getElementById('inputProfileTone').value.trim(),
    phone: document.getElementById('inputProfilePhone').value.trim(),
    work_context: document.getElementById('inputProfileWork').value.trim(),
    privacy_rules: document.getElementById('inputProfilePrivacy').value.trim()
  };

  await fetch('/api/settings/profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  alert('Personal Knowledge Card saved successfully!');
});

// ChatGPT Meta-Prompt Copy Tool
document.getElementById('btnCopyChatGPTPrompt').addEventListener('click', async () => {
  const res = await fetch('/api/settings/chatgpt-prompt');
  const data = await res.json();
  navigator.clipboard.writeText(data.prompt);
  alert('Interview Prompt copied to clipboard! Paste it into ChatGPT or Claude.');
});

document.getElementById('btnPasteProfileJSON').addEventListener('click', async () => {
  const jsonStr = prompt('Paste the JSON block generated by ChatGPT/Claude here:');
  if (!jsonStr) return;
  try {
    const parsed = JSON.parse(jsonStr.replace(/```json/g, '').replace(/```/g, '').trim());
    if (parsed.name) document.getElementById('inputProfileName').value = parsed.name;
    if (parsed.title) document.getElementById('inputProfileTitle').value = parsed.title;
    if (parsed.tone) document.getElementById('inputProfileTone').value = parsed.tone;
    if (parsed.phone) document.getElementById('inputProfilePhone').value = parsed.phone;
    if (parsed.work_context || parsed.about) document.getElementById('inputProfileWork').value = parsed.work_context || parsed.about;
    if (parsed.privacy_rules) document.getElementById('inputProfilePrivacy').value = parsed.privacy_rules;
    alert('Profile parsed successfully! Click "Save Changes" to apply.');
  } catch (e) {
    alert('Invalid JSON: ' + e.message);
  }
});

// ===================== Onboarding Wizard ===================== //

let wizardCurrentStep = 1;
const wizardModal = document.getElementById('wizardModal');

function openWizard() {
  wizardCurrentStep = 1;
  showWizardStep(1);
  wizardModal.style.display = 'flex';
}

function closeWizard() {
  wizardModal.style.display = 'none';
}

function showWizardStep(step) {
  wizardCurrentStep = step;
  document.getElementById('wizardStep1').style.display = step === 1 ? 'block' : 'none';
  document.getElementById('wizardStep2').style.display = step === 2 ? 'block' : 'none';
  document.getElementById('wizardStep3').style.display = step === 3 ? 'block' : 'none';

  document.getElementById('stepIndicator1').className = 'wizard-step ' + (step === 1 ? 'active' : (step > 1 ? 'done' : ''));
  document.getElementById('stepIndicator2').className = 'wizard-step ' + (step === 2 ? 'active' : (step > 2 ? 'done' : ''));
  document.getElementById('stepIndicator3').className = 'wizard-step ' + (step === 3 ? 'active' : (step > 3 ? 'done' : ''));

  document.getElementById('btnWizardBack').style.display = step > 1 ? 'block' : 'none';
  document.getElementById('btnWizardNext').innerText = step === 3 ? 'Finish & Launch 🚀' : 'Next ➔';
}

document.getElementById('cardChooseEn').addEventListener('click', () => {
  setLanguage('en');
  document.getElementById('cardChooseEn').style.borderColor = 'var(--accent)';
  document.getElementById('cardChooseAr').style.borderColor = 'var(--border-subtle)';
});

document.getElementById('cardChooseAr').addEventListener('click', () => {
  setLanguage('ar');
  document.getElementById('cardChooseAr').style.borderColor = 'var(--accent)';
  document.getElementById('cardChooseEn').style.borderColor = 'var(--border-subtle)';
});

document.getElementById('btnWizardBack').addEventListener('click', () => {
  if (wizardCurrentStep > 1) showWizardStep(wizardCurrentStep - 1);
});

document.getElementById('btnWizardNext').addEventListener('click', async () => {
  if (wizardCurrentStep === 1) {
    showWizardStep(2);
  } else if (wizardCurrentStep === 2) {
    showWizardStep(3);
  } else if (wizardCurrentStep === 3) {
    // Complete Setup
    const payload = {
      lang: currentLang,
      gemini_api_key: document.getElementById('wizardGeminiKey').value.trim(),
      gemini_model: 'gemini-2.5-flash-lite',
      nvidia_api_key: document.getElementById('wizardNvidiaKey').value.trim(),
      nvidia_model: 'nvidia/nemotron-3-ultra-550b-a55b',
      profile: {
        name: document.getElementById('wizardProfileName').value.trim() || 'User',
        title: document.getElementById('wizardProfileTitle').value.trim() || 'Professional',
        phone: document.getElementById('wizardProfilePhone').value.trim() || ''
      }
    };

    await fetch('/api/settings/complete-setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    closeWizard();
    fetch('/api/connect', { method: 'POST' });
    alert('Setup complete! ExecuBot is starting WhatsApp connection.');
    checkStatus();
  }
});

document.getElementById('btnWizardCopyPrompt').addEventListener('click', async () => {
  const res = await fetch('/api/settings/chatgpt-prompt');
  const data = await res.json();
  navigator.clipboard.writeText(data.prompt);
  alert('Copied! Send this to ChatGPT or Claude to get your JSON profile.');
});

document.getElementById('btnWizardPasteJSON').addEventListener('click', () => {
  const jsonStr = prompt('Paste the JSON block here:');
  if (!jsonStr) return;
  try {
    const parsed = JSON.parse(jsonStr.replace(/```json/g, '').replace(/```/g, '').trim());
    if (parsed.name) document.getElementById('wizardProfileName').value = parsed.name;
    if (parsed.title) document.getElementById('wizardProfileTitle').value = parsed.title;
    if (parsed.phone) document.getElementById('wizardProfilePhone').value = parsed.phone;
    alert('Profile imported successfully!');
  } catch (e) {
    alert('Invalid JSON: ' + e.message);
  }
});

function escapeHtml(text) {
  const div = document.createElement('div');
  div.innerText = text || '';
  return div.innerHTML;
}

// Init
loadLocale('en');
initWebSocket();
checkStatus();
loadSettings();
