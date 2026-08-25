import dotenv from 'dotenv';
dotenv.config();

export const config = {
  // Required
  phoneNumber: (process.env.PHONE_NUMBER || '').replace(/[^0-9]/g, ''), // e.g. 2348012345678
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  upstashUrl: process.env.UPSTASH_REDIS_REST_URL || '',
  upstashToken: process.env.UPSTASH_REDIS_REST_TOKEN || '',

  // Optional with defaults
  geminiModel: process.env.GEMINI_MODEL || 'gemini-1.5-flash',
  systemPrompt: process.env.SYSTEM_PROMPT || `You are a friendly, helpful WhatsApp assistant replying on behalf of the owner. 
Keep replies conversational, concise (WhatsApp style), warm, and human-like. 
- Never say you are an AI model or bot unless asked.
- Use occasional emojis naturally, not excessively.
- If you don't know something, be honest and helpful.
- Remember context from earlier in the conversation.
- If someone asks to speak to a human, acknowledge and say you'll hand over.
- Keep replies under 3 short paragraphs max.`,

  maxHistory: parseInt(process.env.MAX_HISTORY || '20', 10),
  maxPerHour: parseInt(process.env.MAX_PER_HOUR || '30', 10),
  handoffMinutes: parseInt(process.env.HANDOFF_MINUTES || '120', 10),
  ignoreGroups: (process.env.IGNORE_GROUPS || 'true').toLowerCase() === 'true',
  replyDelayMin: parseInt(process.env.REPLY_DELAY_MIN || '1000', 10),
  replyDelayMax: parseInt(process.env.REPLY_DELAY_MAX || '4000', 10),
  port: parseInt(process.env.PORT || '10000', 10),

  // Owner control: your own JID or number that can send commands via self-chat or fromMe messages
  // If empty, any fromMe message with /command will be treated as owner command
  ownerNumber: (process.env.OWNER_NUMBER || '').replace(/[^0-9]/g, '')
};

export function validateConfig() {
  const errors = [];
  if (!config.phoneNumber) errors.push('PHONE_NUMBER is required (e.g. 2348012345678 without +)');
  if (!config.geminiApiKey) errors.push('GEMINI_API_KEY is required');
  if (!config.upstashUrl || !config.upstashToken) {
    console.warn('⚠️  UPSTASH_REDIS_REST_URL / TOKEN not set - falling back to local file storage (will NOT survive Render restarts!). Set them for production.');
  }
  if (errors.length) {
    console.error('❌ Config errors:');
    errors.forEach(e => console.error(' - ' + e));
    console.error('\nCheck your Environment Variables on Render.');
  }
  return errors.length === 0;
}
