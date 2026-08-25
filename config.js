import dotenv from 'dotenv';
dotenv.config();

export const config = {
  phoneNumber: (process.env.PHONE_NUMBER || '').replace(/[^0-9]/g, ''),
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  upstashUrl: process.env.UPSTASH_REDIS_REST_URL || '',
  upstashToken: process.env.UPSTASH_REDIS_REST_TOKEN || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.6-flash',
  // Secure payment info - set in Render env, never in code
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
  if (!config.geminiApiKey) errors.push('GEMINI_API_KEY required');
  if (!config.upstashUrl || !config.upstashToken) console.warn('⚠️ UPSTASH not set - using local files');
  if (errors.length) console.error('❌ Config errors:', errors);
  return errors.length === 0;
}
