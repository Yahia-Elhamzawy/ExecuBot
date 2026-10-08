require('dotenv').config();
const db = require('../db');
const { getActiveProfile, formatProfileForPrompt } = require('./profile');

/**
 * استرجاع إعدادات Gemini الحالية من قاعدة البيانات أو .env
 */
function getGeminiConfig() {
  const apiKey = db.getSetting('gemini_api_key', process.env.GEMINI_API_KEY || '');
  const model = db.getSetting('gemini_model', process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite');
  return { apiKey, model };
}

/**
 * استدعاء نموذج Google Gemini عبر REST API
 */
async function callGemini(contents, systemInstruction = '', jsonMode = false) {
  const { apiKey, model } = getGeminiConfig();
  if (!apiKey) {
    throw new Error('Google Gemini API Key is missing. Please set it in Settings.');
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const payload = {
    contents: contents,
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 1200
    }
  };

  if (systemInstruction) {
    payload.systemInstruction = {
      parts: [{ text: systemInstruction }]
    };
  }

  if (jsonMode) {
    payload.generationConfig.responseMimeType = 'application/json';
  }

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API Error (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const candidate = data.candidates?.[0];
  if (!candidate || !candidate.content?.parts?.[0]?.text) {
    throw new Error('لم يتم استلام رد صالح من Gemini');
  }

  return candidate.content.parts[0].text;
}

/**
 * تفريغ واستيعاب التسجيلات الصوتية عبر Gemini Multimodal
 */
async function transcribeAudio(audioBuffer, mimeType = 'audio/ogg') {
  const base64Data = audioBuffer.toString('base64');

  const contents = [
    {
      parts: [
        {
          inlineData: {
            mimeType: mimeType.split(';')[0].trim(),
            data: base64Data
          }
        },
        {
          text: 'قم بتفريغ هذا التسجيل الصوتي بدقة بالغة إلى نص كامل ومفهوم بنفس اللهجة واللغة التي يتحدث بها صاحب التسجيل بدون اختصار أو تأليف.'
        }
      ]
    }
  ];

  return await callGemini(contents);
}

/**
 * الوكيل الذكي المستقل لإدارة شات جهات الاتصال الخاصة (1-on-1 Autonomous Agent)
 */
async function handleContactInquiry(contactName, recentMessages, lang = 'ar') {
  const profile = getActiveProfile();
  const profileSummary = formatProfileForPrompt(profile, lang);

  // ترتيب المحادثة زمنياً
  const chronological = [...recentMessages].reverse();

  // فحص ما إذا كان المساعد قد شارك في المحادثة سابقاً
  const hasBotRepliedBefore = chronological.some(m => 
    m.sender_id === 'assistant' || 
    m.sender_name?.includes('مساعد') || 
    m.sender_name?.includes('Assistant')
  );

  const lastUserMsg = chronological.filter(m => m.sender_id !== 'assistant').pop();
  const isLastMsgAudio = lastUserMsg?.message_type === 'audio';

  const formattedLog = chronological.map(m => {
    const time = new Date(m.timestamp * 1000).toLocaleTimeString(lang === 'ar' ? 'ar-EG' : 'en-US', { hour: '2-digit', minute: '2-digit' });
    const content = m.message_type === 'audio' 
      ? `[${lang === 'ar' ? 'تسجيل صوتي' : 'Voice Note'}: ${m.transcript || ''}]` 
      : m.content;
    return `[${time}] ${m.sender_name}: ${content}`;
  }).join('\n');

  const isOwner = contactName.includes('صاحب الحساب') || 
                  contactName.includes(profile.name) || 
                  contactName.toLowerCase().includes('owner');

  let flowInstruction = '';
  if (isOwner) {
    flowInstruction = `⚠️ [CRITICAL: The person contacting you is ${profile.name} (The Owner)]:
You are speaking directly with your boss/owner!
- Never say "${profile.name} is unavailable" because you are talking directly to them.
- Respond warmly, loyally, and concisely as an executive right-hand assistant.
- Answer their questions or confirm their requests instantly.`;
  } else if (hasBotRepliedBefore) {
    flowInstruction = `⚠️ [CONVERSATION IN PROGRESS]:
You have already introduced yourself in earlier messages!
DO NOT repeat introductions like "Hello, I am the AI assistant" or "${profile.name} is currently unavailable".
Respond directly and smartly to what the user said. If they say "thanks", "ok", or send gratitude/acknowledgment, choose REACTION instead of sending redundant text.`;
  } else {
    flowInstruction = `First interaction with this contact: Greet them politely, briefly, and naturally, stating that ${profile.name} is currently away and asking how you can help take a message.`;
  }

  const systemPrompt = `You are ExecuBot, the Autonomous AI Executive Assistant to "${profile.name}".
You operate inside real WhatsApp direct chats with the owner's contacts, colleagues, and friends.
Your mission: Screen inquiries diplomatically, protect the owner's time and privacy, and take structured action.

${profileSummary}

${flowInstruction}

Available Actions:
1. "REPLY": Send a short, crisp text message in the user's language/dialect.
2. "VOICE": Send a human voice note (PTT) - Choose if the contact sent a voice note, or tone requires personal touch.
3. "REACTION": React with emoji (e.g. 🤲, 👍, ❤️) - ALWAYS pick this for simple acknowledgments ("ok", "thanks", "great") that don't need a new message.
4. "ESCALATE_TO_OWNER": If the request involves money, financial obligations, signing contracts, passwords, or critical emergencies. Reassure the user without making commitments and escalate.
5. "SILENT": No action needed (conversation concluded naturally).

Strict Guardrails:
- Accuracy and privacy over appearing smart.
- Never invent or assume facts not in the Knowledge Card.
- Never commit the owner to financial loans, agreements, or deadlines without authorization.

Output MUST be valid JSON only:
{
  "intent": "Short intent classification",
  "priority": "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
  "action": "REPLY" | "VOICE" | "REACTION" | "ESCALATE_TO_OWNER" | "SILENT",
  "reaction_emoji": "🤲" (if action is REACTION, else empty),
  "reply_text": "The message to send to the contact",
  "inquiry_summary": "One sentence summary of what the contact wants",
  "action_items": "Deadlines or tasks needed if any",
  "is_urgent": false,
  "urgency_reason": "",
  "decision_trace": "[Intent: ...] ➔ [Priority: ...] ➔ [Action: ...]"
}`;

  const promptText = `Chat History:\n${formattedLog}\n\nSender: ${contactName} (Last message was ${isLastMsgAudio ? 'Voice Note' : 'Text'})\n\nDecide action and output JSON:`;

  try {
    const rawResponse = await callGemini([{ text: promptText }], systemPrompt, true);
    const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (!parsed.decision_trace) {
        parsed.decision_trace = `Intent: ${parsed.intent || 'General'} ➔ Priority: ${parsed.priority || 'LOW'} ➔ Action: ${parsed.action}`;
      }
      return parsed;
    }

    return {
      intent: "General Inquiry",
      priority: "LOW",
      action: "REPLY",
      reaction_emoji: "",
      reply_text: hasBotRepliedBefore 
        ? "تمام، سجلت رسالتك وهنقلها لصاحب الحساب أول ما يفتح بإذن الله." 
        : `أهلاً بيك! أنا مساعد ${profile.name}، هو مش متاح حالياً.. أقدر أبلغه بإيه أول ما يفتح؟`,
      inquiry_summary: rawResponse.slice(0, 150),
      action_items: "",
      is_urgent: false,
      urgency_reason: "",
      decision_trace: "Intent: General ➔ Action: REPLY"
    };
  } catch (err) {
    console.error('Failed Gemini agent decision:', err.message);
    return {
      intent: "Fallback",
      priority: "LOW",
      action: "REPLY",
      reaction_emoji: "",
      reply_text: hasBotRepliedBefore ? "تمام، سجلت رسالتك وهنقلها فوراً." : `أهلاً بيك! أنا مساعد ${profile.name}، هو مش متاح حالياً.. أقدر أبلغه بإيه؟`,
      inquiry_summary: "رسالة واردة من جهة اتصال",
      action_items: "",
      is_urgent: false,
      urgency_reason: "",
      decision_trace: "Fallback ➔ Action: REPLY"
    };
  }
}

module.exports = {
  getGeminiConfig,
  callGemini,
  transcribeAudio,
  handleContactInquiry
};
