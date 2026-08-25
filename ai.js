import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from './config.js';

let genAI = null;
let model = null;
let currentModelName = null;

function initAI(modelName = null) {
  if (!config.geminiApiKey) {
    throw new Error('GEMINI_API_KEY not set');
  }
  const targetModel = modelName || config.geminiModel || 'gemini-1.5-flash';
  
  // Re-init if model changed
  if (!genAI || currentModelName !== targetModel) {
    genAI = new GoogleGenerativeAI(config.geminiApiKey);
    currentModelName = targetModel;
    console.log(`🤖 Gemini initializing: ${targetModel}`);
    model = genAI.getGenerativeModel({ 
      model: targetModel,
      systemInstruction: config.systemPrompt
    });
    console.log(`🤖 Gemini ready: ${targetModel}`);
  }
  return model;
}

/**
 * Generate AI reply using Gemini with conversation history
 * Tries multiple models as fallback for free tier issues
 */
export async function generateReply(jid, userMessage, history = []) {
  // Models to try in order (free tier friendly)
  const modelsToTry = [
    config.geminiModel || 'gemini-1.5-flash',
    'gemini-1.5-flash',
    'gemini-1.5-flash-latest',
    'gemini-2.0-flash-exp',
    'gemini-1.5-flash-8b',
    'gemini-pro'
  ];
  // Deduplicate
  const uniqueModels = [...new Set(modelsToTry)];

  let lastError = null;

  for (const modelName of uniqueModels) {
    try {
      const m = initAI(modelName);

      // Build chat history for Gemini
      const geminiHistory = history
        .slice(-config.maxHistory)
        .filter(msg => msg.role !== 'system' && msg.content)
        .map(msg => ({
          role: msg.role === 'user' ? 'user' : 'model',
          parts: [{ text: msg.content.slice(0, 1000) }] // trim long messages
        }));

      const chat = m.startChat({
        history: geminiHistory,
        generationConfig: {
          maxOutputTokens: 800,
          temperature: 0.8,
          topP: 0.9,
        }
      });

      console.log(`🧠 Asking ${modelName} for reply to ${jid}: "${userMessage.slice(0,50)}..."`);
      const result = await chat.sendMessage(userMessage);
      const response = await result.response;
      const text = response.text();

      if (!text) throw new Error('Empty response from Gemini');
      
      console.log(`✅ Gemini ${modelName} replied: ${text.slice(0,80)}...`);
      return text.trim();

    } catch (error) {
      lastError = error;
      console.error(`❌ Gemini error with ${modelName}:`, error.message);
      console.error(`   Status: ${error.status} | Full:`, JSON.stringify(error, Object.getOwnPropertyNames(error)).slice(0,500));

      // Don't retry on API key errors - fail fast
      if (error.message?.includes('API_KEY') || error.message?.includes('API key') || error.message?.toLowerCase().includes('api key is invalid')) {
        console.error('🔑 Invalid API key detected!');
        return "⚠️ My AI brain needs a valid API key — owner please check GEMINI_API_KEY on Render. I'll be back soon! 🙏";
      }

      // Rate limit - try next model or wait
      if (error.message?.includes('429') || error.status === 429 || error.message?.toLowerCase().includes('quota') || error.message?.toLowerCase().includes('rate')) {
        console.warn(`⚠️ Rate limit on ${modelName}, trying next model...`);
        continue; // try next model
      }

      // Model not found - try next
      if (error.message?.toLowerCase().includes('not found') || error.message?.toLowerCase().includes('not supported') || error.status === 404) {
        console.warn(`⚠️ Model ${modelName} not found, trying next...`);
        continue;
      }

      // For other errors, try next model as well
      continue;
    }
  }

  // All models failed
  console.error('💥 All Gemini models failed. Last error:', lastError?.message);
  
  if (lastError?.message?.toLowerCase().includes('quota') || lastError?.status === 429) {
    return "I'm getting lots of messages right now — give me a moment and I'll reply shortly! ⏳";
  }
  
  return `Hmm, I'm having a little trouble thinking right now (${lastError?.message?.slice(0,80) || 'unknown'}). Could you say that again? 🙏`;
}

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

export function parseOwnerCommand(text) {
  if (!text) return null;
  const lower = text.toLowerCase().trim();
  
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
/status - Show bot status
/help - Show this help

*Auto-handoff keywords* (contacts can type):
human, stop bot, pause bot, #human, agent, real person

Bot will auto-resume after ${config.handoffMinutes} minutes.`;
}
