import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from './config.js';

let genAI = null;
let model = null;

function initAI() {
  if (!config.geminiApiKey) {
    throw new Error('GEMINI_API_KEY not set');
  }
  if (!genAI) {
    genAI = new GoogleGenerativeAI(config.geminiApiKey);
    model = genAI.getGenerativeModel({ 
      model: config.geminiModel,
      systemInstruction: config.systemPrompt
    });
    console.log(`🤖 Gemini initialized: ${config.geminiModel}`);
  }
  return model;
}

/**
 * Generate AI reply using Gemini with conversation history
 * @param {string} jid - contact JID
 * @param {string} userMessage - latest user message
 * @param {Array} history - previous messages [{role, content}]
 */
export async function generateReply(jid, userMessage, history = []) {
  try {
    const m = initAI();

    // Build chat history for Gemini
    // Convert our history format to Gemini format
    const geminiHistory = history
      .slice(-config.maxHistory) // last N
      .filter(msg => msg.role !== 'system')
      .map(msg => ({
        role: msg.role === 'user' ? 'user' : 'model',
        parts: [{ text: msg.content }]
      }));

    // Start chat with history
    const chat = m.startChat({
      history: geminiHistory,
      generationConfig: {
        maxOutputTokens: 800,
        temperature: 0.8,
        topP: 0.9,
      }
    });

    const result = await chat.sendMessage(userMessage);
    const response = await result.response;
    const text = response.text();

    if (!text) throw new Error('Empty response from Gemini');
    return text.trim();

  } catch (error) {
    console.error('Gemini error:', error.message);

    // Handle rate limits gracefully
    if (error.message?.includes('429') || error.status === 429 || error.message?.toLowerCase().includes('quota')) {
      console.warn('⚠️ Gemini rate limit hit');
      return "I'm getting a lot of messages right now — give me a moment and I'll reply shortly! ⏳";
    }
    if (error.message?.includes('API_KEY') || error.message?.includes('API key')) {
      return "⚠️ AI configuration issue — please check API key. Meanwhile, a human will get back to you soon.";
    }
    // Generic fallback
    return "Hmm, I'm having a little trouble thinking right now. Could you say that again? 🙏";
  }
}

/**
 * Check if message is asking for human handoff
 */
export function isHandoffRequest(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  const triggers = [
    'human', 'real person', 'talk to person', 'speak to person',
    'stop bot', 'pause bot', '#human', '#stop', '#pause',
    'agent', 'representative', 'talk to human', 'human please',
    'i want human', 'need human', 'person please'
  ];
  return triggers.some(t => lower.includes(t));
}

/**
 * Check if message is owner command (fromMe messages)
 */
export function parseOwnerCommand(text) {
  if (!text) return null;
  const lower = text.toLowerCase().trim();
  
  // Commands: /pause 234..., /resume 234..., /clear 234..., /status, /help, /resume all, /clear all
  if (lower.startsWith('/pause ') || lower.startsWith('/stop ')) {
    const target = text.split(' ')[1]?.replace(/[^0-9]/g, '');
    return { action: 'pause', target };
  }
  if (lower.startsWith('/resume ')) {
    const target = lower.split(' ')[1];
    if (target === 'all') return { action: 'resumeAll' };
    return { action: 'resume', target: target.replace(/[^0-9]/g, '') };
  }
  if (lower.startsWith('/clear ')) {
    const target = lower.split(' ')[1];
    if (target === 'all') return { action: 'clearAll' };
    return { action: 'clear', target: target.replace(/[^0-9]/g, '') };
  }
  if (lower === '/status' || lower === '/stats') {
    return { action: 'status' };
  }
  if (lower === '/help' || lower === '/commands') {
    return { action: 'help' };
  }
  if (lower === '/resume all') return { action: 'resumeAll' };
  
  return null;
}

export function getOwnerHelpText() {
  return `🤖 *Bot Owner Commands*
Send these to yourself or in any chat (as your own message):

/pause 2348012345678 - Pause bot for that contact (human takeover)
/resume 2348012345678 - Resume bot for contact
/resume all - Resume bot for everyone
/clear 2348012345678 - Clear chat history for contact
/clear all - (not implemented yet, use individual)
/status - Show bot status
/help - Show this help

*Auto-handoff keywords* (contacts can type):
human, stop bot, pause bot, #human, agent, real person

Bot will auto-resume after ${config.handoffMinutes} minutes.`;
}
