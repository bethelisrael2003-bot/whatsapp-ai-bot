/**
 * Autonomous Agent - Owner controls bot via self-chat to message others with goals
 * Example: /agent 2348012345678 | Goal: Ask for payment and get confirmation they will send to Opay
 */

import { generateReply } from './ai.js';

class AgentManager {
  constructor(memory, sock) {
    this.memory = memory;
    this.sock = sock;
    this.tasks = new Map(); // in-memory cache, persisted in Redis
  }

  async createTask(targetJid, goal, ownerJid) {
    const taskKey = `agent:task:${targetJid}`;
    const task = {
      targetJid,
      goal,
      ownerJid, // where to report back
      status: 'active',
      createdAt: Date.now(),
      steps: 0,
      maxSteps: 20,
      history: [],
      lastMessageAt: Date.now()
    };

    if (this.memory.isRedis) {
      await this.memory.redis.set(taskKey, JSON.stringify(task));
      await this.memory.redis.expire(taskKey, 60 * 60 * 24 * 2); // 2 days expiry
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
      await this.memory.redis.expire(`agent:task:${targetJid}`, 60 * 60 * 24 * 7); // keep 7 days for report
    }
    
    // Report to owner
    try {
      const report = `✅ *Agent Task Completed*\n\nTarget: ${targetJid.split('@')[0]}\nGoal: ${task.goal}\nSteps: ${task.steps}\nResult: ${result}\n\nLast chat:\n${task.history.slice(-3).map(h => `${h.role}: ${h.content.slice(0,100)}`).join('\n')}`;
      await this.sock.sendMessage(task.ownerJid, { text: report });
      console.log(`✅ Agent task completed for ${targetJid}, reported to ${task.ownerJid}`);
    } catch (e) {
      console.error('Failed to report agent completion:', e.message);
    }
    
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
      await this.sock.sendMessage(task.ownerJid, { text: `❌ *Agent Task Failed*\n\nTarget: ${targetJid.split('@')[0]}\nGoal: ${task.goal}\nReason: ${reason}` });
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

  // Check if AI thinks goal is achieved
  async isGoalAchieved(goal, conversationHistory) {
    // Simple heuristic + AI check
    // For now, use AI to judge if goal is achieved
    try {
      const { config } = await import('./config.js');
      if (!config.geminiApiKey) return false;
      
      const { GoogleGenerativeAI } = await import('@google/generative-ai');
      const genAI = new GoogleGenerativeAI(config.geminiApiKey);
      const model = genAI.getGenerativeModel({ model: 'gemini-3.6-flash' });
      
      const convoText = conversationHistory.slice(-8).map(h => `${h.role}: ${h.content}`).join('\n');
      const prompt = `Goal: ${goal}\n\nConversation:\n${convoText}\n\nHas the goal been achieved? Answer only YES or NO and brief reason.`;
      
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
  // Formats:
  // /agent 2348012345678 | Goal: message and get payment
  // /agent 2348012345678,2348023456789 | Goal: broadcast hello
  // /agent 2348012345678 - Ask them about money
  if (!text) return null;
  const lower = text.toLowerCase().trim();
  if (!lower.startsWith('/agent ')) return null;

  // Remove /agent prefix
  let rest = text.slice(7).trim();
  
  // Split by | or - to get numbers and goal
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
    // No separator, first token is number, rest is goal
    const tokens = rest.split(/\s+/);
    numbersPart = tokens[0];
    goal = tokens.slice(1).join(' ').trim();
  }

  // Extract numbers (comma separated)
  const numbers = numbersPart.split(',').map(n => n.replace(/[^0-9]/g, '')).filter(n => n.length >= 10);

  if (numbers.length === 0) return null;
  if (!goal) goal = 'Have a friendly conversation and keep it going';

  return { numbers, goal };
}
