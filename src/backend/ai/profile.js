const db = require('../db');

/**
 * استرجاع بطاقة المعرفة الشخصية الخاصة بالمستخدم من قاعدة البيانات
 */
function getActiveProfile() {
  return db.getUserProfile();
}

/**
 * تنسيق بطاقة المعرفة الشخصية لإدراجها في موجه النظام (System Prompt)
 */
function formatProfileForPrompt(profile, lang = 'ar') {
  if (lang === 'en') {
    return `
Owner Profile (Knowledge Card):
- Name: ${profile.name || 'Account Owner'}
- Role/Occupation: ${profile.title || 'Professional'}
- Communication Tone: ${profile.tone || 'Friendly & Casual'}
- Work & Background: ${profile.work_context || profile.about || 'Not specified'}
- Key Skills: ${Array.isArray(profile.skills) ? profile.skills.join(', ') : (profile.skills || 'General')}
- Security & Privacy Rules: ${profile.privacy_rules || 'Strict privacy. Never share credentials or make financial commitments.'}
`;
  }

  return `
معلومات صاحب الحساب المعتمدة (Knowledge Card):
- الاسم: ${profile.name || 'صاحب الحساب'}
- التخصص والوظيفة: ${profile.title || 'مهني'}
- أسلوب ونبرة الكلام: ${profile.tone || 'عفوي، ودود ومباشر'}
- نبذة ومجال الشغل: ${profile.work_context || profile.about || 'غير محدد'}
- المهارات والتقنيات: ${Array.isArray(profile.skills) ? profile.skills.join(', ') : (profile.skills || 'عام')}
- قواعد الخصوصية والأمان: ${profile.privacy_rules || 'ممنوع التخمين أو مشاركة أي بيانات حساسة أو إعطاء وعود مالية.'}
`;
}

/**
 * البرومبت السحري الموجه لـ ChatGPT / Claude
 * يقوم المستخدم بنسخه وإرساله إلى ChatGPT ليقوم الأخير باستجوابه وصياغة ملف تعريفي منظم
 */
function getChatGPTProfilePrompt() {
  return `You are an expert AI Executive Assistant Architect. I am setting up "ExecuBot", my personal autonomous WhatsApp AI Executive Assistant.

Your task:
Interview me by asking 4-5 quick, concise questions to build my personal "Knowledge Card" so the AI assistant can represent me authentically, protect my privacy, and screen my WhatsApp messages.

Please ask me:
1. What is your full/preferred name and title/profession?
2. What are the key skills, projects, or topics people usually contact you about?
3. What is your preferred communication tone? (e.g., Casual Egyptian Arabic, professional English, direct, humorous, etc.)
4. What topics or requests must NEVER be answered by the bot without your explicit personal approval? (e.g., financial loans, contracts, deadlines, personal whereabouts).
5. (Optional) Any specific background details (university, company, hobbies)?

Once I reply, please output ONLY a single valid JSON block formatted exactly like this:

\`\`\`json
{
  "name": "Your Name",
  "title": "Your Role/Profession",
  "tone": "casual / professional / witty",
  "phone": "Your Private Emergency Number (optional)",
  "about": "A concise 2-sentence summary of who you are",
  "skills": ["Skill 1", "Skill 2", "Skill 3"],
  "work_context": "Details on your current projects or focus",
  "privacy_rules": "Strict rules on what the assistant must never disclose or agree to"
}
\`\`\`

Start by asking me the questions now!`;
}

module.exports = {
  getActiveProfile,
  formatProfileForPrompt,
  getChatGPTProfilePrompt
};
