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
    console.log(`🤖 Gemini initializing: ${targetModel}`);
  }
  // Always create new model instance with updated system prompt for style learning
  model = genAI.getGenerativeModel({ 
    model: targetModel,
    systemInstruction: promptToUse
  });
  console.log(`🤖 Gemini ready: ${targetModel} with custom style`);
  return model;
}

export async function generateReply(jid, userMessage, history = [], ownerStyleSamples = null) {
  // Build DYNAMIC system prompt that mimics owner
  let dynamicSystemPrompt = config.systemPrompt;

  // If we have learned how owner chats with THIS specific person, inject it
  if (ownerStyleSamples && ownerStyleSamples.length > 0) {
    const styleExamples = ownerStyleSamples.slice(-12).join('\n- ');
    dynamicSystemPrompt = `
You are NOT an AI. You ARE the owner of this WhatsApp account. You must chat EXACTLY like the owner.

CRITICAL RULES FOR SEAMLESS MIMICRY:
1. You ARE the owner. Never say you are AI, bot, assistant, or Gemini. You are a human.
2. If asked "are you AI?" or "are you bot?" -> deflect like owner would: "Lol which AI? Na me dey here" or "Come on, you know na me" - never admit AI.
3. MIMIC OWNER'S UNIQUE STYLE with THIS person - here is how owner actually chats with them (learn these patterns):
- ${styleExamples}

4. Copy their:
   - Greeting style, slang, pidgin usage
   - Message length (short/long)
   - Emoji usage frequency and type
   - Punctuation style
   - How they say "boss", "omo", "my guy", etc.
   - Their typical responses

5. Keep replies SHORT like WhatsApp - 1-2 lines max usually, unless owner writes long.
6. Be conversational, not formal. Sound exactly like owner would.
7. Remember conversation context.
8. If you don't know something, respond like owner would: "I no sure" or "Make I check" - not AI-like.

Base personality: ${config.systemPrompt}

Now reply as the owner would, using the style examples above. Be seamless.
`;
    console.log(`🎭 Using learned style for ${jid}: ${ownerStyleSamples.length} samples`);
  } else {
    // No owner samples yet - use ghost mode prompt
    dynamicSystemPrompt = `
You are the owner of this WhatsApp account chatting with contacts. You are HUMAN, not AI.

CRITICAL:
- Never reveal you are AI, bot, assistant.
- If asked if you're AI: "Lol, which AI? Na me" or "You dey whine me?"
- Chat like a real Nigerian guy - casual, warm, short WhatsApp style.
- Use natural slang occasionally if appropriate: "boss", "omo", "my guy", "no wahala", "how far"
- Keep replies concise (1-2 sentences), not essay-like.
- Use emojis sparingly and naturally, like a human would.
- Be helpful but sound like owner.

Personality: ${config.systemPrompt}

Reply as human owner, seamless.
`;
  }

  const modelsToTry = [
    config.geminiModel || 'gemini-3.6-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.5-flash',
    'gemini-flash-latest',
    'gemini-2.5-flash'
  ];
  const uniqueModels = [...new Set(modelsToTry)];
  let lastError = null;

  for (const modelName of uniqueModels) {
    try {
      const m = initAI(modelName, dynamicSystemPrompt);

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
          maxOutputTokens: 600,
          temperature: 0.9, // higher for more human-like variation
          topP: 0.95,
        }
      });

      console.log(`🧠 Asking ${modelName} for ${jid} (style: ${ownerStyleSamples?.length || 0} samples): "${userMessage.slice(0,50)}..."`);
      const result = await chat.sendMessage(userMessage);
      const text = result.response.text();

      if (!text) throw new Error('Empty response');
      console.log(`✅ Reply: ${text.slice(0,80)}...`);
      return text.trim();

    } catch (error) {
      lastError = error;
      const msg = error.message || '';
      console.error(`❌ ${modelName} error:`, msg.slice(0,300));
      if (msg.includes('API_KEY') || msg.toLowerCase().includes('api key is invalid')) {
        return "My guy, network dey do me somehow, make I get back to you 🙏";
      }
      if (msg.includes('404') || msg.toLowerCase().includes('not found') || msg.toLowerCase().includes('no longer available')) continue;
      if (msg.includes('429') || error.status === 429) continue;
      continue;
    }
  }

  console.error('💥 All models failed:', lastError?.message);
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
/pause 234... - Pause for contact
/resume 234... - Resume
/resume all - Resume all
/clear 234... - Clear history
/style 234... - Show learned style for contact
/status - Bot status + learned contacts count
/help - This help

Bot now LEARNS your style per contact automatically!
Every message you send teaches it how you chat with that person.

To teach faster: chat normally with people, bot will study you.

*Handoff keywords (contacts):* human, stop bot, #human, agent`;
}
