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
    body: JSON.stringify({ model, messages, max_tokens: 400, temperature: 0.8 })
  });
  if (!res.ok) throw new Error(`${providerName} ${res.status}: ${(await res.text()).slice(0,300)}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || data.choices?.[0]?.text;
  if (!text) throw new Error(`Empty ${providerName}`);
  console.log(`✅ ${providerName} replied`);
  return text.trim();
}

function buildMessages(userMessage, history, ownerStyleSamples, systemPrompt, imagePart = null) {
  // NEW: Transparent assistant - no longer impersonating, no bank info in prompt
  // Style samples are used ONLY for casual tone reference, but filtered for romantic/financial content
  let safeStyle = [];
  if (ownerStyleSamples && ownerStyleSamples.length > 0) {
    // Filter out any style samples that contain financial or romantic language to prevent learning bad patterns
    safeStyle = ownerStyleSamples.filter(s => {
      const lower = s.toLowerCase();
      return !containsFinancialLanguage(lower, true) && !containsRomanticLanguage(lower, true);
    }).slice(-8);
  }
  
  let dynamicPrompt = systemPrompt;
  if (safeStyle.length > 0) {
    const styleExamples = safeStyle.join('\n- ');
    dynamicPrompt += `\n\nCasual tone reference (how owner normally does small talk, but DO NOT copy flirty/romantic tone):\n- ${styleExamples}`;
  }
  
  const msgs = [
    { role: 'system', content: dynamicPrompt },
    ...history.slice(-10).map(h => ({ role: h.role === 'user' ? 'user' : 'assistant', content: h.content.slice(0, 800) })),
  ];
  if (imagePart) msgs.push({ role: 'user', content: [{ type: 'text', text: userMessage }, imagePart] });
  else msgs.push({ role: 'user', content: userMessage });
  return msgs;
}

// ==================== HARD FILTERS & SAFETY CHECKS ====================

// 1. FINANCIAL LANGUAGE - HARD BLOCK
const FINANCIAL_KEYWORDS = [
  'account number', 'acct number', 'account no', 'acct no', 'a/c number',
  'bank account', 'account details', 'bank details', 'account info',
  'opay', 'palmpay', 'moniepoint', 'kuda', 'first bank', 'gtb', 'gtbank', 'access bank', 'uba', 'zenith',
  'send money', 'send me money', 'transfer money', 'make transfer', 'do transfer',
  'send account', 'drop account', 'send aza', 'drop aza', 'send your aza',
  'send funds', 'drop funds', 'send cash', 'drop cash',
  'bank transfer', 'wire transfer', 'money transfer',
  'payment', 'pay me', 'pay you', 'make payment',
  'naira', '₦', 'kobo', 'dollar', 'usd',
  'wallet', 'pos', 'transaction', 'remit', 'remittance'
];

const FINANCIAL_REGEXES = [
  /\b\d{10}\b/, // 10 digit account number
  /\b\d{11}\b.*\b(opay|bank|account)\b/i,
  /\b(send|drop|transfer).{0,20}(money|cash|fund|account|aza|naira|₦)/i,
  /\b(account|aza).{0,10}(number|details|no)\b/i,
  /\b(opay|palmpay|moniepoint|kuda|bank).{0,15}\d{6,}/i,
];

export function containsFinancialLanguage(text, isStyleCheck = false) {
  if (!text) return false;
  const lower = text.toLowerCase();
  
  // Check keywords
  for (const kw of FINANCIAL_KEYWORDS) {
    if (lower.includes(kw)) {
      // For style check, be less aggressive - only block obvious ones
      if (isStyleCheck) {
        // Only block if contains account number patterns or explicit money requests
        if (['account number', 'acct number', 'send money', 'transfer money', 'send account', 'drop account', 'send aza', 'drop aza', 'opay', 'bank account'].some(k => lower.includes(k))) {
          return true;
        }
        continue;
      }
      console.log(`🚫 Financial keyword blocked: "${kw}" in "${text.slice(0,80)}"`);
      return true;
    }
  }
  
  // Check regexes (always for AI output, not for style check unless obvious)
  if (!isStyleCheck) {
    for (const regex of FINANCIAL_REGEXES) {
      if (regex.test(text)) {
        console.log(`🚫 Financial regex blocked: ${regex} in "${text.slice(0,80)}"`);
        return true;
      }
    }
  }
  
  return false;
}

// 2. ROMANTIC/FLIRTY LANGUAGE - HARD BLOCK
const ROMANTIC_EMOJIS = ['🥰', '😍', '💞', '😘', '💋', '💖', '💗', '💓', '💘', '💝', '💟', '❤️‍🔥', '😻', '😽', '🫦', '👄'];
const ROMANTIC_KEYWORDS = [
  'my love', 'my lover', 'my baby', 'my babe', 'my sweetheart', 'my honey', 'my darling', 'my boo',
  'i love you', 'love you so much', 'love u so much', 'luv u', 'ily',
  'miss you so much', 'miss u so much', 'thinking of you', 'can\'t stop thinking',
  'you\'re my everything', 'you are my everything', 'my everything',
  'my heart', 'my world', 'my queen', 'my king',
  'sexy', 'hot babe', 'hot baby', 'fine babe', 'fine girl', 'fine boy',
  'kiss you', 'hug you tight', 'cuddle', 'make love',
  'babe i', 'baby i', 'sweetie', 'cutie', 'boo boo'
];

// Romantic phrases that are intimate - check with word boundaries
const ROMANTIC_REGEXES = [
  /\b(babe|baby|boo|honey|sweetheart|darling)\b.*\b(love|miss|kiss|hug|cuddle)\b/i,
  /\b(i|you).{0,5}\b(my|ur)\b.{0,5}\b(love|heart|everything|world)\b/i,
  /😍|🥰|💞|😘|💋|💖|💘/,
];

export function containsRomanticLanguage(text, isStyleCheck = false) {
  if (!text) return false;
  const lower = text.toLowerCase();
  
  // Check emojis
  for (const emoji of ROMANTIC_EMOJIS) {
    if (text.includes(emoji)) {
      console.log(`🚫 Romantic emoji blocked: ${emoji} in "${text.slice(0,80)}"`);
      return true;
    }
  }
  
  // Check keywords - for style check, be more permissive, only block explicit
  for (const kw of ROMANTIC_KEYWORDS) {
    if (lower.includes(kw)) {
      if (isStyleCheck && !['i love you', 'my love', 'sexy', 'make love'].includes(kw)) {
        continue; // Allow some mild terms in style learning, but filter in output
      }
      console.log(`🚫 Romantic keyword blocked: "${kw}" in "${text.slice(0,80)}"`);
      return true;
    }
  }
  
  // Regex check for AI output
  if (!isStyleCheck) {
    for (const regex of ROMANTIC_REGEXES) {
      if (regex.test(text)) {
        console.log(`🚫 Romantic regex blocked: ${regex} in "${text.slice(0,80)}"`);
        return true;
      }
    }
  }
  
  return false;
}

export function sanitizeRomanticLanguage(text) {
  if (!text) return text;
  let sanitized = text;
  // Remove romantic emojis
  for (const emoji of ROMANTIC_EMOJIS) {
    sanitized = sanitized.split(emoji).join('');
  }
  // Replace romantic phrases with neutral
  sanitized = sanitized.replace(/\b(my love|my baby|my babe|babe|baby|boo|honey|sweetheart)\b/gi, 'there');
  sanitized = sanitized.replace(/😍|🥰|💞|😘|💋|💖|💗|💓|💘|💝/g, '🙂');
  return sanitized.trim();
}

// 3. IDENTITY / DISCLOSURE CHECK
const IDENTITY_QUESTIONS = [
  'are you a bot', 'are you bot', 'are you an ai', 'are you ai', 'are you automated',
  'is this a bot', 'is this bot', 'is this an ai', 'is this ai', 'is this automated',
  'are you real', 'are you really you', 'is this really you', 'is this really bethel',
  'are you bethel', 'who is this', 'who are you really', 'are you human',
  'are you actually bethel', 'is this bethel speaking', 'am i talking to bethel',
  'is this bethel?', 'are you bethel?', 'real bethel', 'actual bethel',
  'bot?', 'automated?', 'ai assistant', 'you a robot'
];

export function isIdentityQuestion(text) {
  if (!text) return false;
  const lower = text.toLowerCase().trim();
  
  // Direct match
  for (const q of IDENTITY_QUESTIONS) {
    if (lower.includes(q)) {
      console.log(`🔍 Identity question detected: "${q}" in "${text.slice(0,80)}"`);
      return true;
    }
  }
  
  // Pattern match: "is this really you" variations
  if (/\b(is|are|am).{0,10}\b(really|actually|truly).{0,10}\b(you|bethel|him)\b/i.test(lower)) return true;
  if (/\b(bot|ai|automated|robot)\b/i.test(lower) && /\b(you|this|are|is)\b/i.test(lower)) return true;
  
  return false;
}

export function getDisclosureResponse() {
  return `Yes, I'm Bethel's WhatsApp assistant handling casual messages on his behalf. For anything important, personal, or serious, I'll make sure Bethel replies directly himself. How can I help with something light in the meantime? 🙂`;
}

// 4. SERIOUS / PERSONAL / EMOTIONAL / IMPORTANT TOPICS - AUTO HANDOFF
const SERIOUS_KEYWORDS = [
  // Emotional distress
  'depressed', 'depression', 'anxiety', 'anxious', 'suicidal', 'suicide', 'kill myself', 'want to die', 'self harm', 'self-harm', 'cutting myself',
  'crying', 'i\'m crying', 'can\'t stop crying', 'heartbroken', 'broken heart',
  'lonely', 'so lonely', 'alone', 'need someone', 'need you', 'i need you',
  'hospital', 'emergency', 'accident', 'sick', 'ill', 'died', 'death', 'funeral', 'passed away', 'lost someone',
  'pregnant', 'pregnancy', 'miscarriage',
  // Relationship serious
  'breakup', 'break up', 'divorce', 'cheated', 'cheating', 'affair', 'fight', 'quarrel serious',
  'i love you', 'i really love you', 'do you love me', // Romantic serious
  // Life important
  'lost my job', 'fired', 'got fired', 'jobless', 'evicted', 'homeless',
  'legal', 'court', 'police', 'arrested', 'lawyer', 'sue', 'lawsuit',
  'contract', 'business deal', 'investment', 'big money', 'important decision',
  // Personal deep
  'my father', 'my mother', 'my family', 'family problem', 'family issue',
  'need advice', 'serious talk', 'can we talk seriously', 'need to talk',
  'confidential', 'private matter', 'personal matter', 'important matter'
];

const SERIOUS_REGEXES = [
  /\b(i need|need).{0,15}\b(you|help|advice|talk)\b.*\b(serious|urgent|important|personal)\b/i,
  /\b(suicide|kill myself|want to die|self harm)\b/i,
  /\b(hospital|emergency|accident|died|death|funeral)\b/i,
  /\b(depressed|depression|anxiety|breakup|divorce)\b/i,
];

export function isSeriousTopic(text, history = []) {
  if (!text) return false;
  const lower = text.toLowerCase();
  
  // Check keywords
  for (const kw of SERIOUS_KEYWORDS) {
    if (lower.includes(kw)) {
      console.log(`⚠️ Serious keyword detected: "${kw}" in "${text.slice(0,80)}" - triggering handoff`);
      return true;
    }
  }
  
  // Check regexes
  for (const regex of SERIOUS_REGEXES) {
    if (regex.test(text)) {
      console.log(`⚠️ Serious regex detected: ${regex} in "${text.slice(0,80)}" - triggering handoff`);
      return true;
    }
  }
  
  // Check history for escalation - if last 2 user messages were emotional, handoff
  if (history && history.length >= 2) {
    const recentUserMsgs = history.filter(h => h.role === 'user').slice(-2).map(h => h.content.toLowerCase()).join(' ');
    let emotionalCount = 0;
    for (const kw of ['depressed', 'sad', 'crying', 'lonely', 'need you', 'help me', 'serious', 'important']) {
      if (recentUserMsgs.includes(kw)) emotionalCount++;
    }
    if (emotionalCount >= 2) {
      console.log(`⚠️ Emotional escalation in history - triggering handoff`);
      return true;
    }
  }
  
  return false;
}

export function getHandoffResponse(contactName = 'there') {
  return `Thanks for sharing that — this sounds important and personal. I'm Bethel's assistant handling light messages, so let me have Bethel get back to you directly on this. He'll reply himself shortly. 🙏`;
}

export function getSafeFallbackResponse() {
  const fallbacks = [
    `Got it — let me have Bethel reply directly on that one. He'll get back to you shortly. 🙏`,
    `Thanks for letting me know. This sounds like something Bethel should handle himself — I'll make sure he sees it and replies directly.`,
    `Appreciate you sharing. Let me flag this for Bethel to respond to personally — he'll be in touch soon.`,
  ];
  return fallbacks[Math.floor(Math.random() * fallbacks.length)];
}

export function getNigerianTimeContext() {
  try {
    const now = new Date();
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
      greetingInstruction = `It's ${hour12}:${minute} AM WAT - very late night/early morning. Use neutral "Hello" not time-specific greeting.`;
    } else if (hour24 >= 5 && hour24 < 12) {
      period = 'morning (5am - 11:59am)';
      greeting = 'Good morning';
      greetingInstruction = `It's morning ${hour12}:${minute} AM WAT. Use "Good morning".`;
    } else if (hour24 >= 12 && hour24 < 16) {
      period = 'afternoon (12pm - 3:59pm)';
      greeting = 'Good afternoon';
      greetingInstruction = `It's afternoon ${hour12}:${minute} PM WAT. Use "Good afternoon".`;
    } else if (hour24 >= 16 && hour24 < 19) {
      period = 'evening (4pm - 6:59pm)';
      greeting = 'Good evening';
      greetingInstruction = `It's evening ${hour12}:${minute} PM WAT. Use "Good evening".`;
    } else {
      period = 'night (7pm - 11:59pm)';
      greeting = 'Good evening';
      greetingInstruction = `It's night ${hour12}:${minute} PM WAT. Use "Good evening".`;
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
  const lowerMsg = (userMessage || '').toLowerCase();
  
  // ===== MANDATORY CHECKS BEFORE AI =====
  
  // 1. Identity question -> must disclose truthfully
  if (isIdentityQuestion(userMessage)) {
    console.log(`🔍 IDENTITY QUESTION from ${jid}: "${userMessage.slice(0,80)}" - DISCLOSING`);
    return getDisclosureResponse();
  }
  
  // 2. Serious/personal/emotional/important -> auto handoff, don't reply as bot
  if (isSeriousTopic(userMessage, history)) {
    console.log(`⚠️ SERIOUS TOPIC from ${jid}: "${userMessage.slice(0,80)}" - HANDOFF REQUIRED`);
    // Return special flag so index.js can handle handoff notification
    return `__HANDOFF__${getHandoffResponse()}`;
  }
  
  // 3. Financial request from user -> handoff (don't handle money)
  if (containsFinancialLanguage(userMessage)) {
    console.log(`💰 Financial request from ${jid}: "${userMessage.slice(0,80)}" - HANDOFF, no financial handling`);
    return `__HANDOFF__${getHandoffResponse()} __REASON__: Financial topic`;
  }

  const isNewContact = !ownerStyleSamples || ownerStyleSamples.length === 0;
  let dynamicSystemPrompt = '';

  const timeContext = getNigerianTimeContext();
  console.log(`⏰ Nigerian time: ${timeContext.formatted}`);

  // ===== NEW TRANSPARENT ASSISTANT PROMPTS =====
  const BASE_RULES = `
You are Bethel's WhatsApp assistant, NOT Bethel himself. You handle ONLY casual, low-stakes small talk on his behalf.

STRICT RULES - NEVER BREAK:
1. TRANSPARENCY: You are an assistant. If asked if you are bot/AI/automated/really Bethel, you MUST say: "Yes, I'm Bethel's assistant handling light messages — Bethel will reply directly for anything important"
2. NO FINANCIAL LANGUAGE EVER: Never mention money, accounts, bank, Opay, transfer, send money, drop, payment, naira, ₦, wallet, funds, cash. If user asks about money/accounts, you must handoff: say you will have Bethel reply directly. Never share or ask for account numbers.
3. NO ROMANTIC/FLIRTY TONE: Never use romantic emojis 🥰😍💞😘💋💖💗💓💘 or intimate phrases like "my love", "babe", "baby", "sweetheart", "honey", "I love you", "my heart". Keep tone friendly, neutral, platonic. Use only simple emojis like 🙂🙏😊
4. CASUAL SMALL TALK ONLY: You handle greetings, light banter, "how are you", weather, general check-ins, scheduling logistics like "when are you free". Nothing personal, emotional, serious, or important.
5. AUTO-HANDOFF: If conversation becomes personal, emotional, serious, important, or user shares something deep (sadness, health, family issues, relationship problems, job loss, emergency), you MUST stop and say you will have Bethel reply directly.
6. NEVER PRETEND TO BE BETHEL FOR MEANINGFUL CONVERSATIONS: For low-stakes casual chat, you can be friendly as his assistant, but never claim to be Bethel discussing something important. Make it clear you are assistant for light stuff.
7. Keep replies short, 1-2 lines, friendly, Nigerian casual but professional, no flirty tone.

Current Nigerian time: ${timeContext.full} - Use "${timeContext.greeting}" appropriately.
`;

  if (isNewContact) {
    dynamicSystemPrompt = `
${BASE_RULES}

You are handling a NEW contact - first time chatting.

Your job:
- Be friendly, warm, helpful for casual small talk
- Greeting: Use "${timeContext.greeting}" based on time above
- Introduce as assistant: "Hi, I'm helping Bethel with messages..."
- Keep it light, professional, low-stakes
- If they ask something important/personal -> handoff immediately
- Never mention money/accounts
- Never flirty/romantic

Example: "${timeContext.greeting}! I'm helping Bethel with messages — he's a bit busy but I can help with light stuff. How are you doing today? 🙂"

Time: ${timeContext.formatted}
`;
    console.log(`🆕 NEW CONTACT ${jid} - transparent assistant mode - ${timeContext.greeting}`);
  } else {
    dynamicSystemPrompt = `
${BASE_RULES}

You are handling someone Bethel knows, but you are STILL his assistant, not Bethel himself.

Casual tone reference (how owner does small talk, but filtered - no romantic/financial):
${ownerStyleSamples ? ownerStyleSamples.filter(s => !containsFinancialLanguage(s, true) && !containsRomanticLanguage(s, true)).slice(-6).join('\n- ') : 'Friendly casual Nigerian small talk'}

Rules for known contacts:
- You can be more casual and familiar, but STILL as assistant, not pretending to be Bethel for serious matters
- Use light banter, greetings, check-ins that match general friendly tone
- But: No financial language, no romantic/flirty tone even if past messages had it - filter it out
- If topic gets personal/emotional/serious -> handoff to Bethel directly
- Be transparent: For casual chat you can say "Bethel asked me to help with messages" not "I am Bethel"
- Keep it low-stakes: greetings, "how far", "how you dey", light jokes, scheduling
- Short, 1-2 lines, no essay

Time: ${timeContext.formatted} - Use "${timeContext.greeting}" appropriately.

You are assistant handling casual small talk, not Bethel having meaningful conversation.
`;
    console.log(`👤 KNOWN CONTACT ${jid} - transparent assistant mode, ${ownerStyleSamples?.length || 0} samples filtered - ${timeContext.greeting}`);
  }

  if (mediaInfo) {
    if (mediaInfo.type === 'image') {
      dynamicSystemPrompt += `\nUSER SENT IMAGE${mediaInfo.caption ? ` caption: "${mediaInfo.caption}"` : ''}. React casually and lightly as assistant.`;
      if (!userMessage || userMessage === '[Image]' || userMessage.startsWith('[Image')) userMessage = mediaInfo.caption || "Thanks for sharing this image 🙂";
    } else if (mediaInfo.type === 'sticker') {
      dynamicSystemPrompt += `\nUSER SENT STICKER. React lightly with humor, friendly, no flirty tone.`;
      if (!userMessage || userMessage === '[Sticker]') userMessage = "Nice sticker 😊";
    } else if (mediaInfo.type === 'video') {
      if (mediaInfo.transcription) {
        dynamicSystemPrompt += `\nUSER SENT VIDEO with audio: "${mediaInfo.transcription}"${mediaInfo.caption ? ` caption: "${mediaInfo.caption}"` : ''}. Respond casually to content, but if serious/personal -> handoff.`;
        if (!userMessage || userMessage.startsWith('[Video')) userMessage = mediaInfo.transcription;
      } else {
        dynamicSystemPrompt += `\nUSER SENT VIDEO${mediaInfo.caption ? ` caption: "${mediaInfo.caption}"` : ''}. React lightly.`;
        userMessage = mediaInfo.caption || userMessage || "See this video";
      }
    } else if (mediaInfo.type === 'voice' || mediaInfo.type === 'audio') {
      if (mediaInfo.transcription) {
        dynamicSystemPrompt += `\nUSER SENT VOICE NOTE: "${mediaInfo.transcription}". Respond casually to content, but check if serious -> handoff.`;
        if (!userMessage || userMessage === '[Voice note]' || userMessage === '[Audio]') userMessage = mediaInfo.transcription;
      } else {
        dynamicSystemPrompt += `\nUSER SENT VOICE NOTE but transcription failed. Acknowledge lightly and ask them to type if important.`;
        userMessage = userMessage || "Voice note received";
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
  let generatedReply = null;

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
        const result = await m.generateContent({ contents: [...geminiHistory.map(h => ({ role: h.role, parts: h.parts })), { role: 'user', parts: [{ text: userMessage }, imagePartForGemini] }], generationConfig: { maxOutputTokens: 400, temperature: 0.6, topP: 0.9 } });
        const text = result.response.text();
        if (!text) throw new Error('Empty');
        generatedReply = text.trim();
        break;
      } else {
        const chat = m.startChat({ history: geminiHistory, generationConfig: { maxOutputTokens: 400, temperature: 0.6, topP: 0.9 } });
        console.log(`🧠 Asking ${modelName} for ${jid} (${isNewContact ? 'NEW' : 'KNOWN'}, history: ${geminiHistory.length})`);
        const result = await chat.sendMessage(userMessage);
        const text = result.response.text();
        if (!text) throw new Error('Empty');
        generatedReply = text.trim();
        break;
      }
    } catch (e) {
      lastError = e;
      const msg = e.message || '';
      console.error(`❌ ${modelName}:`, msg.slice(0,300));
      if (msg.includes('API_KEY') || msg.toLowerCase().includes('api key is invalid')) break;
      continue;
    }
  }

  // Fallback chain if Gemini failed
  if (!generatedReply) {
    const fallbacks = [
      { key: config.groqApiKey, base: 'https://api.groq.com/openai/v1', model: config.groqModel, name: 'Groq' },
      { key: config.cerebrasApiKey, base: 'https://api.cerebras.ai/v1', model: config.cerebrasModel, name: 'Cerebras' },
      { key: config.githubToken, base: 'https://models.github.ai/inference', model: config.githubModel, name: 'GitHub-Models' },
      { key: config.openrouterApiKey, base: 'https://openrouter.ai/api/v1', model: config.openrouterModel, name: 'OpenRouter' },
    ];
    
    for (const fb of fallbacks) {
      if (!fb.key || generatedReply) continue;
      try {
        const r = await callOpenAICompatible({ 
          apiKey: fb.key, 
          baseUrl: fb.base, 
          model: fb.model, 
          messages: buildMessages(userMessage, history, ownerStyleSamples, dynamicSystemPrompt, imagePartForOpenAI), 
          providerName: fb.name,
          extraHeaders: fb.name === 'OpenRouter' ? { 'HTTP-Referer': 'https://github.com/bethelisrael2003-bot/whatsapp-ai-bot', 'X-Title': 'WhatsApp Bot' } : {}
        });
        generatedReply = r;
        break;
      } catch (e) {
        console.error(`❌ ${fb.name}:`, e.message.slice(0,250));
        lastError = e;
      }
    }
  }

  if (!generatedReply) {
    console.error('💥 All AI failed:', lastError?.message?.slice(0,300));
    return "Hello! I'm helping Bethel with messages — he's a bit busy now. I'll make sure he gets back to you shortly for anything important. 🙂";
  }

  // ===== POST-GENERATION HARD FILTERS =====
  
  // 1. Check if generated reply contains financial language -> BLOCK
  if (containsFinancialLanguage(generatedReply)) {
    console.log(`🚫 BLOCKED AI reply with financial language from ${jid}: "${generatedReply.slice(0,100)}" -> Handoff`);
    return `__HANDOFF__${getHandoffResponse()} __REASON__: AI generated financial language blocked`;
  }
  
  // 2. Check if generated reply contains romantic/flirty language -> SANITIZE or BLOCK
  if (containsRomanticLanguage(generatedReply)) {
    console.log(`🚫 Romantic language detected in AI reply from ${jid}: "${generatedReply.slice(0,100)}" -> Sanitizing`);
    const sanitized = sanitizeRomanticLanguage(generatedReply);
    // If still contains romantic after sanitization, or is heavily romantic, block
    if (containsRomanticLanguage(sanitized)) {
      console.log(`🚫 Still romantic after sanitize, blocking -> safe fallback`);
      return `Hello! How are you doing today? 🙂 I'm helping Bethel with light messages — he'll reply directly for anything important.`;
    }
    generatedReply = sanitized;
  }
  
  // 3. Check if reply itself is trying to claim to be Bethel for serious matter -> ensure transparency
  const lowerReply = generatedReply.toLowerCase();
  if ((lowerReply.includes('i am bethel') || lowerReply.includes("i'm bethel") || lowerReply.includes('na me be bethel')) && 
      (lowerReply.includes('love') || lowerReply.includes('miss you') || isSeriousTopic(lowerReply))) {
    console.log(`⚠️ AI trying to impersonate Bethel for emotional content -> Handoff`);
    return `__HANDOFF__${getHandoffResponse()}`;
  }
  
  // 4. Final safety: ensure reply is casual small talk, not too personal
  if (generatedReply.length > 400) {
    // Truncate long replies to keep casual
    generatedReply = generatedReply.slice(0, 350) + '...';
  }

  console.log(`✅ Final filtered reply for ${jid}: "${generatedReply.slice(0,100)}..."`);
  return generatedReply;
}

export function isHandoffRequest(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  const triggers = ['human', 'real person', 'talk to person', 'stop bot', 'pause bot', '#human', '#stop', '#pause', 'agent', 'representative', 'talk to human', 'human please', 'i want human', 'need human', 'person please', 'talk to bethel', 'need bethel', 'want bethel'];
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
    const rest = text.slice(text.toLowerCase().indexOf(' ', 1)).trim();
    if (!rest) return { action: 'send', target: '', message: '' };
    const tokens = rest.split(/\s+/);
    let splitIdx = -1;
    for (let i = 0; i < tokens.length; i++) {
      if (/[a-zA-Z]{2,}/.test(tokens[i]) && !/^[0-9]+$/.test(tokens[i])) {
        splitIdx = i;
        break;
      }
    }
    let target, message;
    if (splitIdx > 0) {
      target = tokens.slice(0, splitIdx).join(' ');
      message = tokens.slice(splitIdx).join(' ');
    } else {
      target = tokens[0] || '';
      message = tokens.slice(1).join(' ');
    }
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
  return `🤖 *Bethel's WhatsApp Assistant - Transparent Mode*

This assistant now handles ONLY casual small talk on your behalf, with safety filters:

✅ *What it does:*
• Greets people, light banter, "how are you"
• Scheduling logistics: "when are you free"
• Tells people you're busy and you'll reply directly for important stuff
• Always discloses it's an assistant if asked

🚫 *Hard blocks (never sends):*
• Any financial language: money, accounts, bank, Opay, transfer, etc.
• Romantic/flirty tone or emojis 🥰😍💞😘💋
• Personal/emotional/serious topics -> auto handoff to you

⚠️ *Auto-handoff triggers:*
• Emotional distress, health, family, relationship serious talk
• Anyone asks "are you bot / really you" -> discloses truthfully
• Financial requests -> flags you
• Important decisions, legal, etc.

🔧 *Controls:*
/pause 234... - Pause for contact
/resume 234... - Resume
/resume all - Resume all
/clear 234... - Clear history
/clear sessions - Fix Bad MAC
/status - Status
/help - This help

Assistant is transparent, casual small talk only, never pretends to be you for meaningful conversations.
`;
}
