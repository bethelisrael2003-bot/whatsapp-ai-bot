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
  // +234... (14 with + removed, but we already removed +) -> if starts with 234 and 14 digits, trim?
  else if (n.startsWith('234') && n.length === 14) {
    // Sometimes extra digit, keep as is? Try to keep last 13
    if (n.length > 13) n = n.slice(0, 13);
  }
  // If still starts with 0, remove 0 and add 234
  else if (n.startsWith('0')) {
    n = '234' + n.slice(1);
  }
  
  // Validate: Nigerian numbers should be 13 digits starting with 234
  // International: allow 10-15 digits
  if (n.length < 10 || n.length > 15) return null;
  
  return n;
}

export function toJid(num) {
  const normalized = normalizeNumber(num);
  if (!normalized) return null;
  return `${normalized}@s.whatsapp.net`;
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
  if (!lower.startsWith('/agent ')) return null;

  let rest = text.slice(7).trim();
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
    numbersPart = tokens[0];
    goal = tokens.slice(1).join(' ').trim();
  }

  // Extract numbers - support comma separated and spaces like "0805 193 4689"
  // First, try to find all Nigerian-like numbers in the string
  const rawNumbers = numbersPart.split(',').map(s => s.trim()).filter(Boolean);
  const numbers = [];
  
  for (const raw of rawNumbers) {
    // Remove all non-digits, then normalize
    const normalized = normalizeNumber(raw);
    if (normalized) numbers.push(normalized);
  }

  if (numbers.length === 0) return null;
  if (!goal) goal = 'Have a friendly conversation and keep it going';

  return { numbers, goal };
}
