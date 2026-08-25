import { Redis } from '@upstash/redis';
import fs from 'fs';
import path from 'path';

/**
 * Conversation memory + rate limiting + handoff state
 * Uses Upstash Redis if available, otherwise local JSON files (for local dev)
 */

class MemoryStore {
  constructor(redis) {
    this.redis = redis;
    this.isRedis = !!redis;
    this.localDir = './memory_store';
    if (!this.isRedis && !fs.existsSync(this.localDir)) {
      fs.mkdirSync(this.localDir, { recursive: true });
    }
    this.maxHistory = parseInt(process.env.MAX_HISTORY || '20', 10);
  }

  _key(jid, suffix) {
    // Sanitize JID for filename if needed
    return `${suffix}:${jid}`;
  }

  // ---------- HISTORY ----------
  async getHistory(jid) {
    const key = this._key(jid, 'chat:history');
    try {
      if (this.isRedis) {
        const data = await this.redis.get(key);
        if (!data) return [];
        return typeof data === 'string' ? JSON.parse(data) : data;
      } else {
        const file = path.join(this.localDir, `${jid.replace(/[^a-zA-Z0-9]/g, '_')}_history.json`);
        if (!fs.existsSync(file)) return [];
        return JSON.parse(fs.readFileSync(file, 'utf-8'));
      }
    } catch (e) {
      console.warn(`getHistory error for ${jid}:`, e.message);
      return [];
    }
  }

  async addMessage(jid, role, content) {
    if (!content) return;
    const key = this._key(jid, 'chat:history');
    try {
      let history = await this.getHistory(jid);
      history.push({ role, content, timestamp: Date.now() });
      // Trim to last N
      if (history.length > this.maxHistory) {
        history = history.slice(-this.maxHistory);
      }
      if (this.isRedis) {
        await this.redis.set(key, JSON.stringify(history));
        // Optional: expire after 30 days to keep DB clean
        await this.redis.expire(key, 60 * 60 * 24 * 30);
      } else {
        const file = path.join(this.localDir, `${jid.replace(/[^a-zA-Z0-9]/g, '_')}_history.json`);
        fs.writeFileSync(file, JSON.stringify(history, null, 2));
      }
    } catch (e) {
      console.warn(`addMessage error for ${jid}:`, e.message);
    }
  }

  async clearHistory(jid) {
    const key = this._key(jid, 'chat:history');
    try {
      if (this.isRedis) {
        await this.redis.del(key);
      } else {
        const file = path.join(this.localDir, `${jid.replace(/[^a-zA-Z0-9]/g, '_')}_history.json`);
        if (fs.existsSync(file)) fs.unlinkSync(file);
      }
    } catch {}
  }

  // ---------- RATE LIMIT ----------
  async isRateLimited(jid) {
    const maxPerHour = parseInt(process.env.MAX_PER_HOUR || '30', 10);
    const key = this._key(jid, 'ratelimit');
    try {
      if (this.isRedis) {
        const count = await this.redis.incr(key);
        if (count === 1) {
          await this.redis.expire(key, 3600); // 1 hour window
        }
        return count > maxPerHour;
      } else {
        // Simple local rate limit using files with timestamps
        const file = path.join(this.localDir, `${jid.replace(/[^a-zA-Z0-9]/g, '_')}_ratelimit.json`);
        let data = { count: 0, resetAt: Date.now() + 3600000 };
        if (fs.existsSync(file)) {
          try {
            data = JSON.parse(fs.readFileSync(file, 'utf-8'));
            if (Date.now() > data.resetAt) {
              data = { count: 0, resetAt: Date.now() + 3600000 };
            }
          } catch {}
        }
        data.count++;
        fs.writeFileSync(file, JSON.stringify(data));
        return data.count > maxPerHour;
      }
    } catch {
      return false; // fail open
    }
  }

  async getRateLimitCount(jid) {
    const key = this._key(jid, 'ratelimit');
    try {
      if (this.isRedis) {
        const count = await this.redis.get(key);
        return count ? parseInt(count, 10) : 0;
      }
    } catch {}
    return 0;
  }

  // ---------- HANDOFF ----------
  async isHandoff(jid) {
    const key = this._key(jid, 'handoff');
    try {
      if (this.isRedis) {
        const val = await this.redis.get(key);
        return !!val;
      } else {
        const file = path.join(this.localDir, `${jid.replace(/[^a-zA-Z0-9]/g, '_')}_handoff.json`);
        if (!fs.existsSync(file)) return false;
        const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
        if (Date.now() > data.expiresAt) {
          fs.unlinkSync(file);
          return false;
        }
        return true;
      }
    } catch {
      return false;
    }
  }

  async setHandoff(jid, minutes = 120) {
    const key = this._key(jid, 'handoff');
    const ttlSeconds = minutes * 60;
    try {
      if (this.isRedis) {
        await this.redis.set(key, '1', { ex: ttlSeconds });
      } else {
        const file = path.join(this.localDir, `${jid.replace(/[^a-zA-Z0-9]/g, '_')}_handoff.json`);
        fs.writeFileSync(file, JSON.stringify({ expiresAt: Date.now() + ttlSeconds * 1000 }));
      }
      console.log(`⏸️ Handoff set for ${jid} for ${minutes} minutes`);
    } catch (e) {
      console.warn('setHandoff error:', e.message);
    }
  }

  async clearHandoff(jid) {
    const key = this._key(jid, 'handoff');
    try {
      if (this.isRedis) {
        await this.redis.del(key);
      } else {
        const file = path.join(this.localDir, `${jid.replace(/[^a-zA-Z0-9]/g, '_')}_handoff.json`);
        if (fs.existsSync(file)) fs.unlinkSync(file);
      }
      console.log(`▶️ Handoff cleared for ${jid}`);
    } catch {}
  }

  async clearAllHandoffs() {
    if (this.isRedis && typeof this.redis.keys === 'function') {
      try {
        const keys = await this.redis.keys('handoff:*');
        if (keys.length) await Promise.all(keys.map(k => this.redis.del(k)));
      } catch {}
    }
  }
}

// Singleton factory
let memoryInstance = null;
export async function getMemoryStore() {
  if (memoryInstance) return memoryInstance;

  const hasRedis = process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN;
  let redis = null;
  if (hasRedis) {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    console.log('🧠 Using Upstash Redis for conversation memory');
  } else {
    console.log('🧠 Using local file memory (will NOT survive Render restarts)');
  }
  memoryInstance = new MemoryStore(redis);
  return memoryInstance;
}
