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

async function generateWithGroq(userMessage, history = [], ownerStyleSamples = null, systemPrompt) {
  if (!config.groqApiKey) throw new Error('GROQ_API_KEY not set');
  let dynamicPrompt = systemPrompt;
  if (ownerStyleSamples && ownerStyleSamples.length > 0) {
    const styleExamples = ownerStyleSamples.slice(-12).join('\n- ');
    dynamicPrompt = `You are owner of WhatsApp, not AI. Mimic style:\n- ${styleExamples}\nRules: Be owner, never AI/bot, short (1-2 lines), Nigerian pidgin casual. Bank: ${config.bankInfo || 'say private, never invent'}. Base: ${systemPrompt}`;
  }
  const messages = [
    { role: 'system', content: dynamicPrompt },
    ...history.slice(-10).map(h => ({ role: h.role === 'user' ? 'user' : 'assistant', content: h.content.slice(0, 800) })),
    { role: 'user', content: userMessage }
  ];
  console.log(`🧠 Trying Groq ${config.groqModel}...`);
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${config.groqApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.groqModel, messages, max_tokens: 400, temperature: 0.9 })
  });
  if (!res.ok) throw new Error(`Groq ${res.status}: ${(await res.text()).slice(0,200)}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('Empty Groq response');
  console.log(`✅ Groq replied`);
  return text.trim();
}

async function generateWithOpenRouter(userMessage, history = [], ownerStyleSamples = null, systemPrompt) {
  if (!config.openrouterApiKey) throw new Error('OPENROUTER_API_KEY not set');
  let dynamicPrompt = systemPrompt;
  if (ownerStyleSamples && ownerStyleSamples.length > 0) {
    const styleExamples = ownerStyleSamples.slice(-12).join('\n- ');
    dynamicPrompt = `You are owner of WhatsApp account, not AI. Mimic owner's unique style per contact:\n- ${styleExamples}\nRules: Be owner, never say AI/bot, keep short 1-2 lines, casual Nigerian pidgin, warm. Bank info: ${config.bankInfo || 'Never invent numbers, say private'}. Base personality: ${systemPrompt}. Reply as owner seamlessly.`;
  }
  const messages = [
    { role: 'system', content: dynamicPrompt },
    ...history.slice(-10).map(h => ({ role: h.role === 'user' ? 'user' : 'assistant', content: h.content.slice(0, 800) })),
    { role: 'user', content: userMessage }
  ];
  console.log(`🧠 Trying OpenRouter ${config.openrouterModel}...`);
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.openrouterApiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/bethelisrael2003-bot/whatsapp-ai-bot',
      'X-Title': 'WhatsApp AI Bot'
    },
    body: JSON.stringify({ model: config.openrouterModel, messages, max_tokens: 400, temperature: 0.9 })
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0,300)}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('Empty OpenRouter response');
  console.log(`✅ OpenRouter ${config.openrouterModel} replied`);
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
You are NOT AI. You ARE owner. Chat EXACTLY like owner.
MIMIC OWNER'S STYLE:
- ${styleExamples}
Rules: Be owner, never AI/bot, short (1-2 lines), conversational, human-like.
SAFETY: ${config.bankInfo ? `When asked account/bank: Share EXACTLY: ${config.bankInfo}. Do NOT invent.` : `When asked account/bank: NEVER invent numbers. Say: "Omo make I double-check, I go send am for private now"`}
Base: ${config.systemPrompt}
Reply as owner, seamless.
`;
  } else {
    dynamicSystemPrompt = `
You are owner of WhatsApp. HUMAN, not AI. Never reveal AI/bot. If asked if AI: "Lol, which AI? Na me"
Chat like real Nigerian guy - casual, warm, short. Use slang: boss, omo, my guy, no wahala. Concise.
SAFETY: ${config.bankInfo ? `Account: ${config.bankInfo}. Share exactly when asked.` : `When asked account: NEVER invent numbers. Say private.`}
Personality: ${config.systemPrompt}
Reply as human owner.
`;
  }

  const modelsToTry = [config.geminiModel || 'gemini-3.6-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-flash-latest'];
  const uniqueModels = [...new Set(modelsToTry)];
  let lastError = null;

  // 1. Try Gemini
  for (const modelName of uniqueModels) {
    try {
      const m = initGemini(modelName, dynamicSystemPrompt);
      let geminiHistory = history.slice(-config.maxHistory).filter(msg => msg.role !== 'system' && msg.content && msg.content.trim().length > 0).map(msg => ({ role: msg.role === 'user' ? 'user' : 'model', parts: [{ text: msg.content.slice(0, 1000) }] }));
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
      if (msg.includes('API_KEY') || msg.toLowerCase().includes('api key is invalid')) break;
      if (msg.includes('First content should be with role')) continue;
      if (msg.includes('404') || msg.toLowerCase().includes('not found') || msg.toLowerCase().includes('no longer available')) continue;
      if (msg.includes('429') || msg.includes('503') || error.status === 429 || error.status === 503 || msg.toLowerCase().includes('high demand') || msg.toLowerCase().includes('quota')) continue;
      continue;
    }
  }

  // 2. Fallback Groq
  if (config.groqApiKey) {
    try {
      console.log('🔄 Gemini failed, trying Groq...');
      const groqReply = await generateWithGroq(userMessage, history, ownerStyleSamples, dynamicSystemPrompt);
      if (!config.bankInfo && /\b\d{10}\b/.test(groqReply) && isPaymentRequest) return "Omo make I double-check, I go send am for private 🙏";
      return groqReply;
    } catch (e) {
      console.error('❌ Groq failed:', e.message.slice(0,300));
      lastError = e;
    }
  }

  // 3. Fallback OpenRouter
  if (config.openrouterApiKey) {
    try {
      console.log('🔄 Groq failed, trying OpenRouter...');
      const orReply = await generateWithOpenRouter(userMessage, history, ownerStyleSamples, dynamicSystemPrompt);
      if (!config.bankInfo && /\b\d{10}\b/.test(orReply) && isPaymentRequest) return "Omo make I double-check, I go send am for private 🙏";
      return orReply;
    } catch (e) {
      console.error('❌ OpenRouter failed:', e.message.slice(0,400));
      lastError = e;
    }
  } else {
    console.log('💡 Add OPENROUTER_API_KEY and GROQ_API_KEY for free fallbacks');
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

Bot learns your style!
BANK_INFO for real account
GROQ_API_KEY + OPENROUTER_API_KEY for free backup`;
}
