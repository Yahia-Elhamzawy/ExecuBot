require('dotenv').config();
const db = require('../db');
const { getActiveProfile } = require('./profile');

/**
 * استرجاع إعدادات NVIDIA NIM الحالية من قاعدة البيانات أو .env
 */
function getNvidiaConfig() {
  const apiKey = db.getSetting('nvidia_api_key', process.env.NVIDIA_API_KEY || '');
  const model = db.getSetting('nvidia_model', process.env.NVIDIA_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b');
  const baseUrl = db.getSetting('nvidia_base_url', process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1');
  return { apiKey, model, baseUrl };
}

/**
 * استدعاء نموذج NVIDIA Nemotron (أو أي نموذج متوافق مع OpenAI API)
 */
async function callNemotron(messages, temperature = 0.5) {
  const { apiKey, model, baseUrl } = getNvidiaConfig();
  if (!apiKey) {
    throw new Error('NVIDIA NIM API Key is missing. Please set it in Settings.');
  }

  const endpoint = `${baseUrl}/chat/completions`;

  const payload = {
    model: model,
    messages: messages,
    temperature: temperature,
    max_tokens: 1500
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`NVIDIA NIM API Error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || '';
}

/**
 * إنشاء تقرير وملخص يومي تنفيذي لمجموعة معينة
 */
async function generateDailySummary(groupName, messagesList, lang = 'ar') {
  if (!messagesList || messagesList.length === 0) {
    return lang === 'ar' ? 'لا توجد رسائل مسجلة لهذا الجروب اليوم.' : 'No messages logged for this group today.';
  }

  const profile = getActiveProfile();

  const formattedLog = messagesList.map(m => {
    const time = new Date(m.timestamp * 1000).toLocaleTimeString(lang === 'ar' ? 'ar-EG' : 'en-US', { hour: '2-digit', minute: '2-digit' });
    const content = m.message_type === 'audio' ? `[Voice Note: ${m.transcript || 'untranscribed'}]` : m.content;
    return `[${time}] ${m.sender_name}: ${content}`;
  }).join('\n');

  let systemPrompt = '';
  if (lang === 'en') {
    systemPrompt = `You are ExecuBot's Deep Synthesis Engine. Produce an executive, structured daily report for WhatsApp group "${groupName}" intended for ${profile.name}.
Format the report cleanly:
1. 📌 Key Highlights & Topics Discussed
2. 🎯 Decisions & Agreements Made
3. ⚠️ Action Items & Questions Directed to ${profile.name}
4. 📝 Executive Summary`;
  } else {
    systemPrompt = `أنت مساعد تنفيذي ذكي فائق الدقة. مهمتك إعداد تقرير يومي احترافي ومنظم عما دار في جروب واتساب "${groupName}" لصالح ${profile.name}.
نسق التقرير بالتالي:
1. 📌 أهم النقاط والمواضيع التي نوقشت
2. 🎯 القرارات أو الاتفاقات التي تمت (إن وجدت)
3. ⚠️ طلبات أو مهام موجهة لصاحب الحساب (${profile.name})
4. 📝 ملخص سريع شامل`;
  }

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Chat Messages Log:\n\n${formattedLog}\n\nGenerate the structured report:` }
  ];

  return await callNemotron(messages, 0.4);
}

/**
 * صياغة رد ذكي تلقائي نيابة عن المستخدم في الجروبات
 */
async function generateAutoReply(groupName, recentMessages, lang = 'ar') {
  const profile = getActiveProfile();

  const formattedLog = recentMessages.map(m => {
    const content = m.message_type === 'audio' ? `[Voice Note: ${m.transcript || ''}]` : m.content;
    return `${m.sender_name}: ${content}`;
  }).join('\n');

  const systemPrompt = `You represent ${profile.name} and reply on their behalf in WhatsApp group "${groupName}".
Persona: Friendly, professional, natural communicator in the style of ${profile.tone || 'casual'}.
- Make the reply human, concise, and non-robotic.
- If asked a question, acknowledge and state that ${profile.name} will review, or answer within known bounds.
- Output ONLY the message text ready to send.`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Context of latest messages:\n${formattedLog}\n\nWrite the reply directly:` }
  ];

  return await callNemotron(messages, 0.6);
}

/**
 * شات المساعد: الإجابة عن أي سؤال عن محتوى الجروبات
 */
async function askQuestionAboutHistory(question, contextMessages) {
  const formattedLog = contextMessages.map(m => {
    const content = m.message_type === 'audio' ? `[Voice: ${m.transcript || ''}]` : m.content;
    return `[${m.sender_name}]: ${content}`;
  }).join('\n');

  const systemPrompt = `You are ExecuBot Assistant. Answer the user's inquiry based strictly on the provided WhatsApp logs. Be concise, direct, and factual.`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Chat History:\n${formattedLog}\n\nQuestion: ${question}` }
  ];

  return await callNemotron(messages, 0.4);
}

module.exports = {
  getNvidiaConfig,
  callNemotron,
  generateDailySummary,
  generateAutoReply,
  askQuestionAboutHistory
};
