import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from './config.js';

let genAI = null;
let model = null;
let currentModelName = null;

function initAI(modelName = null, systemPrompt = null) {
  if (!config.geminiApiKey) throw new Error('GEMINI_API_KEY not set');
  const targetModel = modelName || config.geminiModel || 'gemini-3.6-flash';
  const promptToUse = systemPrompt || config.systemPrompt;
  if (!genAI || currentModelName !== targetModel) {
    genAI = new GoogleGenerativeAI(config.geminiApiKey);
    currentModelName = targetModel;
  }
  model = genAI.getGenerativeModel({ model: targetModel, systemInstruction: promptToUse });
  return model;
}

export async function generateReply(jid, userMessage, history = [], ownerStyleSamples = null) {
  const lowerMsg = userMessage.toLowerCase();
  const isAskingAccount = lowerMsg.includes('account number') || lowerMsg.includes('acct number') || lowerMsg.includes('bank') && (lowerMsg.includes('send') || lowerMsg.includes('opay') || lowerMsg.includes('a/c')) || lowerMsg.includes('send me money') && lowerMsg.includes('account');

  // More precise detection for payment requests
  const paymentKeywords = ['account number', 'acct number', 'a/c number', 'opay', 'bank name', 'send me your account', 'your account', 'account details'];
  const isPaymentRequest = paymentKeywords.some(k => lowerMsg.includes(k));

  let dynamicSystemPrompt = config.systemPrompt;

  if (ownerStyleSamples && ownerStyleSamples.length > 0) {
    const styleExamples = ownerStyleSamples.slice(-12).join('\n- ');
    dynamicSystemPrompt = `
You are NOT an AI. You ARE the owner of this WhatsApp account. Chat EXACTLY like owner.

CRITICAL RULES:
1. You ARE owner. Never say AI/bot/assistant.
2. If asked "are you AI?" -> "Lol which AI? Na me dey here"
3. MIMIC OWNER'S STYLE with THIS person:
- ${styleExamples}
4. Copy greeting, slang, length, emoji, punctuation.
5. Keep replies SHORT (1-2 lines).
6. Be conversational, human-like.
7. Remember context.

SAFETY - PAYMENT INFO:
${config.bankInfo ? `- When asked for account/bank: Share EXACTLY this: ${config.bankInfo} - DO NOT invent numbers. Share as owner would.` : `- When asked for account/bank/money: NEVER invent account numbers. Say: "Omo make I double-check, I go send am for private now" and DO NOT share any numbers. Never hallucinate bank details.`}
- Never share PIN, password, OTP.
- Never invent financial info.

Base: ${config.systemPrompt}
Reply as owner, seamless.
`;
  } else {
    dynamicSystemPrompt = `
You are owner of this WhatsApp account. You are HUMAN, not AI.
CRITICAL:
- Never reveal AI/bot.
- If asked if AI: "Lol, which AI? Na me"
- Chat like real Nigerian guy - casual, warm, short.
- Use slang: "boss", "omo", "my guy", "no wahala"
- Keep concise (1-2 sentences)

SAFETY - PAYMENT:
${config.bankInfo ? `When asked for account/bank: Share EXACTLY: ${config.bankInfo}. Do not invent.` : `When asked for account/bank: NEVER invent numbers. Say you will send privately. Example: "Make I confirm, I go send am now". Never share fake account.`}

Personality: ${config.systemPrompt}
Reply as human owner.
`;
  }

  // If payment request and we have no bank info, force handoff-style reply without calling AI to avoid hallucination
  if (isPaymentRequest && !config.bankInfo) {
    console.log(`💳 Payment request detected from ${jid}, no BANK_INFO set - using safe fallback`);
    // Still call AI but with strong instruction not to hallucinate, or return safe message
    // We'll let AI handle but with safety prompt above
  }

  const modelsToTry = [config.geminiModel || 'gemini-3.6-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-flash-latest'];
  const uniqueModels = [...new Set(modelsToTry)];
  let lastError = null;

  for (const modelName of uniqueModels) {
    try {
      const m = initAI(modelName, dynamicSystemPrompt);
      let geminiHistory = history
        .slice(-config.maxHistory)
        .filter(msg => msg.role !== 'system' && msg.content && msg.content.trim().length > 0)
        .map(msg => ({ role: msg.role === 'user' ? 'user' : 'model', parts: [{ text: msg.content.slice(0, 1000) }] }));

      while (geminiHistory.length > 0 && geminiHistory[0].role !== 'user') geminiHistory.shift();
      
      const cleanedHistory = [];
      for (let i = 0; i < geminiHistory.length; i++) {
        const curr = geminiHistory[i];
        if (cleanedHistory.length > 0 && cleanedHistory[cleanedHistory.length-1].role === curr.role) {
          cleanedHistory[cleanedHistory.length-1].parts[0].text += '\n' + curr.parts[0].text;
        } else cleanedHistory.push(curr);
      }
      geminiHistory = cleanedHistory;

      const chat = m.startChat({ history: geminiHistory, generationConfig: { maxOutputTokens: 600, temperature: 0.9, topP: 0.95 } });
      console.log(`🧠 Asking ${modelName} for ${jid} (history: ${geminiHistory.length}, style: ${ownerStyleSamples?.length || 0}): "${userMessage.slice(0,50)}..."`);
      const result = await chat.sendMessage(userMessage);
      const text = result.response.text();
      if (!text) throw new Error('Empty response');
      console.log(`✅ Reply: ${text.slice(0,80)}...`);
      
      // Post-check: If bot hallucinated account number and we have no BANK_INFO, block it
      if (!config.bankInfo && /\b\d{10}\b/.test(text) && isPaymentRequest) {
        console.warn('⚠️ Blocked hallucinated account number in reply');
        return "Omo make I double-check my Opay, I go send am for private now now 🙏";
      }
      
      return text.trim();
    } catch (error) {
      lastError = error;
      const msg = error.message || '';
      console.error(`❌ ${modelName} error:`, msg.slice(0,400));
      if (msg.includes('API_KEY') || msg.toLowerCase().includes('api key is invalid')) return "My guy, network dey do me somehow, make I get back to you 🙏";
      if (msg.includes('First content should be with role')) continue;
      if (msg.includes('404') || msg.toLowerCase().includes('not found') || msg.toLowerCase().includes('no longer available')) continue;
      if (msg.includes('429') || error.status === 429) continue;
      continue;
    }
  }

  console.error('💥 All models failed:', lastError?.message?.slice(0,300));
  try {
    const m = initAI(uniqueModels[0], dynamicSystemPrompt);
    const chat = m.startChat({ history: [], generationConfig: { maxOutputTokens: 600, temperature: 0.9 } });
    const result = await chat.sendMessage(userMessage);
    const text = result.response.text();
    if (text) {
      if (!config.bankInfo && /\b\d{10}\b/.test(text) && isPaymentRequest) {
        return "Omo make I double-check, I go send am for private 🙏";
      }
      return text.trim();
    }
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
/clear 234... - Clear history
/style 234... - Show learned style
/status - Status
/help - Help

Bot learns your style per contact!
Set BANK_INFO env var to share real account safely.`;
}
