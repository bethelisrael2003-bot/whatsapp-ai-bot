import { initAuthCreds, BufferJSON, useMultiFileAuthState } from '@whiskeysockets/baileys';
import { Redis } from '@upstash/redis';
import fs from 'fs';

/**
 * Custom Baileys auth adapter that stores session in Upstash Redis
 * Survives Render restarts - no rescan needed
 */
export async function useRedisAuthState(redis) {
  const CREDS_KEY = 'baileys:creds';
  const KEYS_PREFIX = 'baileys:keys';

  // Load creds
  let creds;
  try {
    const stored = await redis.get(CREDS_KEY);
    if (stored) {
      const parsed = typeof stored === 'string' ? JSON.parse(stored, BufferJSON.reviver) : stored;
      // Upstash may already parse JSON, handle both
      if (parsed && typeof stored !== 'string') {
        // If Upstash auto-parsed, we need to reviver manually for Buffers
        // Re-stringify then re-parse with reviver to be safe
        creds = JSON.parse(JSON.stringify(parsed), BufferJSON.reviver);
        // If still missing Buffer handling, fallback
        if (!creds) creds = parsed;
      } else {
        creds = parsed;
      }
    }
  } catch (e) {
    console.warn('Failed to load creds from Redis, initializing new:', e.message);
  }
  if (!creds) {
    creds = initAuthCreds();
  }

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          // Batch get for performance
          const promises = ids.map(async (id) => {
            const key = `${KEYS_PREFIX}:${type}:${id}`;
            try {
              const val = await redis.get(key);
              if (val) {
                const parsed = typeof val === 'string' ? JSON.parse(val, BufferJSON.reviver) : val;
                data[id] = parsed;
              }
            } catch (e) {
              // ignore missing keys
            }
          });
          await Promise.all(promises);
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const type in data) {
            for (const id in data[type]) {
              const key = `${KEYS_PREFIX}:${type}:${id}`;
              const value = data[type][id];
              if (value) {
                const json = JSON.stringify(value, BufferJSON.replacer);
                tasks.push(redis.set(key, json));
              } else {
                tasks.push(redis.del(key));
              }
            }
          }
          if (tasks.length) await Promise.all(tasks);
        }
      }
    },
    saveCreds: async () => {
      const json = JSON.stringify(creds, BufferJSON.replacer);
      await redis.set(CREDS_KEY, json);
    },
    clearState: async () => {
      try {
        await redis.del(CREDS_KEY);
        // Try to clean keys - Upstash supports keys()
        if (typeof redis.keys === 'function') {
          try {
            const allKeys = await redis.keys(`${KEYS_PREFIX}:*`);
            if (allKeys && allKeys.length) {
              // Upstash keys may return array, delete in chunks
              const chunkSize = 100;
              for (let i = 0; i < allKeys.length; i += chunkSize) {
                const chunk = allKeys.slice(i, i + chunkSize);
                await Promise.all(chunk.map(k => redis.del(k)));
              }
            }
          } catch {}
        }
      } catch (e) {
        console.warn('clearState error:', e.message);
      }
    },
    clearSessions: async () => {
      // Clear only session keys that cause Bad MAC, keep creds
      try {
        console.log('🧹 Clearing Baileys session keys to fix Bad MAC...');
        if (typeof redis.keys === 'function') {
          const sessionKeys = await redis.keys(`${KEYS_PREFIX}:session:*`);
          const senderKeys = await redis.keys(`${KEYS_PREFIX}:sender-key:*`);
          const allBadKeys = [...(sessionKeys || []), ...(senderKeys || [])];
          console.log(`🧹 Found ${allBadKeys.length} session/sender keys to clear`);
          if (allBadKeys.length > 0) {
            const chunkSize = 50;
            let cleared = 0;
            for (let i = 0; i < allBadKeys.length; i += chunkSize) {
              const chunk = allBadKeys.slice(i, i + chunkSize);
              await Promise.all(chunk.map(k => redis.del(k)));
              cleared += chunk.length;
            }
            console.log(`✅ Cleared ${cleared} session keys - Bad MAC should be fixed, sessions will re-establish`);
            return cleared;
          }
        }
        return 0;
      } catch (e) {
        console.warn('clearSessions error:', e.message);
        return 0;
      }
    }
  };
}

/**
 * Creates auth state - tries Redis first, falls back to file system for local dev
 */
export async function createAuthState() {
  const hasRedis = process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN;

  if (hasRedis) {
    console.log('🔗 Using Upstash Redis for auth persistence (survives restarts)');
    const redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    const auth = await useRedisAuthState(redis);
    return { ...auth, redis, isRedis: true };
  } else {
    console.log('📁 Using local file auth (auth_info folder) - will NOT survive Render restarts!');
    console.log('   Set UPSTASH_REDIS_REST_URL and TOKEN to fix this.');
    if (!fs.existsSync('./auth_info')) fs.mkdirSync('./auth_info', { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
    return { state, saveCreds, redis: null, isRedis: false, clearState: async () => {
      fs.rmSync('./auth_info', { recursive: true, force: true });
    }};
  }
}
