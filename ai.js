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

async function callOpenAICompatible({ apiKey, baseUrl, model, messages, providerName, extraHeaders = {} }) {
  if (!apiKey) throw new Error(`No ${providerName} key`);
  console.log(`🧠 Trying ${providerName} ${model}...`);
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify({ model, messages, max_tokens: 400, temperature: 0.9 })
  });
  if (!res.ok) throw new Error(`${providerName} ${res.status}: ${(await res.text()).slice(0,300)}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || data.choices?.[0]?.text;
  if (!text) throw new Error(`Empty ${providerName}`);
  console.log(`✅ ${providerName} replied`);
  return text.trim();
}

function buildMessages(userMessage, history, ownerStyleSamples, systemPrompt, imagePart = null) {
  let dynamicPrompt = systemPrompt;
  if (ownerStyleSamples && ownerStyleSamples.length > 0) {
    const styleExamples = ownerStyleSamples.slice(-12).join('\n- ');
    dynamicPrompt = `You are owner of WhatsApp, not AI. Mimic style:\n- ${styleExamples}\nBe owner, never AI/bot, short 1-2 lines, Nigerian pidgin casual. Bank: ${config.bankInfo || 'private, never invent'}. Base: ${systemPrompt}`;
  }
  const msgs = [
    { role: 'system', content: dynamicPrompt },
    ...history.slice(-10).map(h => ({ role: h.role === 'user' ? 'user' : 'assistant', content: h.content.slice(0, 800) })),
  ];
  if (imagePart) msgs.push({ role: 'user', content: [{ type: 'text', text: userMessage }, imagePart] });
  else msgs.push({ role: 'user', content: userMessage });
  return msgs;
}

async function generateWithGroq(userMessage, history, style, systemPrompt, imagePart) {
  if (imagePart) throw new Error('Groq vision skip');
  return callOpenAICompatible({ apiKey: config.groqApiKey, baseUrl: 'https://api.groq.com/openai/v1', model: config.groqModel, messages: buildMessages(userMessage, history, style, systemPrompt), providerName: 'Groq' });
}
async function generateWithOpenRouter(userMessage, history, style, systemPrompt, imagePart) {
  return callOpenAICompatible({ apiKey: config.openrouterApiKey, baseUrl: 'https://openrouter.ai/api/v1', model: config.openrouterModel, messages: buildMessages(userMessage, history, style, systemPrompt, imagePart), providerName: 'OpenRouter', extraHeaders: { 'HTTP-Referer': 'https://github.com/bethelisrael2003-bot/whatsapp-ai-bot', 'X-Title': 'WhatsApp Bot' } });
}
async function generateWithTogether(userMessage, history, style, systemPrompt) {
  return callOpenAICompatible({ apiKey: config.togetherApiKey, baseUrl: 'https://api.together.xyz/v1', model: config.togetherModel, messages: buildMessages(userMessage, history, style, systemPrompt), providerName: 'Together' });
}
async function generateWithCerebras(userMessage, history, style, systemPrompt) {
  return callOpenAICompatible({ apiKey: config.cerebrasApiKey, baseUrl: 'https://api.cerebras.ai/v1', model: config.cerebrasModel, messages: buildMessages(userMessage, history, style, systemPrompt), providerName: 'Cerebras' });
}
async function generateWithGitHubModels(userMessage, history, style, systemPrompt) {
  return callOpenAICompatible({ apiKey: config.githubToken, baseUrl: 'https://models.github.ai/inference', model: config.githubModel, messages: buildMessages(userMessage, history, style, systemPrompt), providerName: 'GitHub-Models' });
}
async function generateWithMistral(userMessage, history, style, systemPrompt, imagePart) {
  return callOpenAICompatible({ apiKey: config.mistralApiKey, baseUrl: 'https://api.mistral.ai/v1', model: config.mistralModel, messages: buildMessages(userMessage, history, style, systemPrompt, imagePart), providerName: 'Mistral' });
}
async function generateWithHuggingFace(userMessage, history, style, systemPrompt) {
  if (!config.hfApiKey) throw new Error('No HF');
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
  if (!text) throw new Error('Empty HF');
  console.log(`✅ HF replied`);
  return text.trim();
}

export function getNigerianTimeContext() {
  try {
    const now = new Date();
    // Get Nigerian time (Africa/Lagos = WAT UTC+1, no DST)
    const options = { timeZone: 'Africa/Lagos', hour12: true, hour: 'numeric', minute: '2-digit', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    const full = now.toLocaleString('en-NG', options);
    const hour24 = parseInt(now.toLocaleString('en-US', { timeZone: 'Africa/Lagos', hour: 'numeric', hour12: false }));
    const hour12 = now.toLocaleString('en-US', { timeZone: 'Africa/Lagos', hour: 'numeric', hour12: true });
    const minute = now.toLocaleString('en-US', { timeZone: 'Africa/Lagos', minute: '2-digit' });
    
    let period = '';
    let greeting = '';
    let greetingInstruction = '';
    
    if (hour24 >= 0 && hour24 < 5) {
      period = 'late night / early morning (12am - 4:59am)';
      greeting = 'Hello';
      greetingInstruction = `It's ${hour12}:${minute} AM WAT - very late night/early morning. DO NOT say "Good evening" or "Good morning" - it's awkward at 3am. Use neutral "Hello" or "Hi" or "Hope you're sleeping well" or no time greeting at all. Example: "Hello, hope you dey fine" NOT "Good evening" at 3am.`;
    } else if (hour24 >= 5 && hour24 < 12) {
      period = 'morning (5am - 11:59am)';
      greeting = 'Good morning';
      greetingInstruction = `It's morning ${hour12}:${minute} AM WAT. Use "Good morning" greeting.`;
    } else if (hour24 >= 12 && hour24 < 16) {
      period = 'afternoon (12pm - 3:59pm)';
      greeting = 'Good afternoon';
      greetingInstruction = `It's afternoon ${hour12}:${minute} PM WAT. Use "Good afternoon" greeting.`;
    } else if (hour24 >= 16 && hour24 < 19) {
      period = 'evening (4pm - 6:59pm)';
      greeting = 'Good evening';
      greetingInstruction = `It's evening ${hour12}:${minute} PM WAT. Use "Good evening" greeting.`;
    } else {
      period = 'night (7pm - 11:59pm)';
      greeting = 'Good evening';
      greetingInstruction = `It's night ${hour12}:${minute} PM WAT. Use "Good evening" (not Good night unless ending chat).`;
    }
    
    return {
      full,
      hour24,
      hour12: `${hour12}:${minute}`,
      period,
      greeting,
      greetingInstruction,
      formatted: `Current Nigerian time: ${full} (Africa/Lagos WAT). Period: ${period}. Appropriate greeting: ${greeting}. ${greetingInstruction}`
    };
  } catch (e) {
    console.error('Time context error:', e.message);
    return {
      full: new Date().toISOString(),
      hour24: new Date().getHours(),
      period: 'unknown',
      greeting: 'Hello',
      greetingInstruction: 'Use neutral Hello greeting',
      formatted: `Current time: ${new Date().toLocaleString()} - Use neutral greeting`
    };
  }
}

export async function generateReply(jid, userMessage, history = [], ownerStyleSamples = null, mediaInfo = null) {
  const lowerMsg = userMessage.toLowerCase();
  const paymentKeywords = ['account number', 'acct number', 'a/c number', 'opay', 'bank name', 'send me your account', 'your account', 'account details'];
  const isPaymentRequest = paymentKeywords.some(k => lowerMsg.includes(k));

  const isNewContact = !ownerStyleSamples || ownerStyleSamples.length === 0;
  let dynamicSystemPrompt = '';

  // Nigerian time awareness
  const timeContext = getNigerianTimeContext();
  console.log(`⏰ Nigerian time: ${timeContext.formatted}`);

  if (isNewContact) {
    // NEW NUMBER: Professional, neutral, keep chat warm until owner returns
    dynamicSystemPrompt = `
You are handling WhatsApp for Bethel Israel. This is a NEW contact - you have never chatted with them before, so you don't know owner's unique style with them yet.

⏰ TIME AWARENESS - CRITICAL:
${timeContext.formatted}
You MUST use time-appropriate greeting based on Nigerian time above. At 3am, NEVER say "Good evening" - say "Hello" instead. Follow greetingInstruction exactly.

YOUR JOB FOR NEW CONTACTS:
1. Be PROFESSIONAL, NEUTRAL, WARM, and HELPFUL - not overly casual or pidgin-heavy
2. You are the owner, but keep it neutral: Use time-appropriate greeting from above - e.g. "${timeContext.greeting}, how can I help?" - use "${timeContext.greeting}" not wrong time greeting
3. Never say you are AI/bot. You are human owner.
4. Keep conversation going helpfully, but don't make promises or share sensitive info
5. If they ask for account/bank: ${config.bankInfo ? `Share: ${config.bankInfo}` : `Say: "Let me confirm and send it privately shortly" - NEVER invent numbers`}
6. If they ask something you don't know: "Let me check and get back to you shortly"
7. Keep it professional until owner returns to give perspective
8. Remember: This is first impression - be respectful, concise, helpful
9. Use minimal emojis, professional tone
10. TIME: ${timeContext.greetingInstruction}

Base: ${config.systemPrompt}

You are handling new contact professionally and neutrally until owner returns. Nigerian time now: ${timeContext.full}
`;
    console.log(`🆕 NEW CONTACT ${jid} - using professional neutral mode - ${timeContext.greeting} (${timeContext.period})`);
  } else {
    // KNOWN CONTACT: Mimic owner's unique style with THIS person exactly
    const styleExamples = ownerStyleSamples.slice(-15).join('\n- ');
    dynamicSystemPrompt = `
You are NOT AI. You ARE Bethel Israel, owner of this WhatsApp. You are chatting with someone you KNOW WELL.

⏰ TIME AWARENESS - CRITICAL:
${timeContext.formatted}
You MUST use time-appropriate greeting. At 3am Nigerian time, NEVER say "Good evening" - it's 3am! Use "Hello" or no time greeting. Follow greetingInstruction exactly. Owner would never say "Good evening" at 3am.

CRITICAL - MIMIC OWNER'S UNIQUE STYLE WITH THIS SPECIFIC PERSON:
Owner chats DIFFERENTLY with different people. For THIS person, owner chats like:
- ${styleExamples}

You must:
1. You ARE owner. Never say AI/bot/assistant.
2. If asked "are you AI?": deflect like owner: "Lol which AI? Na me dey here" - never admit AI.
3. Copy EXACTLY how owner chats with THIS person:
   - Their slang, pidgin, greeting style
   - Message length, emoji usage, punctuation
   - How formal/casual they are with THIS person
   - Inside jokes, typical responses
4. This is someone owner knows - be personal, warm, in owner's unique voice for them
5. Keep WhatsApp style - usually 1-2 lines, not essay
6. Remember context from history
7. Be seamless - they should think it's owner
8. TIME: Use "${timeContext.greeting}" or neutral Hello based on ${timeContext.period}. ${timeContext.greetingInstruction}

SAFETY: ${config.bankInfo ? `Account: ${config.bankInfo}. Share exactly when asked.` : `Never invent account numbers. Say private.`}

Base: ${config.systemPrompt}

Current Nigerian time: ${timeContext.full} - Use appropriate greeting "${timeContext.greeting}" for this time, NOT wrong time.

Reply as owner would with THIS specific person, using their unique style examples above. Be 100% seamless and time-aware.
`;
    console.log(`🎭 KNOWN CONTACT ${jid} - using learned style: ${ownerStyleSamples.length} samples - ${timeContext.greeting} (${timeContext.period})`);
  }

  if (mediaInfo) {
    if (mediaInfo.type === 'image') {
      dynamicSystemPrompt += `\nUSER SENT IMAGE${mediaInfo.caption ? ` caption: "${mediaInfo.caption}"` : ''}. React naturally in ${isNewContact ? 'professional neutral' : 'owner unique'} style.`;
      if (!userMessage || userMessage === '[Image]' || userMessage.startsWith('[Image')) userMessage = mediaInfo.caption || (isNewContact ? "Thanks for sharing this image" : "Wetin you think about this image?");
    } else if (mediaInfo.type === 'sticker') {
      dynamicSystemPrompt += `\nUSER SENT STICKER. React ${isNewContact ? 'professionally with slight humor' : 'like owner would - matching their sticker style'}.`;
      if (!userMessage || userMessage === '[Sticker]') userMessage = isNewContact ? "Nice sticker, thanks 😊" : "Haha nice sticker 😂";
    } else if (mediaInfo.type === 'video') {
      if (mediaInfo.transcription) {
        dynamicSystemPrompt += `\nUSER SENT VIDEO with audio transcribed as: "${mediaInfo.transcription}"${mediaInfo.caption ? ` and caption: "${mediaInfo.caption}"` : ''}. The transcription is what they SAID in the video. Respond naturally to what they said, in ${isNewContact ? 'professional neutral' : 'owner unique'} style. Don't mention transcription, just respond to content.`;
        if (!userMessage || userMessage.startsWith('[Video')) userMessage = mediaInfo.transcription;
      } else {
        dynamicSystemPrompt += `\nUSER SENT VIDEO${mediaInfo.caption ? ` caption: "${mediaInfo.caption}"` : ''}. React naturally, ask about video if needed.`;
        userMessage = mediaInfo.caption || userMessage || "See this video";
      }
    } else if (mediaInfo.type === 'voice' || mediaInfo.type === 'audio') {
      if (mediaInfo.transcription) {
        dynamicSystemPrompt += `\nUSER SENT VOICE NOTE transcribed as: "${mediaInfo.transcription}". This is what they SAID. Respond directly to what they said, as if you heard it. Be natural, don't say "I transcribed your voice note" - just reply to the content like owner would. In ${isNewContact ? 'professional neutral' : 'owner unique'} style.`;
        // userMessage already set to transcription in index.js, but ensure
        if (!userMessage || userMessage === '[Voice note]' || userMessage === '[Audio]') userMessage = mediaInfo.transcription;
      } else {
        dynamicSystemPrompt += `\nUSER SENT VOICE NOTE but transcription failed. Acknowledge warmly ${isNewContact ? 'professionally' : 'like owner would'}: "Got your voice note" and ask them to type if important, or respond based on context. Don't just say "[Voice note]".`;
        userMessage = userMessage || "Voice note received - transcription failed, but user sent voice";
      }
    }
  }

  let imagePartForOpenAI = null;
  let imagePartForGemini = null;
  if (mediaInfo && mediaInfo.base64) {
    imagePartForOpenAI = { type: 'image_url', image_url: { url: `data:${mediaInfo.mimeType};base64,${mediaInfo.base64}` } };
    imagePartForGemini = { inlineData: { data: mediaInfo.base64, mimeType: mediaInfo.mimeType } };
  }

  const modelsToTry = [config.geminiModel || 'gemini-3.6-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-flash-latest'];
  const uniqueModels = [...new Set(modelsToTry)];
  let lastError = null;

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
      if (imagePartForGemini && mediaInfo?.type === 'image') {
        console.log(`🧠 Asking ${modelName} with IMAGE for ${jid} (${isNewContact ? 'NEW' : 'KNOWN'})`);
        const result = await m.generateContent({ contents: [...geminiHistory.map(h => ({ role: h.role, parts: h.parts })), { role: 'user', parts: [{ text: userMessage }, imagePartForGemini] }], generationConfig: { maxOutputTokens: 600, temperature: isNewContact ? 0.7 : 0.9, topP: 0.95 } });
        const text = result.response.text();
        if (!text) throw new Error('Empty');
        if (!config.bankInfo && /\b\d{10}\b/.test(text) && isPaymentRequest) return isNewContact ? "Let me confirm my Opay details and send it privately shortly 🙏" : "Omo make I double-check, I go send am for private now now 🙏";
        console.log(`✅ Gemini ${modelName} (vision) replied`);
        return text.trim();
      } else {
        const chat = m.startChat({ history: geminiHistory, generationConfig: { maxOutputTokens: 600, temperature: isNewContact ? 0.7 : 0.9, topP: 0.95 } });
        console.log(`🧠 Asking ${modelName} for ${jid} (${isNewContact ? 'NEW' : 'KNOWN'}, history: ${geminiHistory.length}, style: ${ownerStyleSamples?.length || 0})`);
        const result = await chat.sendMessage(userMessage);
        const text = result.response.text();
        if (!text) throw new Error('Empty');
        if (!config.bankInfo && /\b\d{10}\b/.test(text) && isPaymentRequest) return isNewContact ? "Let me confirm and send it privately shortly 🙏" : "Omo make I double-check, I go send am for private now now 🙏";
        console.log(`✅ Gemini ${modelName} replied`);
        return text.trim();
      }
    } catch (e) {
      lastError = e;
      const msg = e.message || '';
      console.error(`❌ ${modelName}:`, msg.slice(0,300));
      if (msg.includes('API_KEY') || msg.toLowerCase().includes('api key is invalid')) break;
      if (msg.includes('404') || msg.toLowerCase().includes('not found') || msg.toLowerCase().includes('no longer available') || msg.includes('429') || msg.includes('503') || msg.toLowerCase().includes('high demand') || msg.toLowerCase().includes('quota') || msg.includes('First content')) continue;
      continue;
    }
  }

  if (config.groqApiKey && !imagePartForOpenAI) {
    try { const r = await callOpenAICompatible({ apiKey: config.groqApiKey, baseUrl: 'https://api.groq.com/openai/v1', model: config.groqModel, messages: buildMessages(userMessage, history, ownerStyleSamples, dynamicSystemPrompt), providerName: 'Groq' }); if (!config.bankInfo && /\b\d{10}\b/.test(r) && isPaymentRequest) return isNewContact ? "Let me confirm and send privately 🙏" : "Omo make I double-check, I go send am for private 🙏"; return r; } catch (e) { console.error('❌ Groq:', e.message.slice(0,250)); lastError = e; }
  }
  if (config.cerebrasApiKey) {
    try { const r = await callOpenAICompatible({ apiKey: config.cerebrasApiKey, baseUrl: 'https://api.cerebras.ai/v1', model: config.cerebrasModel, messages: buildMessages(userMessage, history, ownerStyleSamples, dynamicSystemPrompt), providerName: 'Cerebras' }); if (!config.bankInfo && /\b\d{10}\b/.test(r) && isPaymentRequest) return isNewContact ? "Let me confirm and send privately 🙏" : "Omo make I double-check, I go send am for private 🙏"; return r; } catch (e) { console.error('❌ Cerebras:', e.message.slice(0,250)); lastError = e; }
  }
  if (config.githubToken) {
    try { const r = await callOpenAICompatible({ apiKey: config.githubToken, baseUrl: 'https://models.github.ai/inference', model: config.githubModel, messages: buildMessages(userMessage, history, ownerStyleSamples, dynamicSystemPrompt), providerName: 'GitHub-Models' }); if (!config.bankInfo && /\b\d{10}\b/.test(r) && isPaymentRequest) return isNewContact ? "Let me confirm and send privately 🙏" : "Omo make I double-check, I go send am for private 🙏"; return r; } catch (e) { console.error('❌ GitHub Models:', e.message.slice(0,350)); lastError = e; }
  }
  if (config.openrouterApiKey) {
    try { const r = await callOpenAICompatible({ apiKey: config.openrouterApiKey, baseUrl: 'https://openrouter.ai/api/v1', model: config.openrouterModel, messages: buildMessages(userMessage, history, ownerStyleSamples, dynamicSystemPrompt, imagePartForOpenAI), providerName: 'OpenRouter', extraHeaders: { 'HTTP-Referer': 'https://github.com/bethelisrael2003-bot/whatsapp-ai-bot', 'X-Title': 'WhatsApp Bot' } }); if (!config.bankInfo && /\b\d{10}\b/.test(r) && isPaymentRequest) return isNewContact ? "Let me confirm and send privately 🙏" : "Omo make I double-check, I go send am for private 🙏"; return r; } catch (e) { console.error('❌ OpenRouter:', e.message.slice(0,350)); lastError = e; }
  }
  if (config.togetherApiKey) {
    try { const r = await callOpenAICompatible({ apiKey: config.togetherApiKey, baseUrl: 'https://api.together.xyz/v1', model: config.togetherModel, messages: buildMessages(userMessage, history, ownerStyleSamples, dynamicSystemPrompt), providerName: 'Together' }); if (!config.bankInfo && /\b\d{10}\b/.test(r) && isPaymentRequest) return isNewContact ? "Let me confirm and send privately 🙏" : "Omo make I double-check, I go send am for private 🙏"; return r; } catch (e) { console.error('❌ Together:', e.message.slice(0,250)); lastError = e; }
  }
  if (config.mistralApiKey) {
    try { const r = await callOpenAICompatible({ apiKey: config.mistralApiKey, baseUrl: 'https://api.mistral.ai/v1', model: config.mistralModel, messages: buildMessages(userMessage, history, ownerStyleSamples, dynamicSystemPrompt, imagePartForOpenAI), providerName: 'Mistral' }); if (!config.bankInfo && /\b\d{10}\b/.test(r) && isPaymentRequest) return isNewContact ? "Let me confirm and send privately 🙏" : "Omo make I double-check, I go send am for private 🙏"; return r; } catch (e) { console.error('❌ Mistral:', e.message.slice(0,250)); lastError = e; }
  }
  if (config.hfApiKey) {
    try {
      const prompt = `${dynamicSystemPrompt}\n\n${history.slice(-5).map(h => `${h.role}: ${h.content}`).join('\n')}\nuser: ${userMessage}\nassistant:`;
      console.log(`🧠 Trying HuggingFace ${config.hfModel}...`);
      const res = await fetch(`https://api-inference.huggingface.co/models/${config.hfModel}`, { method: 'POST', headers: { 'Authorization': `Bearer ${config.hfApiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ inputs: prompt, parameters: { max_new_tokens: 300, temperature: 0.9 } }) });
      if (!res.ok) throw new Error(`HF ${res.status}: ${(await res.text()).slice(0,200)}`);
      const data = await res.json();
      const text = Array.isArray(data) ? data[0]?.generated_text?.split('assistant:').pop() : data.generated_text?.split('assistant:').pop();
      if (!text) throw new Error('Empty HF');
      console.log(`✅ HF replied`);
      if (!config.bankInfo && /\b\d{10}\b/.test(text) && isPaymentRequest) return isNewContact ? "Let me confirm and send privately 🙏" : "Omo make I double-check, I go send am for private 🙏";
      return text.trim();
    } catch (e) { console.error('❌ HF:', e.message.slice(0,250)); lastError = e; }
  }

  console.error('💥 All AI failed:', lastError?.message?.slice(0,300));
  return isNewContact ? "Good evening, thanks for reaching out. Let me check and get back to you shortly 🙏" : "Network dey worry small, I go reply you now now 🙏";
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
    if (target === 'sessions' || target === 'session') return { action: 'clearSessions' };
    return { action: 'clear', target: target.replace(/[^0-9]/g, '') };
  }
  if (lower === '/clear-sessions' || lower === '/clearsessions' || lower === '/fix-bad-mac') {
    return { action: 'clearSessions' };
  }
  if (lower.startsWith('/style ')) {
    const target = text.split(' ')[1]?.replace(/[^0-9]/g, '');
    return { action: 'style', target };
  }
  if (lower.startsWith('/send ') || lower.startsWith('/sent ')) {
    // Support: /send 0901 434 7620 0811 003 3639 Hello everyone
    // Find where numbers end and message starts (first word with letters)
    const rest = text.slice(text.toLowerCase().indexOf(' ', 1)).trim(); // after /send
    if (!rest) return { action: 'send', target: '', message: '' };
    const tokens = rest.split(/\s+/);
    let splitIdx = -1;
    for (let i = 0; i < tokens.length; i++) {
      if (/[a-zA-Z]{2,}/.test(tokens[i]) && !/^[0-9]+$/.test(tokens[i])) {
        // If token contains letters and is not purely numbers, it's start of message
        // But check if it's part of number like "0901" - pure digits, skip
        // Also need to ensure remaining tokens after have letters (not just number groups)
        splitIdx = i;
        break;
      }
    }
    let target, message;
    if (splitIdx > 0) {
      target = tokens.slice(0, splitIdx).join(' ');
      message = tokens.slice(splitIdx).join(' ');
    } else {
      // Fallback: old behavior - first token is target, rest is message
      // For backward compat with single number
      target = tokens[0] || '';
      message = tokens.slice(1).join(' ');
    }
    // If message contains |, this is actually agent command, let agent parser handle it
    // Return null so agent parser gets chance (handleMessage checks agent first)
    if (message.includes('|') || target.includes('|') || rest.includes('|')) {
      return null;
    }
    return { action: 'send', target, message };
  }
  if (lower === '/status' || lower === '/stats') return { action: 'status' };
  if (lower === '/help') return { action: 'help' };
  if (lower === '/resume all') return { action: 'resumeAll' };
  return null;
}

export function getOwnerHelpText() {
  return `🤖 *Owner Commands - SUPER INTELLIGENT MODE*

🧠 *No slash needed! Just talk naturally in self-chat:*
• "Greet 0901 434 7620 0811 003 3639, ask how they are, ma for female Sir for male"
• "Message 0805 193 4689 ask about project"
• Share contacts via WhatsApp share button, then say "greet them all"
• "Do same greeting to all contacts I just shared"
• "0901 434 7620, 0811 003 3639 | greet them"

💬 *Old style still works:*
/send 234... message - Direct send (supports multiple)
/agent 0805... | Goal: ... - Agent with goal
/broadcast 0901... 0811... | Goal: ...

🔧 *Controls:*
/pause 234... - Pause bot for contact
/resume 234... - Resume
/resume all - Resume all
/clear 234... - Clear history
/clear sessions - Fix Bad MAC errors (Failed to decrypt)
/style 234... - Show learned style
/status - Status + recent contacts
/help - This help

✨ *Intelligence:*
• Understands numbers with spaces: 0901 434 7620
• Understands WhatsApp contact cards
• "them", "all", "same thing" = uses recent shared contacts
• Detects gender from YOUR history (how you called them ma/Sir)
• Auto-detects intent - no need to say /agent
• Voice notes + Videos transcribed via Groq Whisper
• Nigerian time aware (no Good evening at 3am)
• Keep-alive 24/7 (no sleep)

AI Chain: Gemini → Groq → Cerebras → GitHub → OpenRouter → Together → Mistral → HF
Media: Images, Stickers, Voice, Video, Contacts, Emoji ✅

🛠️ Fix Bad MAC: /clear sessions or visit /clear-sessions`;
}
}
