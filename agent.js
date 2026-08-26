/**
 * Autonomous Agent - Owner controls bot via self-chat to message others with goals
 */

import { generateReply } from './ai.js';

// Normalize Nigerian and international numbers to WhatsApp JID format
export function normalizeNumber(num) {
  let n = num.replace(/[^0-9]/g, '');
  if (!n) return null;
  
  // Nigerian numbers: 0805... (11 digits starting with 0) -> 234805...
  if (n.startsWith('0') && n.length === 11) {
    n = '234' + n.slice(1);
  }
  // 805... (10 digits) -> 234805...
  else if (n.length === 10 && (n.startsWith('8') || n.startsWith('7') || n.startsWith('9'))) {
    n = '234' + n;
  }
  // 234... already (13 digits) - keep
  else if (n.startsWith('234') && n.length === 13) {
    // keep
  }
  else if (n.startsWith('234') && n.length === 14) {
    if (n.length > 13) n = n.slice(0, 13);
  }
  else if (n.startsWith('0')) {
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

export function extractNumbersRobust(str) {
  if (!str) return [];
  const numbers = [];
  
  // Method 1: If commas present, split by comma first (each part may have spaces like "0901 434 7620")
  if (str.includes(',')) {
    const parts = str.split(',').map(s => s.trim()).filter(Boolean);
    for (const p of parts) {
      const n = normalizeNumber(p);
      if (n) numbers.push(n);
    }
    if (numbers.length > 0) return [...new Set(numbers)];
  }
  
  // Method 2: Regex for spaced Nigerian numbers: 0901 434 7620, 0803 123 4567 etc
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
    // Single number like "0901 434 7620" with only that number
    return regexFound;
  }
  
  // Method 3: Digits-only chunking - handles "0901 434 7620 0811 003 3639 ..." without commas
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

export function parseAgentCommand(text) {
  if (!text) return null;
  const lower = text.toLowerCase().trim();
  
  // Support /agent, /sent (common typo), /send, /broadcast
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
    // No delimiter - try to detect where numbers end and goal starts by looking for letters
    // For "0901 434 7620 0811 003 3639 greet them..."
    // Find first word with letters
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
      // Only numbers, no goal yet
      numbersPart = rest;
      goal = '';
    }
  }

  let numbers = extractNumbersRobust(numbersPart);
  
  // If numbersPart didn't yield numbers but rest is all numbers concatenated, try whole rest
  if (numbers.length === 0) {
    numbers = extractNumbersRobust(rest);
    if (numbers.length > 0) {
      // Try to extract goal from rest after removing number patterns
      const goalCandidate = rest.replace(/[0-9,\s]+/g, ' ').trim();
      if (goalCandidate.length > 3 && /[a-zA-Z]/.test(goalCandidate) && goalCandidate !== goal) {
        // If original goal empty, use this
        if (!goal) goal = goalCandidate;
      }
    }
  }

  if (numbers.length === 0) return null;
  if (!goal) goal = 'Greet them casually, ask how they are doing, keep chat going. Address female as ma and male as Sir based on how owner addressed them before.';

  return { numbers, goal };
}

export function getAgentHelpText() {
  return `🤖 *Agent Mode Help*

/agent 0805 193 4689 | Goal: Ask about project
/agent 0901 434 7620, 0811 003 3639 | Goal: greet and ask how they are
/sent 0901 434 7620 0811 003 3639 | greet them (spaces ok, commas ok)
/send 0805... message - direct send

Supports:
• 0805 193 4689 (with spaces)
• 09014347620,08110033639 (comma separated)
• 0901 434 7620 0811 003 3639 (space separated)

Goal tips:
• "greet and ask how they are, address female as ma and male as Sir based on previous chat"
• Bot will use your history to know gender (how you called them before)`;
}
