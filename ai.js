import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from './config.js';

let genAI = null;
let currentModelName = null;

function initGemini(modelName, systemPrompt) {
  if (!config.geminiApiKey) throw new Error('No Gemini key');
  const targetModel = modelName || config.geminiModel;
  if (!genAI || currentModelName !== targetModel) {
    genAI = new GoogleGenerativeAI(config.geminiApiKey);
    currentModelName = targetModel;
  }
  return genAI.getGenerativeModel({ model: targetModel, systemInstruction: systemPrompt });
}

// Generic OpenAI-compatible caller for Groq, Together, OpenRouter, Mistral
async function callOpenAICompatible({ apiKey, baseUrl, model, messages, providerName }) {
  if (!apiKey) throw new Error(`No ${providerName} key`);
  console.log(`🧠 Trying ${providerName} ${model}...`);
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...(providerName === 'OpenRouter' ? { 'HTTP-Referer': 'https://github.com/bethelisrael2003-bot/whatsapp-ai-bot', 'X-Title': 'WhatsApp Bot' } : {}) },
    body: JSON.stringify({ model, messages, max_tokens: 400, temperature: 0.9 })
  });
  if (!res.ok) throw new Error(`${providerName} ${res.status}: ${(await res.text()).slice(0,300)}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || data.choices?.[0]?.text;
  if (!text) throw new Error(`Empty ${providerName} response`);
  console.log(`✅ ${providerName} replied`);
  return text.trim();
}

async function generateWithGroq(userMessage, history, style, systemPrompt) {
  const messages = buildMessages(userMessage, history, style, systemPrompt);
  return callOpenAICompatible({ apiKey: config.groqApiKey, baseUrl: 'https://api.groq.com/openai/v1', model: config.groqModel, messages, providerName: 'Groq' });
}

async function generateWithOpenRouter(userMessage, history, style, systemPrompt) {
  const messages = buildMessages(userMessage, history, style, systemPrompt);
  return callOpenAICompatible({ apiKey: config.openrouterApiKey, baseUrl: 'https://openrouter.ai/api/v1', model: config.openrouterModel, messages, providerName: 'OpenRouter' });
}

async function generateWithTogether(userMessage, history, style, systemPrompt) {
  const messages = buildMessages(userMessage, history, style, systemPrompt);
  return callOpenAICompatible({ apiKey: config.togetherApiKey, baseUrl: 'https://api.together.xyz/v1', model: config.togetherModel, messages, providerName: 'Together' });
}

async function generateWithMistral(userMessage, history, style, systemPrompt) {
  const messages = buildMessages(userMessage, history, style, systemPrompt);
  return callOpenAICompatible({ apiKey: config.mistralApiKey, baseUrl: 'https://api.mistral.ai/v1', model: config.mistralModel, messages, providerName: 'Mistral' });
}

async function generateWithHuggingFace(userMessage, history, style, systemPrompt) {
  if (!config.hfApiKey) throw new Error('No HF key');
  // HF Inference API - different format
  const prompt = `${systemPrompt}\n\n${history.slice(-5).map(h => `${h.role}: ${h.content}`).join('\n')}\nuser: ${userMessage}\nassistant:`;
  console.log(`🧠 Trying HuggingFace ${config.hfModel}...`);
  const res = await fetch(`https://api-inference.huggingface.co/models/${config.hfModel}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${config.hfApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ inputs: prompt, parameters: { max_new_tokens: 300, temperature: 0.9 } })
  });
  if (!res.ok) throw new Error(`HF ${res.status}: ${(await res.text()).slice(0,200)}`);
  const data = await res.json();
  const text = Array.isArray(data) ? data[0]?.generated_text?.split('assistant:').pop() : data.generated_text?.split('assistant:').pop();
  if (!text) throw new Error('Empty HF response');
  console.log(`✅ HuggingFace replied`);
  return text.trim();
}

function buildMessages(userMessage, history, ownerStyleSamples, systemPrompt) {
  let dynamicPrompt = systemPrompt;
  if (ownerStyleSamples && ownerStyleSamples.length > 0) {
    const styleExamples = ownerStyleSamples.slice(-12).join('\n- ');
    dynamicPrompt = `You are owner of WhatsApp, not AI. Mimic style:\n- ${styleExamples}\nBe owner, never AI/bot, short 1-2 lines, Nigerian pidgin casual. Bank: ${config.bankInfo || 'private, never invent'}. Base: ${systemPrompt}`;
  }
  return [
    { role: 'system', content: dynamicPrompt },
    ...history.slice(-10).map(h => ({ role: h.role === 'user' ? 'user' : 'assistant', content: h.content.slice(0, 800) })),
    { role: 'user', content: userMessage }
  ];
}

export async function generateReply(jid, userMessage, history = [], ownerStyleSamples = null) {
  const lowerMsg = userMessage.toLowerCase();
  const paymentKeywords = ['account number', 'acct number', 'a/c number', 'opay', 'bank name', 'send me your account', 'your account', 'account details'];
  const isPaymentRequest = paymentKeywords.some(k => lowerMsg.includes(k));

  let dynamicSystemPrompt = config.systemPrompt;
  if (ownerStyleSamples && ownerStyleSamples.length > 0) {
    const styleExamples = ownerStyleSamples.slice(-12).join('\n- ');
    dynamicSystemPrompt = `You are NOT AI. You ARE owner. Chat EXACTLY like owner.\nMIMIC STYLE:\n- ${styleExamples}\nRules: Be owner, never AI/bot, short, conversational.\nSAFETY: ${config.bankInfo ? `Account: ${config.bankInfo}. Share exactly.` : `Never invent numbers. Say private.`}\nBase: ${config.systemPrompt}`;
  } else {
    dynamicSystemPrompt = `You are owner of WhatsApp. HUMAN, not AI. Never AI/bot. If asked AI: "Lol, which AI? Na me"\nChat Nigerian guy - casual, warm, short. Slang: boss, omo, my guy.\nSAFETY: ${config.bankInfo ? `Account: ${config.bankInfo}` : `Never invent numbers.`}\n${config.systemPrompt}`;
  }

  const modelsToTry = [config.geminiModel || 'gemini-3.6-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-flash-latest'];
  const uniqueModels = [...new Set(modelsToTry)];
  let lastError = null;

  // 1. Gemini chain
  for (const modelName of uniqueModels) {
    if (!config.geminiApiKey) break;
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
      console.log(`🧠 Asking ${modelName} (history: ${geminiHistory.length}, style: ${ownerStyleSamples?.length || 0})`);
      const result = await chat.sendMessage(userMessage);
      const text = result.response.text();
      if (!text) throw new Error('Empty');
      if (!config.bankInfo && /\b\d{10}\b/.test(text) && isPaymentRequest) return "Omo make I double-check my Opay, I go send am for private now now 🙏";
      console.log(`✅ Gemini ${modelName} replied`);
      return text.trim();
    } catch (e) {
      lastError = e;
      const msg = e.message || '';
      console.error(`❌ ${modelName}:`, msg.slice(0,250));
      if (msg.includes('API_KEY') || msg.toLowerCase().includes('api key is invalid')) break;
      if (msg.includes('404') || msg.toLowerCase().includes('not found') || msg.toLowerCase().includes('no longer available') || msg.includes('429') || msg.includes('503') || msg.toLowerCase().includes('high demand') || msg.toLowerCase().includes('quota') || msg.includes('First content')) continue;
      continue;
    }
  }

  // 2. Groq
  if (config.groqApiKey) {
    try {
      const reply = await generateWithGroq(userMessage, history, ownerStyleSamples, dynamicSystemPrompt);
      if (!config.bankInfo && /\b\d{10}\b/.test(reply) && isPaymentRequest) return "Omo make I double-check, I go send am for private 🙏";
      return reply;
    } catch (e) { console.error('❌ Groq failed:', e.message.slice(0,250)); lastError = e; }
  }

  // 3. OpenRouter
  if (config.openrouterApiKey) {
    try {
      const reply = await generateWithOpenRouter(userMessage, history, ownerStyleSamples, dynamicSystemPrompt);
      if (!config.bankInfo && /\b\d{10}\b/.test(reply) && isPaymentRequest) return "Omo make I double-check, I go send am for private 🙏";
      return reply;
    } catch (e) { console.error('❌ OpenRouter failed:', e.message.slice(0,350)); lastError = e; }
  }

  // 4. Together AI
  if (config.togetherApiKey) {
    try {
      const reply = await generateWithTogether(userMessage, history, ownerStyleSamples, dynamicSystemPrompt);
      if (!config.bankInfo && /\b\d{10}\b/.test(reply) && isPaymentRequest) return "Omo make I double-check, I go send am for private 🙏";
      return reply;
    } catch (e) { console.error('❌ Together failed:', e.message.slice(0,250)); lastError = e; }
  }

  // 5. Mistral
  if (config.mistralApiKey) {
    try {
      const reply = await generateWithMistral(userMessage, history, ownerStyleSamples, dynamicSystemPrompt);
      if (!config.bankInfo && /\b\d{10}\b/.test(reply) && isPaymentRequest) return "Omo make I double-check, I go send am for private 🙏";
      return reply;
    } catch (e) { console.error('❌ Mistral failed:', e.message.slice(0,250)); lastError = e; }
  }

  // 6. HuggingFace
  if (config.hfApiKey) {
    try {
      const reply = await generateWithHuggingFace(userMessage, history, ownerStyleSamples, dynamicSystemPrompt);
      if (!config.bankInfo && /\b\d{10}\b/.test(reply) && isPaymentRequest) return "Omo make I double-check, I go send am for private 🙏";
      return reply;
    } catch (e) { console.error('❌ HF failed:', e.message.slice(0,250)); lastError = e; }
  }

  console.error('💥 All AI failed:', lastError?.message?.slice(0,300));
  // Last resort empty history
  if (config.geminiApiKey) {
    try {
      const m = initGemini(uniqueModels[0], dynamicSystemPrompt);
      const chat = m.startChat({ history: [], generationConfig: { maxOutputTokens: 600, temperature: 0.9 } });
      const result = await chat.sendMessage(userMessage);
      const text = result.response.text();
      if (text) return text.trim();
    } catch {}
  }
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
/status - Status + AI chain
/help - Help

AI Chain: Gemini → Groq → OpenRouter → Together → Mistral → HF
Add keys to never run out!
BANK_INFO for real account`;
}
