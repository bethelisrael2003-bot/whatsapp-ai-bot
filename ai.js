import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from './config.js';

let genAI = null;
let currentModelName = null;

function initGemini(modelName = null, systemPrompt = null) {
  if (!config.geminiApiKey) throw new Error('GEMINI_API_KEY not set');
  const targetModel = modelName || config.geminiModel || 'gemini-3.6-flash';
  const promptToUse = systemPrompt || config.systemPrompt;
  if (!genAI || currentModelName !== targetModel) {
    genAI = new GoogleGenerativeAI(config.geminiApiKey);
    currentModelName = targetModel;
  }
  return genAI.getGenerativeModel({ model: targetModel, systemInstruction: promptToUse });
}

// GROQ fallback - free, fast, 14k req/day
async function generateWithGroq(userMessage, history = [], ownerStyleSamples = null, systemPrompt) {
  if (!config.groqApiKey) throw new Error('GROQ_API_KEY not set');

  let dynamicPrompt = systemPrompt;
  if (ownerStyleSamples && ownerStyleSamples.length > 0) {
    const styleExamples = ownerStyleSamples.slice(-12).join('\n- ');
    dynamicPrompt = `You are the owner of this WhatsApp account. You ARE the owner, not AI. Mimic owner's style with this person:
- ${styleExamples}
Rules: Be owner, never say AI/bot, keep short (1-2 lines), casual Nigerian style, use slang like boss/omo. If asked for account and you have bank info: ${config.bankInfo || 'say you will send privately, never invent numbers'}. Base: ${systemPrompt}`;
  }

  const messages = [
    { role: 'system', content: dynamicPrompt },
    ...history.slice(-10).map(h => ({ role: h.role === 'user' ? 'user' : 'assistant', content: h.content.slice(0, 800) })),
    { role: 'user', content: userMessage }
  ];

  console.log(`🧠 Trying Groq ${config.groqModel} as fallback...`);
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.groqApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: config.groqModel,
      messages,
      max_tokens: 400,
      temperature: 0.9
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Groq ${res.status}: ${err.slice(0,200)}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('Empty Groq response');
  console.log(`✅ Groq replied: ${text.slice(0,80)}...`);
  return text.trim();
}

export async function generateReply(jid, userMessage, history = [], ownerStyleSamples = null) {
  const lowerMsg = userMessage.toLowerCase();
  const paymentKeywords = ['account number', 'acct number', 'a/c number', 'opay', 'bank name', 'send me your account', 'your account', 'account details'];
  const isPaymentRequest = paymentKeywords.some(k => lowerMsg.includes(k));

  let dynamicSystemPrompt = config.systemPrompt;
  if (ownerStyleSamples && ownerStyleSamples.length > 0) {
    const styleExamples = ownerStyleSamples.slice(-12).join('\n- ');
    dynamicSystemPrompt = `
You are NOT AI. You ARE owner of this WhatsApp. Chat EXACTLY like owner.
MIMIC OWNER'S STYLE with THIS person:
- ${styleExamples}
Rules: Be owner, never AI/bot, short (1-2 lines), conversational, human-like.
SAFETY: ${config.bankInfo ? `When asked for account/bank: Share EXACTLY: ${config.bankInfo}. Do NOT invent.` : `When asked for account/bank: NEVER invent numbers. Say: "Omo make I double-check, I go send am for private now"`}
Base: ${config.systemPrompt}
Reply as owner, seamless.
`;
  } else {
    dynamicSystemPrompt = `
You are owner of WhatsApp account. HUMAN, not AI. Never reveal AI/bot. If asked if AI: "Lol, which AI? Na me"
Chat like real Nigerian guy - casual, warm, short. Use slang: boss, omo, my guy, no wahala. Concise.
SAFETY: ${config.bankInfo ? `Account: ${config.bankInfo}. Share exactly when asked.` : `When asked account: NEVER invent numbers. Say you will send privately.`}
Personality: ${config.systemPrompt}
Reply as human owner.
`;
  }

  const modelsToTry = [config.geminiModel || 'gemini-3.6-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-flash-latest'];
  const uniqueModels = [...new Set(modelsToTry)];
  let lastError = null;

  // Try Gemini first
  for (const modelName of uniqueModels) {
    try {
      const m = initGemini(modelName, dynamicSystemPrompt);
      let geminiHistory = history
        .slice(-config.maxHistory)
        .filter(msg => msg.role !== 'system' && msg.content && msg.content.trim().length > 0)
        .map(msg => ({ role: msg.role === 'user' ? 'user' : 'model', parts: [{ text: msg.content.slice(0, 1000) }] }));
      while (geminiHistory.length > 0 && geminiHistory[0].role !== 'user') geminiHistory.shift();
      const cleaned = [];
      for (let i = 0; i < geminiHistory.length; i++) {
        const curr = geminiHistory[i];
        if (cleaned.length > 0 && cleaned[cleaned.length-1].role === curr.role) cleaned[cleaned.length-1].parts[0].text += '\n' + curr.parts[0].text;
        else cleaned.push(curr);
      }
      geminiHistory = cleaned;

      const chat = m.startChat({ history: geminiHistory, generationConfig: { maxOutputTokens: 600, temperature: 0.9, topP: 0.95 } });
      console.log(`🧠 Asking ${modelName} for ${jid} (history: ${geminiHistory.length}, style: ${ownerStyleSamples?.length || 0})`);
      const result = await chat.sendMessage(userMessage);
      const text = result.response.text();
      if (!text) throw new Error('Empty response');
      console.log(`✅ Gemini ${modelName} replied`);
      
      if (!config.bankInfo && /\b\d{10}\b/.test(text) && isPaymentRequest) {
        console.warn('⚠️ Blocked hallucinated account');
        return "Omo make I double-check my Opay, I go send am for private now now 🙏";
      }
      return text.trim();
    } catch (error) {
      lastError = error;
      const msg = error.message || '';
      console.error(`❌ ${modelName} error:`, msg.slice(0,300));
      if (msg.includes('API_KEY') || msg.toLowerCase().includes('api key is invalid')) {
        // Don't return yet, try Groq fallback
        console.log('🔄 Gemini key issue, trying Groq fallback...');
        break;
      }
      if (msg.includes('First content should be with role')) continue;
      if (msg.includes('404') || msg.toLowerCase().includes('not found') || msg.toLowerCase().includes('no longer available')) continue;
      if (msg.includes('429') || msg.includes('503') || error.status === 429 || error.status === 503 || msg.toLowerCase().includes('high demand') || msg.toLowerCase().includes('quota')) {
        console.log('⚠️ Gemini overloaded/quota, trying next model or Groq...');
        continue;
      }
      continue;
    }
  }

  // Fallback to Groq if Gemini failed and Groq key exists
  if (config.groqApiKey) {
    try {
      console.log('🔄 All Gemini models failed, trying Groq fallback...');
      const groqReply = await generateWithGroq(userMessage, history, ownerStyleSamples, dynamicSystemPrompt);
      if (!config.bankInfo && /\b\d{10}\b/.test(groqReply) && isPaymentRequest) {
        return "Omo make I double-check, I go send am for private 🙏";
      }
      return groqReply;
    } catch (groqError) {
      console.error('❌ Groq also failed:', groqError.message.slice(0,300));
      lastError = groqError;
    }
  } else {
    console.log('💡 Tip: Add GROQ_API_KEY for free fallback when Gemini is overloaded');
  }

  console.error('💥 All AI failed:', lastError?.message?.slice(0,300));
  try {
    const m = initGemini(uniqueModels[0], dynamicSystemPrompt);
    const chat = m.startChat({ history: [], generationConfig: { maxOutputTokens: 600, temperature: 0.9 } });
    const result = await chat.sendMessage(userMessage);
    const text = result.response.text();
    if (text) return text.trim();
  } catch {}

  return "Network dey worry small, I go reply you now now 🙏";
}

export function isHandoffRequest(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  const triggers = ['human', 'real person', 'talk to person', 'stop bot', 'pause bot', '#human', '#stop', '#pause', 'agent', 'representative', 'talk to human', 'human please', 'i want human', 'need human', 'person please'];
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
  if (lower.startsWith('/style ')) {
    const target = text.split(' ')[1]?.replace(/[^0-9]/g, '');
    return { action: 'style', target };
  }
  if (lower === '/status' || lower === '/stats') return { action: 'status' };
  if (lower === '/help') return { action: 'help' };
  if (lower === '/resume all') return { action: 'resumeAll' };
  return null;
}

export function getOwnerHelpText() {
  return `🤖 *Owner Commands*
/pause 234... - Pause
/resume 234... - Resume
/resume all - Resume all
/clear 234... - Clear
/style 234... - Show style
/status - Status + AI keys
/help - Help

Bot learns your style per contact!
Set BANK_INFO for real account.
Add GROQ_API_KEY for free backup when Gemini busy.`;
}
