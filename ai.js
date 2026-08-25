import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from './config.js';

let genAI = null;
let model = null;
let currentModelName = null;

function initAI(modelName = null) {
  if (!config.geminiApiKey) {
    throw new Error('GEMINI_API_KEY not set');
  }
  const targetModel = modelName || config.geminiModel || 'gemini-2.5-flash';
  
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

export async function generateReply(jid, userMessage, history = []) {
  // UPDATED AUG 2026: Google now says use 3.6/3.5 series for new users
  // Error: "2.5-flash is no longer available to new users. Use 3.6-flash"
  const modelsToTry = [
    config.geminiModel || 'gemini-2.5-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.5-flash',
    'gemini-3-flash',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-flash-latest',
    'gemini-pro-latest',
    'gemini-1.5-flash-002'
  ];
  const uniqueModels = [...new Set(modelsToTry)];

  let lastError = null;

  for (const modelName of uniqueModels) {
    try {
      const m = initAI(modelName);

      const geminiHistory = history
        .slice(-config.maxHistory)
        .filter(msg => msg.role !== 'system' && msg.content)
        .map(msg => ({
          role: msg.role === 'user' ? 'user' : 'model',
          parts: [{ text: msg.content.slice(0, 1000) }]
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
      const msg = error.message || '';
      console.error(`❌ Gemini error with ${modelName}:`, msg.slice(0,400));

      if (msg.includes('API_KEY') || msg.toLowerCase().includes('api key is invalid') || msg.includes('API key not valid')) {
        return "⚠️ My AI brain needs a valid API key — owner please check GEMINI_API_KEY on Render.";
      }

      // Try to extract suggested model from error message
      // e.g. "Please update your code to use models/gemini-3.6-flash"
      const match = msg.match(/models\/([a-z0-9\-.]+)/i);
      if (match) {
        console.log(`💡 Google suggests: ${match[1]}`);
      }

      // 404 - try next
      if (msg.includes('404') || msg.toLowerCase().includes('not found') || msg.toLowerCase().includes('not available') || msg.toLowerCase().includes('no longer available')) {
        console.warn(`⚠️ Model ${modelName} not available, trying next...`);
        continue;
      }

      if (msg.includes('429') || error.status === 429 || msg.toLowerCase().includes('quota')) {
        console.warn(`⚠️ Rate limit on ${modelName}, trying next...`);
        continue;
      }

      continue;
    }
  }

  console.error('💥 All Gemini models failed. Last error:', lastError?.message?.slice(0,300));
  
  return `Hmm, I'm having a little trouble thinking right now. Could you say that again? 🙏`;
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
  if (lower === '/status' || lower === '/stats') return { action: 'status' };
  if (lower === '/help' || lower === '/commands') return { action: 'help' };
  if (lower === '/resume all') return { action: 'resumeAll' };
  return null;
}

export function getOwnerHelpText() {
  return `🤖 *Bot Owner Commands*
/pause 2348012345678 - Pause bot
/resume 2348012345678 - Resume
/resume all - Resume all
/clear 2348012345678 - Clear history
/status - Status
/help - Help`;
}
