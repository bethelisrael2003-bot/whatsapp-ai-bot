/**
 * Autonomous Agent - Owner controls bot via self-chat to message others with goals
 * Now with SUPER INTELLIGENT natural language understanding - no /agent needed
 */

import { generateReply } from './ai.js';

// Normalize Nigerian and international numbers to WhatsApp JID format
export function normalizeNumber(num) {
  let n = num.replace(/[^0-9]/g, '');
  if (!n) return null;
  if (n.startsWith('0') && n.length === 11) {
    n = '234' + n.slice(1);
  } else if (n.length === 10 && (n.startsWith('8') || n.startsWith('7') || n.startsWith('9'))) {
    n = '234' + n;
  } else if (n.startsWith('234') && n.length === 13) {
  } else if (n.startsWith('234') && n.length === 14) {
    if (n.length > 13) n = n.slice(0, 13);
  } else if (n.startsWith('0')) {
    n = '234' + n.slice(1);
  }
  if (n.length < 10 || n.length > 15) return null;
  return n;
}

export function toJid(num) {
  const normalized = normalizeNumber(num);
  if (!normalized) return null;
  return `${normalized}@s.whatsapp.net`;
}

// Extract numbers from vCard (WhatsApp contact share)
export function extractNumbersFromVcard(vcard) {
  if (!vcard) return [];
  const numbers = [];
  // waid=2349014347620
  const waidMatches = [...vcard.matchAll(/waid=(\d{10,15})/g)];
  for (const m of waidMatches) {
    const norm = normalizeNumber(m[1]);
    if (norm) numbers.push(norm);
  }
  // TEL;...:+234 901 434 7620 or TEL:+234...
  if (numbers.length === 0) {
    const telMatches = [...vcard.matchAll(/TEL[^:]*:([+\d\s\-\(\)]+)/gi)];
    for (const m of telMatches) {
      const norm = normalizeNumber(m[1]);
      if (norm) numbers.push(norm);
    }
  }
  return [...new Set(numbers)];
}

export function extractNumbersRobust(str) {
  if (!str) return [];
  const numbers = [];
  if (str.includes(',')) {
    const parts = str.split(',').map(s => s.trim()).filter(Boolean);
    for (const p of parts) {
      const n = normalizeNumber(p);
      if (n) numbers.push(n);
    }
    if (numbers.length > 0) return [...new Set(numbers)];
  }
  const spacedRegex = /0[789][01]\d\s*\d{3}\s*\d{4}/g;
  let m;
  const regexFound = [];
  while ((m = spacedRegex.exec(str)) !== null) {
    const norm = normalizeNumber(m[0]);
    if (norm) regexFound.push(norm);
  }
  if (regexFound.length > 1) {
    return [...new Set(regexFound)];
  }
  if (regexFound.length === 1 && str.replace(/[^0-9\s,]/g,'').trim().split(/\s+/).length <= 3) {
    return regexFound;
  }
  const digitsOnly = str.replace(/[^0-9]/g, '');
  if (digitsOnly.length >= 10) {
    let i = 0;
    const chunked = [];
    while (i < digitsOnly.length) {
      if (digitsOnly.slice(i, i + 3) === '234' && digitsOnly.length - i >= 13) {
        const cand = digitsOnly.slice(i, i + 13);
        if (/^234[789][01]\d{7}$/.test(cand)) {
          chunked.push(cand);
          i += 13;
          continue;
        }
      }
      if (digitsOnly[i] === '0' && digitsOnly.length - i >= 11) {
        const cand = digitsOnly.slice(i, i + 11);
        if (/^0[789][01]\d{7}$/.test(cand)) {
          const norm = normalizeNumber(cand);
          if (norm) chunked.push(norm);
          i += 11;
          continue;
        }
      }
      if (/^[789]/.test(digitsOnly[i]) && digitsOnly.length - i >= 10) {
        const cand = digitsOnly.slice(i, i + 10);
        if (/^[789][01]\d{8}$/.test(cand)) {
          const norm = normalizeNumber(cand);
          if (norm) chunked.push(norm);
          i += 10;
          continue;
        }
      }
      i++;
    }
    if (chunked.length > 0) return [...new Set(chunked)];
  }
  const single = normalizeNumber(str);
  if (single) return [single];
  return [];
}

class AgentManager {
  constructor(memory, sock) {
    this.memory = memory;
    this.sock = sock;
    this.tasks = new Map();
    this.recentShared = new Map(); // in-memory fallback
  }

  async saveRecentSharedContacts(ownerJid, numbers) {
    if (!numbers || numbers.length === 0) return;
    const key = `agent:recent:${ownerJid}`;
    const data = { numbers, timestamp: Date.now() };
    this.recentShared.set(ownerJid, data);
    if (this.memory?.isRedis) {
      try {
        await this.memory.redis.set(key, JSON.stringify(data));
        await this.memory.redis.expire(key, 60 * 15); // 15 min expiry
        console.log(`💾 Saved recent shared ${numbers.length} contacts for ${ownerJid}`);
      } catch (e) { console.error('Failed save recent:', e.message); }
    }
  }

  async getRecentSharedContacts(ownerJid) {
    // Check memory first
    const memData = this.recentShared.get(ownerJid);
    if (memData && Date.now() - memData.timestamp < 15 * 60 * 1000) {
      return memData.numbers;
    }
    if (this.memory?.isRedis) {
      try {
        const data = await this.memory.redis.get(`agent:recent:${ownerJid}`);
        if (data) {
          const parsed = typeof data === 'string' ? JSON.parse(data) : data;
          if (Date.now() - parsed.timestamp < 15 * 60 * 1000) {
            return parsed.numbers;
          }
        }
      } catch {}
    }
    return [];
  }

  async createTask(targetJid, goal, ownerJid) {
    const taskKey = `agent:task:${targetJid}`;
    const task = {
      targetJid,
      goal,
      ownerJid,
      status: 'active',
      createdAt: Date.now(),
      steps: 0,
      maxSteps: 20,
      history: [],
      lastMessageAt: Date.now()
    };
    if (this.memory.isRedis) {
      await this.memory.redis.set(taskKey, JSON.stringify(task));
      await this.memory.redis.expire(taskKey, 60 * 60 * 24 * 2);
    }
    this.tasks.set(targetJid, task);
    console.log(`🤖 Agent task created for ${targetJid}: ${goal}`);
    return task;
  }

  async getTask(targetJid) {
    if (this.tasks.has(targetJid)) return this.tasks.get(targetJid);
    if (this.memory.isRedis) {
      const data = await this.memory.redis.get(`agent:task:${targetJid}`);
      if (data) {
        const task = typeof data === 'string' ? JSON.parse(data) : data;
        if (task.status === 'active') {
          this.tasks.set(targetJid, task);
          return task;
        }
      }
    }
    return null;
  }

  async updateTask(targetJid, updates) {
    const task = await this.getTask(targetJid);
    if (!task) return null;
    Object.assign(task, updates, { lastMessageAt: Date.now() });
    if (this.memory.isRedis) {
      await this.memory.redis.set(`agent:task:${targetJid}`, JSON.stringify(task));
    }
    this.tasks.set(targetJid, task);
    return task;
  }

  async completeTask(targetJid, result) {
    const task = await this.getTask(targetJid);
    if (!task) return;
    task.status = 'completed';
    task.result = result;
    task.completedAt = Date.now();
    if (this.memory.isRedis) {
      await this.memory.redis.set(`agent:task:${targetJid}`, JSON.stringify(task));
      await this.memory.redis.expire(`agent:task:${targetJid}`, 60 * 60 * 24 * 7);
    }
    try {
      const report = `✅ *Agent Completed*\n\nTarget: ${targetJid.split('@')[0]}\nGoal: ${task.goal}\nSteps: ${task.steps}\nResult: ${result}`;
      await this.sock.sendMessage(task.ownerJid, { text: report });
      console.log(`✅ Agent completed for ${targetJid}`);
    } catch (e) { console.error('Report failed:', e.message); }
    this.tasks.delete(targetJid);
  }

  async failTask(targetJid, reason) {
    const task = await this.getTask(targetJid);
    if (!task) return;
    task.status = 'failed';
    task.result = reason;
    if (this.memory.isRedis) {
      await this.memory.redis.set(`agent:task:${targetJid}`, JSON.stringify(task));
    }
    try {
      await this.sock.sendMessage(task.ownerJid, { text: `❌ *Agent Failed*\n\nTarget: ${targetJid.split('@')[0]}\nGoal: ${task.goal}\nReason: ${reason}` });
    } catch {}
    this.tasks.delete(targetJid);
  }

  async listActiveTasks() {
    if (this.memory.isRedis && typeof this.memory.redis.keys === 'function') {
      try {
        const keys = await this.memory.redis.keys('agent:task:*');
        const tasks = [];
        for (const key of keys) {
          const data = await this.memory.redis.get(key);
          if (data) {
            const task = typeof data === 'string' ? JSON.parse(data) : data;
            if (task.status === 'active') tasks.push(task);
          }
        }
        return tasks;
      } catch {}
    }
    return Array.from(this.tasks.values()).filter(t => t.status === 'active');
  }

  async isGoalAchieved(goal, conversationHistory) {
    try {
      const { config } = await import('./config.js');
      if (!config.geminiApiKey) return false;
      const { GoogleGenerativeAI } = await import('@google/generative-ai');
      const genAI = new GoogleGenerativeAI(config.geminiApiKey);
      const model = genAI.getGenerativeModel({ model: 'gemini-3.6-flash' });
      const convoText = conversationHistory.slice(-8).map(h => `${h.role}: ${h.content}`).join('\n');
      const prompt = `Goal: ${goal}\n\nConversation:\n${convoText}\n\nHas goal been achieved? Answer only YES or NO and brief reason.`;
      const result = await model.generateContent(prompt);
      const answer = result.response.text().toLowerCase();
      console.log(`🎯 Goal check: ${answer.slice(0,100)}`);
      return answer.includes('yes');
    } catch (e) {
      console.error('Goal check failed:', e.message);
      return false;
    }
  }
}

let agentManager = null;
export async function getAgentManager(memory, sock) {
  if (agentManager) return agentManager;
  agentManager = new AgentManager(memory, sock);
  return agentManager;
}

// INTELLIGENT NATURAL LANGUAGE DETECTION - NO / NEEDED
export async function parseNaturalAgentIntent(text, recentSharedNumbers = []) {
  if (!text) return null;
  const lower = text.toLowerCase().trim();
  
  // Skip if it's clearly not a task (too short, no instruction)
  if (lower.length < 5) return null;
  
  // Keywords that indicate owner wants bot to DO something with contacts
  const actionKeywords = [
    'greet', 'message', 'send', 'tell', 'ask', 'inform', 'broadcast', 'share',
    'remind', 'follow up', 'check', 'contact', 'chat', 'talk to', 'reach out',
    'do the same', 'same thing', 'all of them', 'all contacts', 'these contacts',
    'these numbers', 'those contacts', 'them', 'everyone', 'each', 'individually',
    'ma', 'sir', 'how they are', 'how are they', 'how far', 'update', 'project',
    'payment', 'money', 'greeting', 'hello', 'hi', 'hey'
  ];
  
  const hasActionKeyword = actionKeywords.some(k => lower.includes(k));
  
  // Extract numbers from text
  let numbers = extractNumbersRobust(text);
  
  // If no numbers in text but recent shared contacts exist and message refers to "them"/"all"
  const refersToRecent = lower.includes('them') || lower.includes('all') || lower.includes('same') || lower.includes('these') || lower.includes('those') || lower.includes('everyone') || lower.includes('contacts');
  
  if (numbers.length === 0 && recentSharedNumbers.length > 0 && (hasActionKeyword || refersToRecent)) {
    numbers = recentSharedNumbers;
    console.log(`🧠 Natural intent: Using ${numbers.length} recent shared contacts for task`);
  }
  
  if (numbers.length === 0) return null;
  
  // Must have action keyword OR be clearly a broadcast instruction (contains many numbers + instruction)
  // If text is just numbers without instruction, don't treat as task (user might be just listing)
  const textWithoutNumbers = text.replace(/[0-9,\s\-\+\(\)]+/g, ' ').trim();
  const hasInstruction = textWithoutNumbers.length > 3 && /[a-zA-Z]{2,}/.test(textWithoutNumbers);
  
  if (!hasActionKeyword && !hasInstruction) {
    // If only numbers, maybe user just pasted numbers, not a task yet - store as recent but don't trigger?
    // We will treat as intent only if has instruction OR refers to recent
    if (numbers.length > 0 && textWithoutNumbers.length < 2) {
      return null; // Just numbers, no instruction
    }
  }
  
  // Extract goal: remove numbers from text, clean up
  let goal = textWithoutNumbers;
  // Remove common prefixes like "send to", "message", "greet"
  goal = goal.replace(/^(please\s+)?(send|message|greet|tell|ask|inform|broadcast|contact|chat with)\s+(to\s+)?/i, '').trim();
  goal = goal.replace(/^\d+\s*/, '').trim();
  
  if (!goal || goal.length < 3) {
    goal = text; // Use full text as goal if extraction fails
  }
  
  // Clean goal: if goal still contains lots of numbers, remove them
  goal = goal.replace(/\b\d{10,15}\b/g, '').replace(/[,]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  
  if (goal.length < 3) {
    goal = 'Greet them casually, ask how they are doing, keep chat going. Address female as ma and male as Sir based on how owner addressed them before.';
  }
  
  console.log(`🧠 Natural agent intent detected: ${numbers.length} numbers, goal: ${goal.slice(0,80)}...`);
  return { numbers, goal, isNatural: true };
}

export function parseAgentCommand(text) {
  if (!text) return null;
  const lower = text.toLowerCase().trim();
  const prefixes = ['/agent ', '/sent ', '/send ', '/broadcast ', '/agents ', '/bc '];
  let matchedPrefix = null;
  for (const p of prefixes) {
    if (lower.startsWith(p)) {
      matchedPrefix = p;
      break;
    }
  }
  if (!matchedPrefix) return null;
  let rest = text.slice(matchedPrefix.length).trim();
  if (!rest) return null;
  let numbersPart = '';
  let goal = '';
  if (rest.includes('|')) {
    const parts = rest.split('|');
    numbersPart = parts[0].trim();
    goal = parts.slice(1).join('|').trim().replace(/^Goal:\s*/i, '').trim();
  } else if (rest.includes(' - ')) {
    const idx = rest.indexOf(' - ');
    numbersPart = rest.slice(0, idx).trim();
    goal = rest.slice(idx + 3).trim();
  } else {
    const tokens = rest.split(/\s+/);
    let splitIdx = -1;
    for (let i = 0; i < tokens.length; i++) {
      if (/[a-zA-Z]{2,}/.test(tokens[i])) {
        splitIdx = i;
        break;
      }
    }
    if (splitIdx > 0) {
      numbersPart = tokens.slice(0, splitIdx).join(' ');
      goal = tokens.slice(splitIdx).join(' ').trim();
    } else {
      numbersPart = rest;
      goal = '';
    }
  }
  let numbers = extractNumbersRobust(numbersPart);
  if (numbers.length === 0) {
    numbers = extractNumbersRobust(rest);
    if (numbers.length > 0) {
      const goalCandidate = rest.replace(/[0-9,\s]+/g, ' ').trim();
      if (goalCandidate.length > 3 && /[a-zA-Z]/.test(goalCandidate) && goalCandidate !== goal) {
        if (!goal) goal = goalCandidate;
      }
    }
  }
  if (numbers.length === 0) return null;
  if (!goal) goal = 'Greet them casually, ask how they are doing, keep chat going. Address female as ma and male as Sir based on how owner addressed them before.';
  return { numbers, goal };
}

export function getAgentHelpText() {
  return `🤖 *Agent Mode - SUPER INTELLIGENT*

Just talk naturally in your self-chat, no / needed!

Examples:
• "Greet 0901 434 7620 0811 003 3639, ask how they are, ma for female Sir for male"
• "Message 0805 193 4689 ask about project"
• Share contacts via WhatsApp share, then say "greet them all as ma/Sir"
• "Do same greeting to all contacts I just shared"
• "0901 434 7620, 0811 003 3639 | greet them"

Old style still works:
/agent 0805... | Goal: ...
/send 0805... message

It understands:
• Numbers with spaces: 0901 434 7620
• Contact cards shared
• "them", "all", "same thing" refers to recent contacts
• Gender from your history (ma/Sir)`;
}
