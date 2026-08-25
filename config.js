import dotenv from 'dotenv';
dotenv.config();

export const config = {
  phoneNumber: (process.env.PHONE_NUMBER || '').replace(/[^0-9]/g, ''),
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  groqApiKey: process.env.GROQ_API_KEY || '',
  openrouterApiKey: process.env.OPENROUTER_API_KEY || '',
  upstashUrl: process.env.UPSTASH_REDIS_REST_URL || '',
  upstashToken: process.env.UPSTASH_REDIS_REST_TOKEN || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.6-flash',
  groqModel: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
  openrouterModel: process.env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-exp:free',
  bankInfo: process.env.BANK_INFO || process.env.PAYMENT_INFO || '',
  systemPrompt: process.env.SYSTEM_PROMPT || `You are a friendly, helpful WhatsApp assistant replying on behalf of the owner. Keep replies conversational, concise, warm, human-like. Never say you are a bot unless asked. Use emojis naturally. Remember context. If asked for human, say handing over. Keep under 3 short paragraphs.`,
  maxHistory: parseInt(process.env.MAX_HISTORY || '20', 10),
  maxPerHour: parseInt(process.env.MAX_PER_HOUR || '30', 10),
  handoffMinutes: parseInt(process.env.HANDOFF_MINUTES || '120', 10),
  ignoreGroups: (process.env.IGNORE_GROUPS || 'true').toLowerCase() === 'true',
  replyDelayMin: parseInt(process.env.REPLY_DELAY_MIN || '1000', 10),
  replyDelayMax: parseInt(process.env.REPLY_DELAY_MAX || '4000', 10),
  port: parseInt(process.env.PORT || '10000', 10),
  ownerNumber: (process.env.OWNER_NUMBER || '').replace(/[^0-9]/g, '')
};

export function validateConfig() {
  const errors = [];
  if (!config.phoneNumber) errors.push('PHONE_NUMBER required');
  if (!config.geminiApiKey && !config.groqApiKey && !config.openrouterApiKey) errors.push('At least one AI key required: GEMINI_API_KEY or GROQ_API_KEY or OPENROUTER_API_KEY');
  if (!config.upstashUrl || !config.upstashToken) console.warn('⚠️ UPSTASH not set');
  if (errors.length) console.error('❌ Config errors:', errors);
  else {
    console.log(`🔑 AI Keys: Gemini=${config.geminiApiKey ? 'YES' : 'NO'}, Groq=${config.groqApiKey ? 'YES' : 'NO'}, OpenRouter=${config.openrouterApiKey ? 'YES' : 'NO'}`);
  }
  return errors.length === 0;
}
