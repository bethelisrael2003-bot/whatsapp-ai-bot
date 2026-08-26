import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import http from 'http';
import { config, validateConfig } from './config.js';
import { createAuthState } from './auth.js';
import { getMemoryStore } from './memory.js';
import { generateReply, isHandoffRequest, parseOwnerCommand, getOwnerHelpText, getNigerianTimeContext } from './ai.js';
import { extractOwnerStyleFromExport } from './import.js';
import { getAgentManager, parseAgentCommand, parseNaturalAgentIntent, extractNumbersFromVcard, extractNumbersRobust } from './agent.js';

// Suppress noisy Bad MAC stack traces - keep logs clean, only show summary
const originalConsoleError = console.error;
let badMacCount = 0;
let lastBadMacLog = 0;
console.error = (...args) => {
  const msg = args.join(' ');
  if (msg.includes('Bad MAC') || msg.includes('Failed to decrypt message with any known session')) {
    badMacCount++;
    const now = Date.now();
    // Only log every 10 seconds to avoid spam
    if (now - lastBadMacLog > 10000) {
      console.log(`⚠️ Bad MAC x${badMacCount} - old corrupted sessions (will auto-clear on next restart). These are old queued messages that can't be decrypted, not new messages. New messages will work after session clear.`);
      lastBadMacLog = now;
      badMacCount = 0;
    }
    return;
  }
  if (msg.includes('Session error:Error: Bad MAC')) {
    return; // Suppress stack trace
  }
  if (msg.includes('at Object.verifyMAC') || msg.includes('at SessionCipher.doDecryptWhisperMessage') || msg.includes('at async') && msg.includes('session_cipher.js')) {
    // Suppress stack traces for Bad MAC
    if (msg.includes('Bad MAC') || badMacCount > 0) return;
  }
  originalConsoleError(...args);
};

const server = http.createServer(async (req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime(), bot: global.botStatus || 'starting', timestamp: new Date().toISOString(), instanceId: global.instanceId || 'unknown' }));
  } else if (req.url === '/clear-sessions' && (req.method === 'GET' || req.method === 'POST')) {
    // Clear Bad MAC sessions - fixes decryption errors
    try {
      const mem = await getMemoryStore();
      // Need auth redis - create temp auth to get clearSessions
      const { createAuthState } = await import('./auth.js');
      const authState = await createAuthState();
      let cleared = 0;
      if (authState.clearSessions) {
        cleared = await authState.clearSessions();
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: `Cleared ${cleared} session keys to fix Bad MAC. Bot will re-establish sessions on next messages.`, cleared }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
  } else if (req.url === '/import' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Import Old Chats + Agent Control</title><style>body{font-family:system-ui;padding:20px;max-width:700px;margin:auto;background:#f5f5f5} .card{background:white;padding:20px;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.1);margin-bottom:20px} textarea{width:100%;height:200px;padding:12px;border:1px solid #ddd;border-radius:8px;font-family:monospace;font-size:13px} input,button{padding:12px;border-radius:8px;border:1px solid #ddd;margin:5px 0;width:100%} button{background:#25D366;color:white;border:none;font-weight:bold;cursor:pointer} button:hover{background:#128C7E} .info{background:#e8f5e9;padding:12px;border-radius:8px;margin:10px 0;font-size:14px} .agent{background:#fff3e0;padding:12px;border-radius:8px;margin:10px 0}</style></head><body>
<h2>📚 Import Old Chats + 🤖 Agent Control</h2>
<div class="card"><h3>Import Old Chats</h3><div class="info">Export: WhatsApp → Chat → 3 dots → More → Export → Without media → Copy .txt</div><label>Number (234...):</label><input id="jid" placeholder="2348012345678" /><label>Your name in export:</label><input id="ownerName" placeholder="You" value="You" /><label>Paste .txt:</label><textarea id="chatText"></textarea><button onclick="importChat()">📥 Import</button><div id="result"></div></div>
<div class="card"><h3>🤖 Agent Control - Message people with goals</h3><div class="agent"><b>How to use from your self-chat:</b><br>Just talk naturally! No / needed<br>Examples:<br>• "Greet 0901 434 7620, ask how they are, ma for female Sir for male"<br>• Share contacts via WhatsApp, then say "greet them all"<br>• "0901 434 7620 0811 003 3639 greet them"<br>• Old: /agent 234... | Goal: ...</div>
<label>Numbers (comma separated):</label><input id="agentNumbers" placeholder="2348012345678,2348023456789" />
<label>Goal / Task:</label><textarea id="agentGoal" placeholder="Ask them about the project and get them to agree to send Opay. End when they say they will send."></textarea>
<button onclick="startAgent()">🚀 Start Agent Task</button><div id="agentResult"></div></div>
<div class="card"><h3>📊 Stats</h3><button onclick="loadStats()">Refresh</button><div id="stats"></div></div>
<script>
async function importChat(){const jid=document.getElementById('jid').value.trim();const ownerName=document.getElementById('ownerName').value.trim()||'You';const chatText=document.getElementById('chatText').value.trim();if(!jid||!chatText){alert('Enter number and chat');return;}document.getElementById('result').innerHTML='⏳...';try{const res=await fetch('/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jid,ownerName,chatText})});const data=await res.json();document.getElementById('result').innerHTML='<div style="background:#e8f5e9;padding:12px;border-radius:8px">✅ '+data.message+'<br>Learned '+data.learned+'</div>';}catch(e){document.getElementById('result').innerHTML='❌ '+e.message;}}
async function startAgent(){const numbers=document.getElementById('agentNumbers').value.trim();const goal=document.getElementById('agentGoal').value.trim();if(!numbers||!goal){alert('Enter numbers and goal');return;}document.getElementById('agentResult').innerHTML='⏳ Starting...';try{const res=await fetch('/agent',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({numbers,goal})});const data=await res.json();document.getElementById('agentResult').innerHTML='<div style="background:#fff3e0;padding:12px;border-radius:8px">✅ '+data.message+'</div>';}catch(e){document.getElementById('agentResult').innerHTML='❌ '+e.message;}}
async function loadStats(){document.getElementById('stats').innerHTML='⏳...';try{const res=await fetch('/stats');const data=await res.json();let html='<p>Contacts: '+data.totalContacts+' | Active agent tasks: '+(data.agentTasks||0)+'</p>';for(const c of data.contacts){html+='<div style="border:1px solid #eee;padding:10px;margin:5px 0;border-radius:8px"><b>'+c.jid+'</b> - '+c.count+'<br><small>'+(c.preview||'').slice(0,80)+'</small></div>';}document.getElementById('stats').innerHTML=html;}catch(e){document.getElementById('stats').innerHTML='Error: '+e.message;}}loadStats();
</script></body></html>`);
  } else if (req.url === '/import' && req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { jid, ownerName, chatText } = JSON.parse(body);
        if (!jid || !chatText) throw new Error('Missing');
        const mem = await getMemoryStore();
        const result = extractOwnerStyleFromExport(chatText, [ownerName, 'You']);
        const targetJid = jid.includes('@') ? jid : `${jid.replace(/[^0-9]/g,'')}@s.whatsapp.net`;
        let learned = 0;
        for (const s of result.styleSamples) { await mem.addOwnerMessage(targetJid, s); learned++; }
        for (const msg of result.conversation.slice(-20)) { await mem.addMessage(targetJid, msg.role, msg.content); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: `Imported ${result.totalMessages} msgs (${result.ownerCount} you)`, learned }));
      } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: e.message })); }
    });
  } else if (req.url === '/agent' && req.method === 'POST') {
    let body = ''; req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const { numbers, goal } = JSON.parse(body);
        if (!numbers || !goal) throw new Error('Missing numbers or goal');
        const mem = await getMemoryStore();
        const agentManager = await getAgentManager(mem, global.sockRef);
        const nums = extractNumbersRobust(numbers);
        let started = 0;
        for (const num of nums) {
          const targetJid = `${num}@s.whatsapp.net`;
          const ownerJid = `${config.phoneNumber}@s.whatsapp.net`;
          await agentManager.createTask(targetJid, goal, ownerJid);
          const ownerStyle = await mem.getOwnerStyle(targetJid);
          const styleTexts = ownerStyle.map(s => s.content);
          const history = await mem.getHistory(targetJid);
          const initialMsg = await generateReply(targetJid, `Start conversation with goal: ${goal}. Write first message to contact as owner would.`, history, styleTexts, null);
          await global.sockRef.sendMessage(targetJid, { text: initialMsg });
          await mem.addMessage(targetJid, 'assistant', initialMsg);
          started++;
          await new Promise(r => setTimeout(r, 3000));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: `Started ${started} agent tasks with goal: ${goal}` }));
      } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: e.message })); }
    });
  } else if (req.url === '/stats') {
    try {
      const mem = await getMemoryStore();
      let contacts = [];
      let agentTasks = 0;
      if (mem.isRedis && mem.redis && typeof mem.redis.keys === 'function') {
        const keys = await mem.redis.keys('owner:style:*');
        for (const key of keys.slice(0,20)) {
          const jid = key.replace('owner:style:', '');
          const samples = await mem.getOwnerStyle(jid);
          contacts.push({ jid, count: samples.length, preview: samples[0]?.content || '' });
        }
        const agentKeys = await mem.redis.keys('agent:task:*');
        agentTasks = agentKeys.length;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ totalContacts: contacts.length, contacts, agentTasks }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  } else { res.writeHead(404); res.end('Not found'); }
});

server.listen(config.port, '0.0.0.0', () => {
  console.log(`🌐 Server on 0.0.0.0:${config.port} - /import and /agent available`);
  
  // Keep-alive: self-ping every 4 minutes to prevent Render free tier sleep (15 min idle)
  // This creates inbound HTTP request to self, which counts as activity for Render
  const KEEP_ALIVE_INTERVAL = 4 * 60 * 1000; // 4 minutes
  setInterval(async () => {
    try {
      const url = `http://127.0.0.1:${config.port}/health`;
      const res = await fetch(url);
      const data = await res.json().catch(() => ({}));
      console.log(`💓 Keep-alive ping: ${data.status || res.status} - uptime ${Math.floor(process.uptime())}s - ${new Date().toLocaleString('en-NG', { timeZone: 'Africa/Lagos' })} WAT`);
    } catch (e) {
      console.error(`💓 Keep-alive failed: ${e.message}`);
    }
  }, KEEP_ALIVE_INTERVAL);
  console.log(`💓 Keep-alive enabled: pinging /health every 4 minutes to prevent Render sleep`);
  
  // External ping every 5 minutes to public URL (if available) - backup
  const PUBLIC_URL = process.env.RENDER_EXTERNAL_URL || 'https://whatsapp-ai-bot-xvp1.onrender.com';
  setInterval(async () => {
    try {
      const res = await fetch(`${PUBLIC_URL}/health`);
      console.log(`🌐 External keep-alive: ${PUBLIC_URL}/health -> ${res.status}`);
    } catch {}
  }, 5 * 60 * 1000);
});

global.botStatus = 'starting';
global.sockRef = null;
validateConfig();

let sock = null;
let memory = null;
let auth = null;
let pairingCodeRequested = false;
let agentManager = null;
let isStarting = false;
let reconnectTimeout = null;
let instanceId = Math.random().toString(36).slice(2, 8);
global.instanceId = instanceId;

async function startBot() {
  if (isStarting) {
    console.log(`⚠️ [${instanceId}] startBot already in progress, skipping duplicate start`);
    return;
  }
  isStarting = true;
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  try {
    console.log('\n' + '='.repeat(60));
    console.log(`🚀 WhatsApp AI Bot - Ghost + Style + Import + Media + SUPER AGENT [${instanceId}]`);
    console.log('='.repeat(60));
    memory = await getMemoryStore();
    auth = await createAuthState();
    
    // Auto-clear old corrupted sessions that cause Bad MAC - one time fix
    if (auth.clearSessions) {
      try {
        const shouldAutoClear = process.env.AUTO_CLEAR_SESSIONS !== 'false';
        if (shouldAutoClear) {
          console.log(`🧹 Checking for old corrupted sessions that cause Bad MAC...`);
          const cleared = await auth.clearSessions();
          if (cleared > 0) {
            console.log(`✅ Auto-cleared ${cleared} old session keys - Bad MAC should be fixed now`);
          } else {
            console.log(`✅ No old sessions to clear - sessions are clean`);
          }
        }
      } catch (e) {
        console.log(`⚠️ Auto-clear sessions failed: ${e.message}`);
      }
    }
    
    agentManager = await getAgentManager(memory, null);
    const { version } = await fetchLatestBaileysVersion();
    console.log(`📦 Baileys version: ${version.join('.')} [${instanceId}]`);
    const logger = pino({ level: 'silent' });
    sock = makeWASocket({
      version, auth: auth.state, logger,
      printQRInTerminal: false,
      browser: ['Ubuntu', 'Chrome', '20.0.04'],
      syncFullHistory: false,
      markOnlineOnConnect: true,
      generateHighQualityLinkPreview: false,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
    });
    global.sockRef = sock;
    agentManager.sock = sock;

    if (!auth.state.creds.registered && config.phoneNumber && !pairingCodeRequested) {
      setTimeout(async () => {
        try {
          if (!auth.state.creds.registered) {
            console.log(`\n📱 [${instanceId}] Requesting pairing code for ${config.phoneNumber}...`);
            const code = await sock.requestPairingCode(config.phoneNumber);
            console.log('\n' + '█'.repeat(60));
            console.log(`🔑 YOUR PAIRING CODE: ${code}`);
            console.log('█'.repeat(60));
            pairingCodeRequested = true;
          }
        } catch (err) {
          console.error(`❌ [${instanceId}] Pairing code failed:`, err.message);
          pairingCodeRequested = false;
          isStarting = false;
          reconnectTimeout = setTimeout(() => { if (!auth.state.creds.registered) startBot(); }, 15000);
        }
      }, 3000);
    }

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr && !config.phoneNumber) { qrcode.generate(qr, { small: true }); }
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const reason = lastDisconnect?.error?.message || 'unknown';
        console.log(`\n🔌 [${instanceId}] Closed. Status: ${statusCode}, Reason: ${reason}`);
        global.botStatus = `disconnected-${statusCode}`;
        
        // Clear sock reference
        try { if (sock) { await sock.end(); } } catch {}
        if (global.sockRef === sock) global.sockRef = null;
        
        if (statusCode === DisconnectReason.loggedOut) {
          console.log(`🚪 [${instanceId}] Logged out - clearing auth state, need re-pair`);
          if (auth.clearState) await auth.clearState();
          isStarting = false;
          return;
        }
        
        // 440 = Stream Errored (conflict) - another instance is running
        if (statusCode === 440) {
          console.log(`⚠️ [${instanceId}] 440 CONFLICT - Another instance is fighting for connection! Waiting 25s before retry to avoid Bad MAC errors...`);
          console.log(`⚠️ [${instanceId}] This causes "Failed to decrypt" and no response - need single instance`);
          global.botStatus = 'conflict-440-waiting-25s';
          isStarting = false;
          // Wait much longer for 440 to let other instance die
          reconnectTimeout = setTimeout(() => {
            console.log(`🔄 [${instanceId}] Retrying after 440 conflict wait...`);
            startBot();
          }, 25000 + Math.random() * 10000); // 25-35s
          return;
        }
        
        // Other disconnects - wait 8s
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect) {
          console.log(`🔄 [${instanceId}] Will reconnect in 8s...`);
          isStarting = false;
          reconnectTimeout = setTimeout(startBot, 8000);
        } else {
          isStarting = false;
        }
      } else if (connection === 'open') {
        console.log(`\n✅ [${instanceId}] Connected! Ghost + Style + Media + SUPER AGENT ON`);
        console.log(`📞 [${instanceId}] As: ${sock.user?.id || 'unknown'}`);
        console.log(`📚 [${instanceId}] Import: /import | Agent: /agent | Natural language: ON | Time: Lagos WAT`);
        global.botStatus = 'connected';
        pairingCodeRequested = false;
        isStarting = false;
      } else if (connection === 'connecting') {
        console.log(`⏳ [${instanceId}] Connecting...`);
        global.botStatus = 'connecting';
      }
    });

    sock.ev.on('creds.update', auth.saveCreds);
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        try { await handleMessage(msg); } catch (err) { console.error(`[${instanceId}] Error handling message:`, err); }
      }
    });

  } catch (err) {
    console.error(`❌ [${instanceId}] Fatal:`, err);
    global.botStatus = 'error';
    isStarting = false;
    reconnectTimeout = setTimeout(startBot, 15000);
  } finally {
    // isStarting will be cleared on open or close, but ensure not stuck
    // Don't clear here if connecting, let connection.update clear it
  }
}

async function handleMessage(msg) {
  const jid = msg.key.remoteJid;
  if (!jid) return;
  if (jid === 'status@broadcast' || jid.includes('@newsletter')) return;
  if (config.ignoreGroups && jid.endsWith('@g.us')) return;

  const isFromMe = msg.key.fromMe;
  const contactName = msg.pushName || jid.split('@')[0];
  const m = msg.message;
  let { text: messageContent, mediaInfo } = await extractContent(msg);
  const ownerJid = `${config.phoneNumber}@s.whatsapp.net`;
  const isSelfChat = jid === ownerJid || jid === `${config.phoneNumber}@s.whatsapp.net`;

  // Document import
  if (isFromMe && m?.documentMessage) {
    try {
      const doc = m.documentMessage;
      const fileName = doc.fileName || '';
      if (fileName.endsWith('.txt') || doc.mimetype === 'text/plain') {
        console.log('📚 Detected chat export .txt');
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
        const text = buffer.toString('utf-8');
        const result = extractOwnerStyleFromExport(text, ['You', contactName, '']);
        if (result.styleSamples.length > 0) {
          let imported = 0;
          for (const sample of result.styleSamples) { await memory.addOwnerMessage(jid, sample); imported++; }
          await sock.sendMessage(jid, { text: `✅ Imported ${imported} msgs from old chat with ${result.contactName}!` });
          return;
        }
      }
    } catch (e) { console.error('Document import error:', e.message); }
  }

  if (isFromMe) {
    // ===== SELF-CHAT SUPER INTELLIGENT AGENT =====
    if (isSelfChat) {
      // 1. Handle contact sharing (vCard)
      if (mediaInfo && mediaInfo.type === 'contact') {
        const numbers = mediaInfo.numbers || [];
        if (numbers.length > 0) {
          await agentManager.saveRecentSharedContacts(ownerJid, numbers);
          console.log(`📇 Owner shared ${numbers.length} contacts in self-chat: ${numbers.join(', ')}`);
          // If message also has instruction, trigger immediately
          if (messageContent && messageContent.length > 5 && !messageContent.startsWith('[Contact')) {
            const intent = await parseNaturalAgentIntent(`${numbers.join(' ')} ${messageContent}`, numbers);
            if (intent) {
              await handleAgentCommand(intent, jid);
              return;
            }
          }
          // If only contacts shared without instruction, store and acknowledge subtly
          if (!messageContent || messageContent.startsWith('[Contact') || messageContent.length < 10) {
            // Don't spam, just store silently, but if many contacts, give hint
            if (numbers.length >= 3) {
              await sock.sendMessage(jid, { text: `📇 Got ${numbers.length} contacts: ${numbers.join(', ')}\n\nTell me what to do with them - e.g. "greet them as ma/Sir" or "ask about project"` });
            }
            return;
          }
        }
      }

      // 2. Check explicit /agent commands first (old style still works)
      if (messageContent) {
        const agentCmd = parseAgentCommand(messageContent);
        if (agentCmd) {
          await handleAgentCommand(agentCmd, jid);
          return;
        }
        const cmd = parseOwnerCommand(messageContent);
        if (cmd) { await handleOwnerCommand(cmd, jid); return; }
      }

      // 3. SUPER INTELLIGENT natural language detection (no slash needed)
      if (messageContent) {
        try {
          const recentContacts = await agentManager.getRecentSharedContacts(ownerJid);
          const naturalIntent = await parseNaturalAgentIntent(messageContent, recentContacts);
          if (naturalIntent && naturalIntent.numbers.length > 0) {
            console.log(`🧠 Natural intent in self-chat: ${naturalIntent.numbers.length} numbers, goal: ${naturalIntent.goal.slice(0,100)}`);
            await handleAgentCommand(naturalIntent, jid);
            return;
          }
          // If message is just numbers without instruction but looks like a list, save as recent
          const onlyNumbers = extractNumbersRobust(messageContent);
          const textWithoutNumbers = messageContent.replace(/[0-9,\s\-\+\(\)]+/g, '').trim();
          if (onlyNumbers.length >= 1 && textWithoutNumbers.length < 3) {
            await agentManager.saveRecentSharedContacts(ownerJid, onlyNumbers);
            await sock.sendMessage(jid, { text: `📇 Saved ${onlyNumbers.length} numbers: ${onlyNumbers.join(', ')}\n\nWhat should I do with them? e.g. "greet them, ask how they are, ma for female Sir for male"` });
            return;
          }
        } catch (e) { console.error('Natural intent error:', e.message); }
      }

      // 4. If self-chat and no command, learn style but also keep as note
      if (messageContent && !messageContent.startsWith('/')) {
        await memory.addOwnerMessage(jid, messageContent);
        await memory.addMessage(jid, 'assistant', messageContent);
        console.log(`📝 Self-chat note: "${messageContent.slice(0,80)}..."`);
      }
      return;
    }

    // Not self-chat, but owner messaging someone else - learn style
    if (messageContent) {
      const agentCmd = parseAgentCommand(messageContent);
      if (agentCmd) {
        await handleAgentCommand(agentCmd, jid);
        return;
      }
      const cmd = parseOwnerCommand(messageContent);
      if (cmd) { await handleOwnerCommand(cmd, jid); return; }
      if (messageContent && !messageContent.startsWith('/')) {
        await memory.addOwnerMessage(jid, messageContent);
        await memory.addMessage(jid, 'assistant', messageContent);
        console.log(`📝 Learned YOUR style for ${contactName}: "${messageContent.slice(0,50)}..."`);
      }
    }
    return;
  }

  if (!messageContent && !mediaInfo) return;

  console.log(`\n📩 From ${contactName} (${jid}): ${messageContent?.slice(0,100)} ${mediaInfo ? `[${mediaInfo.type}]` : ''}`);

  const activeTask = await agentManager.getTask(jid);
  if (activeTask) {
    console.log(`🤖 Agent task active for ${jid}: ${activeTask.goal}`);
    // Transcribe voice/video for agent tasks too
    if (mediaInfo && (mediaInfo.type === 'voice' || mediaInfo.type === 'audio' || mediaInfo.type === 'video')) {
      try {
        console.log(`📥 Agent: Downloading ${mediaInfo.type} for transcription...`);
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
        const transcribed = await transcribeAudio(buffer, mediaInfo.mimeType || 'audio/ogg');
        if (transcribed) {
          console.log(`🎙️ Agent voice transcribed: "${transcribed.slice(0,100)}..."`);
          messageContent = transcribed;
          mediaInfo.transcription = transcribed;
        }
      } catch (e) {
        console.error(`❌ Agent transcription failed: ${e.message}`);
      }
    }
    await handleAgentReply(jid, messageContent, mediaInfo, activeTask);
    return;
  }

  if (await memory.isHandoff(jid)) {
    console.log(`⏸️ Paused for ${jid}`);
    await memory.addMessage(jid, 'user', messageContent || `[${mediaInfo?.type || 'media'}]`);
    return;
  }

  if (await memory.isRateLimited(jid)) {
    const count = await memory.getRateLimitCount(jid);
    if (count === config.maxPerHour + 1) {
      await delay(1000);
      await sock.sendMessage(jid, { text: "Network dey slow small, I go reply you now 🙏" });
    }
    return;
  }

  if (messageContent && isHandoffRequest(messageContent)) {
    console.log(`🙋 Handoff by ${jid}`);
    await memory.setHandoff(jid, config.handoffMinutes);
    await memory.addMessage(jid, 'user', messageContent);
    await delayRandom();
    await sock.sendMessage(jid, { text: `No wahala, make I call you back now now 🙏\n\n_Bot paused for ${config.handoffMinutes} mins_` });
    await memory.addMessage(jid, 'assistant', 'Handoff');
    return;
  }

  try {
    const historyText = messageContent || (mediaInfo ? `[${mediaInfo.type} ${mediaInfo.caption ? ': ' + mediaInfo.caption : ''}]` : '');
    await memory.addMessage(jid, 'user', historyText);
    const history = await memory.getHistory(jid);
    const ownerStyle = await memory.getOwnerStyle(jid);
    const ownerStyleTexts = ownerStyle.map(s => s.content);
    console.log(`🎭 Style samples for ${contactName}: ${ownerStyleTexts.length}, Media: ${mediaInfo?.type || 'none'}`);

    await sock.sendPresenceUpdate('composing', jid);
    await delayRandom();

    let mediaForAI = null;
    let transcribedText = null;
    
    if (mediaInfo && (mediaInfo.type === 'image' || mediaInfo.type === 'sticker')) {
      try {
        console.log(`📥 Downloading ${mediaInfo.type} for AI...`);
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
        const base64 = buffer.toString('base64');
        mediaForAI = { type: mediaInfo.type, base64, mimeType: mediaInfo.mimeType || (mediaInfo.type === 'sticker' ? 'image/webp' : 'image/jpeg'), caption: mediaInfo.caption || '', emoji: mediaInfo.emoji || '' };
        console.log(`✅ Downloaded ${mediaInfo.type}: ${buffer.length} bytes`);
      } catch (e) { console.error(`❌ Failed download ${mediaInfo.type}:`, e.message); }
    } else if (mediaInfo && (mediaInfo.type === 'voice' || mediaInfo.type === 'audio')) {
      try {
        console.log(`📥 Downloading ${mediaInfo.type} for transcription...`);
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
        console.log(`✅ Downloaded ${mediaInfo.type}: ${buffer.length} bytes, transcribing...`);
        transcribedText = await transcribeAudio(buffer, mediaInfo.mimeType || 'audio/ogg');
        if (transcribedText) {
          console.log(`🎙️ Voice transcribed to: "${transcribedText.slice(0,120)}..."`);
          // Use transcribed text as the actual message content
          messageContent = transcribedText;
          // Keep media info for context
          mediaForAI = { type: mediaInfo.type, transcription: transcribedText, mimeType: mediaInfo.mimeType };
        } else {
          console.log(`⚠️ Voice transcription failed, will handle as voice note`);
          mediaForAI = { type: mediaInfo.type, transcription: null, mimeType: mediaInfo.mimeType };
        }
      } catch (e) { console.error(`❌ Failed download/transcribe ${mediaInfo.type}:`, e.message); }
    } else if (mediaInfo && mediaInfo.type === 'video') {
      try {
        // If video has caption, use caption, but also try to transcribe audio
        if (!mediaInfo.caption || mediaInfo.caption.length < 5) {
          console.log(`📥 Downloading video for transcription...`);
          const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
          console.log(`✅ Downloaded video: ${buffer.length} bytes, trying transcription...`);
          transcribedText = await transcribeAudio(buffer, mediaInfo.mimeType || 'video/mp4');
          if (transcribedText) {
            console.log(`🎬 Video audio transcribed: "${transcribedText.slice(0,120)}..."`);
            const captionPart = mediaInfo.caption ? `${mediaInfo.caption} ` : '';
            messageContent = `${captionPart}[Video says: ${transcribedText}]`.trim();
            mediaForAI = { type: 'video', transcription: transcribedText, caption: mediaInfo.caption || '', mimeType: mediaInfo.mimeType };
          }
        }
      } catch (e) { console.error(`❌ Failed video transcription:`, e.message); }
    }

    // If we have transcription, use it as the message, otherwise use original
    const finalMessageForAI = transcribedText || messageContent || historyText;
    const aiReply = await generateReply(jid, finalMessageForAI, history.slice(0, -1), ownerStyleTexts, mediaForAI);

    await sock.sendMessage(jid, { text: aiReply });
    console.log(`🤖 Replied as YOU to ${contactName}: ${aiReply.slice(0,100)}...`);
    await memory.addMessage(jid, 'assistant', aiReply);
    await sock.sendPresenceUpdate('paused', jid);

  } catch (err) {
    console.error(`Error replying to ${jid}:`, err);
    try { await sock.sendMessage(jid, { text: "Omo network dey worry, I go reply you now 🙏" }); } catch {}
  }
}

async function handleAgentCommand(agentCmd, ownerJid) {
  console.log(`🤖 Agent command from ${ownerJid}:`, agentCmd);
  const { numbers, goal } = agentCmd;
  
  let started = 0;
  let failed = 0;
  
  try {
    const hint = agentCmd.isNatural ? '🧠 Natural language detected' : '🤖 Agent command';
    await sock.sendMessage(ownerJid, { text: `${hint}\n\nTargets: ${numbers.length} numbers\nGoal: ${goal}\n\nI will message them one by one and bring discussion to end. Reporting progress here...` });
  } catch (e) { console.error('Failed to send starting msg to owner:', e.message); }

  for (const num of numbers) {
    try {
      const targetJid = `${num}@s.whatsapp.net`;
      console.log(`🤖 Creating agent task for ${targetJid} with goal: ${goal}`);
      await agentManager.createTask(targetJid, goal, ownerJid);
      
      const ownerStyle = await memory.getOwnerStyle(targetJid);
      const styleTexts = ownerStyle.map(s => s.content);
      const history = await memory.getHistory(targetJid);
      
      let genderHint = 'unknown';
      const styleCombined = styleTexts.join(' ').toLowerCase();
      if (styleCombined.includes(' ma ') || styleCombined.includes(' ma,') || styleCombined.match(/\bma\b.*\?/) || styleCombined.includes(' madam') || styleCombined.includes(' sis') || styleCombined.includes(' aunty')) {
        genderHint = 'female - address as ma';
      } else if (styleCombined.includes(' sir')) {
        genderHint = 'male - address as Sir';
      }
      const historyText = history.map(h => h.content).join(' ').toLowerCase();
      if (genderHint === 'unknown') {
        if (historyText.includes(' ma ') || historyText.includes(' madam')) genderHint = 'female - address as ma';
        else if (historyText.includes(' sir ')) genderHint = 'male - address as Sir';
      }
      console.log(`🎭 Gender hint for ${targetJid}: ${genderHint} (from ${styleTexts.length} samples)`);
      
      // Nigerian time awareness
      const timeCtx = getNigerianTimeContext();
      
      let initialMsg = '';
      try {
        let genderInstruction = '';
        if (goal.toLowerCase().includes(' ma ') || goal.toLowerCase().includes(' sir') || goal.toLowerCase().includes('female') || goal.toLowerCase().includes('male')) {
          genderInstruction = `IMPORTANT: ${goal}. For gender: ${genderHint}. If female use "ma", if male use "Sir" based on previous chat style. ${genderHint !== 'unknown' ? `This contact is likely ${genderHint}, so use that title.` : 'Detect gender from how owner called them before (ma for female, Sir for male).'}`;
        } else {
          genderInstruction = goal;
        }
        
        const initialPrompt = `You need to start a conversation with this contact to achieve this goal: ${genderInstruction}. 

Context:
- Contact: ${targetJid.split('@')[0]}
- Detected gender hint from history: ${genderHint}
- Owner style samples: ${styleTexts.slice(-5).join(' | ').slice(0,300)}
- Goal says to address female as "ma" and male as "Sir" based on previous chat - USE ${genderHint}
- TIME: ${timeCtx.formatted} - You MUST use time-appropriate greeting. ${timeCtx.greetingInstruction} At 3am, NEVER say Good evening, use Hello instead.

Write ONLY the first message as owner would, in their unique style with this person. Be natural, casual, Nigerian style but respectful. Keep short 1-2 lines. Use "${timeCtx.greeting}" or neutral Hello as appropriate for ${timeCtx.period}. Start conversation now. No explanation, just the message. Include appropriate title (ma/Sir) if you know gender and time-appropriate greeting.`;
        initialMsg = await generateReply(targetJid, initialPrompt, history, styleTexts, null);
        console.log(`🤖 Generated initial msg for ${targetJid}: ${initialMsg.slice(0,120)}...`);
      } catch (e) {
        console.error(`❌ Failed to generate initial msg for ${targetJid}:`, e.message);
        // Time-aware fallback
        const fallbackGreeting = timeCtx.greeting === 'Hello' ? 'Hello' : timeCtx.greeting;
        if (genderHint.includes('female')) {
          initialMsg = `${fallbackGreeting} ma, how you dey? Hope you dey fine? 🙏`;
        } else if (genderHint.includes('male')) {
          initialMsg = `${fallbackGreeting} Sir, how you dey? Hope you dey fine? 🙏`;
        } else if (goal.toLowerCase().includes('project')) {
          initialMsg = `${fallbackGreeting}, how far? How the project dey go? Any update? 🙏`;
        } else {
          initialMsg = `${fallbackGreeting}, how you dey? How body? Hope you dey fine? 🙏`;
        }
        if (goal.toLowerCase().includes('greet') || goal.toLowerCase().includes('how they are')) {
          if (genderHint.includes('female') && !initialMsg.toLowerCase().includes(' ma')) initialMsg = initialMsg.replace(fallbackGreeting, `${fallbackGreeting} ma,`);
          if (genderHint.includes('male') && !initialMsg.toLowerCase().includes('sir')) initialMsg = initialMsg.replace(fallbackGreeting, `${fallbackGreeting} Sir,`);
        }
        console.log(`🤖 Using fallback initial msg (${timeCtx.greeting}): ${initialMsg}`);
      }

      if (!initialMsg || initialMsg.includes('Network dey worry') || initialMsg.length < 3) {
        const fbGreet = timeCtx.greeting;
        if (genderHint.includes('female')) initialMsg = `${fbGreet} ma, how you dey? ${goal.slice(0,60)} 🙏`;
        else if (genderHint.includes('male')) initialMsg = `${fbGreet} Sir, how you dey? ${goal.slice(0,60)} 🙏`;
        else initialMsg = `${fbGreet}, how you dey? ${goal.slice(0,60)} 🙏`;
      }
      
      await delayRandom();
      console.log(`📤 Sending agent message to ${targetJid}: ${initialMsg.slice(0,100)}...`);
      try {
        await sock.sendMessage(targetJid, { text: initialMsg });
        console.log(`✅ Agent message SENT to ${targetJid}`);
        await memory.addMessage(targetJid, 'assistant', initialMsg);
        await agentManager.updateTask(targetJid, { 
          history: [{ role: 'assistant', content: initialMsg }],
          steps: 1
        });
        started++;
      } catch (sendErr) {
        console.error(`❌ Failed to SEND message to ${targetJid}:`, sendErr.message);
        try {
          console.log(`🔄 Retrying send to ${targetJid} after 2s...`);
          await delay(2000);
          await sock.sendMessage(targetJid, { text: initialMsg });
          console.log(`✅ Retry succeeded for ${targetJid}`);
          await memory.addMessage(targetJid, 'assistant', initialMsg);
          await agentManager.updateTask(targetJid, { history: [{ role: 'assistant', content: initialMsg }], steps: 1 });
          started++;
        } catch (retryErr) {
          console.error(`❌ Retry also failed for ${targetJid}:`, retryErr.message);
          await agentManager.failTask(targetJid, `Failed to send: ${retryErr.message}`);
          failed++;
        }
      }
      
      if (numbers.length > 1) await delay(5000 + Math.random() * 5000);
      
    } catch (e) {
      console.error(`Agent failed for ${num}:`, e.message, e.stack?.slice(0,300));
      failed++;
      try { await agentManager.failTask(`${num}@s.whatsapp.net`, e.message); } catch {}
    }
  }
  
  try {
    await sock.sendMessage(ownerJid, { text: `🚀 *Agent Launched*\n\n✅ Started: ${started}\n❌ Failed: ${failed}\nNumbers: ${numbers.join(', ')}\n\nI will chat with them and report back when goal is achieved. Check /status\n\n💡 Now you can just talk naturally without /agent - e.g.:\n"Greet 0901... 0811... as ma/Sir"\nOr share contacts and say "greet them all"` });
  } catch {}
}

async function handleAgentReply(jid, messageContent, mediaInfo, task) {
  try {
    // Handle voice note transcription for agent replies too
    let actualContent = messageContent;
    let transcription = null;
    
    if (mediaInfo && (mediaInfo.type === 'voice' || mediaInfo.type === 'audio' || mediaInfo.type === 'video')) {
      try {
        // We need original msg to download - we don't have it here, so we try to use messageContent if it's transcription already
        // For agent flow, mediaInfo comes from extractContent, but buffer not available
        // We will try to handle if messageContent is [Voice note] - try to get buffer via global? 
        // For now, if mediaInfo has no transcription, we will attempt to download using last message
        // Simplification: If it's voice and messageContent is placeholder, we will note it and still generate reply
        // The main transcription happens in handleMessage before calling this, but for agent we need to handle msg object
        // Actually handleMessage for agent path doesn't download, so we need to handle transcription in handleMessage before
        // This is called from handleMessage which already has mediaInfo but not buffer
        // We'll attempt transcription if we can get buffer from msg - but we don't have msg here
        // So we will just use messageContent as is, but if it's placeholder, we add context
        if (messageContent && (messageContent.includes('[Voice') || messageContent.includes('[Audio') || messageContent.includes('[Video'))) {
          // Try to indicate it was voice
          actualContent = `${messageContent} (voice note - transcription not available in agent flow, respond naturally asking for clarification if needed)`;
        }
      } catch (e) {
        console.error(`Agent transcription error: ${e.message}`);
      }
    }
    
    const historyText = actualContent || (mediaInfo ? `[${mediaInfo.type}]` : '');
    await memory.addMessage(jid, 'user', historyText);
    
    task.history.push({ role: 'user', content: historyText });
    task.steps++;
    
    console.log(`🤖 Agent step ${task.steps} for ${jid}: ${historyText.slice(0,80)}...`);
    
    if (task.steps >= task.maxSteps) {
      await agentManager.completeTask(jid, `Max steps (${task.maxSteps}) reached. Last message: ${historyText}`);
      return;
    }
    
    const history = await memory.getHistory(jid);
    const ownerStyle = await memory.getOwnerStyle(jid);
    const styleTexts = ownerStyle.map(s => s.content);
    
    const timeCtxReply = getNigerianTimeContext();
    const goalPrompt = `You are in an AGENT TASK. Your goal: ${task.goal}. You are chatting with ${jid.split('@')[0]}. Continue conversation to achieve goal. Current step ${task.steps}/${task.maxSteps}. Be owner, use unique style, be seamless. If goal achieved, say so naturally and wrap up. TIME: ${timeCtxReply.formatted} - Use time-appropriate greeting if greeting needed.`;
    
    const fullHistory = [...history.slice(0, -1), { role: 'system', content: goalPrompt }];
    
    await sock.sendPresenceUpdate('composing', jid);
    await delayRandom();
    
    let mediaForAI = null;
    if (transcription) {
      mediaForAI = { type: 'voice', transcription, mimeType: 'audio/ogg' };
    }
    
    const aiReply = await generateReply(jid, actualContent || historyText, fullHistory, styleTexts, mediaForAI);
    
    await sock.sendMessage(jid, { text: aiReply });
    console.log(`🤖 Agent replied to ${jid}: ${aiReply.slice(0,100)}...`);
    
    await memory.addMessage(jid, 'assistant', aiReply);
    task.history.push({ role: 'assistant', content: aiReply });
    
    await agentManager.updateTask(jid, { history: task.history, steps: task.steps });
    
    const achieved = await agentManager.isGoalAchieved(task.goal, task.history);
    if (achieved) {
      await agentManager.completeTask(jid, `Goal achieved: ${task.goal}`);
    }
    
    await sock.sendPresenceUpdate('paused', jid);
    
  } catch (err) {
    console.error(`Agent reply error for ${jid}:`, err);
  }
}

async function extractContent(msg) {
  const m = msg.message;
  if (!m) return { text: '', mediaInfo: null };
  if (m.conversation) return { text: m.conversation, mediaInfo: null };
  if (m.extendedTextMessage?.text) return { text: m.extendedTextMessage.text, mediaInfo: null };
  if (m.imageMessage) return { text: m.imageMessage.caption || '[Image]', mediaInfo: { type: 'image', caption: m.imageMessage.caption || '', mimeType: m.imageMessage.mimetype || 'image/jpeg' } };
  if (m.stickerMessage) return { text: '[Sticker]' + (m.stickerMessage.isAnimated ? ' (animated)' : ''), mediaInfo: { type: 'sticker', mimeType: m.stickerMessage.mimetype || 'image/webp' } };
  if (m.videoMessage) return { text: m.videoMessage.caption || '[Video]', mediaInfo: { type: 'video', caption: m.videoMessage.caption || '', mimeType: m.videoMessage.mimetype || 'video/mp4' } };
  if (m.audioMessage) {
    const isVoice = m.audioMessage.ptt;
    return { text: isVoice ? '[Voice note]' : '[Audio]', mediaInfo: { type: isVoice ? 'voice' : 'audio', mimeType: m.audioMessage.mimetype || 'audio/ogg' } };
  }
  if (m.documentMessage) return { text: m.documentMessage.caption || `[Document: ${m.documentMessage.fileName || 'file'}]`, mediaInfo: { type: 'document', caption: m.documentMessage.caption || '', mimeType: m.documentMessage.mimetype, fileName: m.documentMessage.fileName } };
  if (m.buttonsResponseMessage?.selectedButtonId) return { text: m.buttonsResponseMessage.selectedButtonId, mediaInfo: null };
  if (m.listResponseMessage?.singleSelectReply?.selectedRowId) return { text: m.listResponseMessage.title || m.listResponseMessage.singleSelectReply.selectedRowId, mediaInfo: null };
  if (m.templateButtonReplyMessage?.selectedId) return { text: m.templateButtonReplyMessage.selectedId, mediaInfo: null };
  if (m.reactionMessage) {
    const emoji = m.reactionMessage.text || '❤️';
    return { text: `[Reacted ${emoji}]`, mediaInfo: { type: 'reaction', emoji } };
  }
  if (m.protocolMessage) return { text: '', mediaInfo: null };
  if (m.viewOnceMessageV2?.message) {
    const inner = m.viewOnceMessageV2.message;
    if (inner.imageMessage) return { text: inner.imageMessage.caption || '[View once image]', mediaInfo: { type: 'image', caption: inner.imageMessage.caption || '' } };
    if (inner.videoMessage) return { text: inner.videoMessage.caption || '[View once video]', mediaInfo: { type: 'video' } };
    if (inner.extendedTextMessage?.text) return { text: inner.extendedTextMessage.text, mediaInfo: null };
  }
  if (m.locationMessage) return { text: `[Location: ${m.locationMessage.degreesLatitude}, ${m.locationMessage.degreesLongitude}]`, mediaInfo: { type: 'location' } };
  if (m.contactMessage) {
    const vcard = m.contactMessage.vcard || '';
    const numbers = extractNumbersFromVcard(vcard);
    const displayName = m.contactMessage.displayName || 'Contact';
    console.log(`📇 Contact share: ${displayName} -> ${numbers.join(', ')}`);
    return { text: `[Contact: ${displayName}] ${numbers.join(', ')}`, mediaInfo: { type: 'contact', numbers, displayName, vcard } };
  }
  if (m.contactsArrayMessage) {
    const contacts = m.contactsArrayMessage.contacts || [];
    const allNumbers = [];
    const names = [];
    for (const c of contacts) {
      const vcard = c.vcard || '';
      const nums = extractNumbersFromVcard(vcard);
      allNumbers.push(...nums);
      names.push(c.displayName || 'Contact');
    }
    console.log(`📇 Multiple contacts share: ${names.join(', ')} -> ${allNumbers.join(', ')}`);
    return { text: `[Contacts: ${names.join(', ')}] ${allNumbers.join(', ')}`, mediaInfo: { type: 'contact', numbers: [...new Set(allNumbers)], displayNames: names } };
  }
  if (m.pollCreationMessage) return { text: `[Poll: ${m.pollCreationMessage.name}]`, mediaInfo: null };
  return { text: '', mediaInfo: null };
}

async function handleOwnerCommand(cmd, currentJid) {
  console.log(`👑 Owner command: ${JSON.stringify(cmd)} in ${currentJid}`);
  const sendTo = currentJid;
  switch (cmd.action) {
    case 'pause': {
      if (!cmd.target) { await sock.sendMessage(sendTo, { text: 'Usage: /pause 2348012345678' }); return; }
      const targetJid = `${cmd.target}@s.whatsapp.net`;
      await memory.setHandoff(targetJid, config.handoffMinutes);
      await sock.sendMessage(sendTo, { text: `⏸️ Paused for ${cmd.target}` });
      break;
    }
    case 'resume': {
      if (!cmd.target) { await sock.sendMessage(sendTo, { text: 'Usage: /resume 2348012345678 or /resume all' }); return; }
      const targetJid = `${cmd.target}@s.whatsapp.net`;
      await memory.clearHandoff(targetJid);
      await sock.sendMessage(sendTo, { text: `▶️ Resumed for ${cmd.target}` });
      break;
    }
    case 'resumeAll': {
      await memory.clearAllHandoffs();
      await sock.sendMessage(sendTo, { text: '▶️ Resumed for ALL' });
      break;
    }
    case 'clear': {
      if (!cmd.target) { await sock.sendMessage(sendTo, { text: 'Usage: /clear 2348012345678 or /clear sessions to fix Bad MAC' }); return; }
      const targetJid = `${cmd.target}@s.whatsapp.net`;
      await memory.clearHistory(targetJid);
      await sock.sendMessage(sendTo, { text: `🗑️ History cleared for ${cmd.target}` });
      break;
    }
    case 'clearSessions': {
      try {
        await sock.sendMessage(sendTo, { text: `🧹 Clearing Bad MAC sessions... This fixes "Failed to decrypt" errors. Bot will re-establish sessions on next messages.` });
        let cleared = 0;
        if (auth && auth.clearSessions) {
          cleared = await auth.clearSessions();
        } else {
          // Fallback: create temp auth
          const { createAuthState } = await import('./auth.js');
          const tempAuth = await createAuthState();
          if (tempAuth.clearSessions) cleared = await tempAuth.clearSessions();
        }
        await sock.sendMessage(sendTo, { text: `✅ Cleared ${cleared} session keys!\n\nBad MAC should be fixed now. Future messages will decrypt correctly. Old queued messages that failed to decrypt are lost, but new messages will work.\n\nIf still seeing Bad MAC, you may need to re-pair once.` });
      } catch (e) {
        await sock.sendMessage(sendTo, { text: `❌ Failed to clear sessions: ${e.message}\n\nTry via web: https://whatsapp-ai-bot-xvp1.onrender.com/clear-sessions` });
      }
      break;
    }
    case 'send': {
      if (!cmd.target || !cmd.message) { await sock.sendMessage(sendTo, { text: 'Usage: /send 2348012345678 Your message here\n\nExamples:\n/send 08051934689 Hello boss how far?\n/send 0901 434 7620, 0811 003 3639 Hello everyone\n\n💡 Now you can also just say naturally:\n"Greet 0901 434 7620 0811 003 3639 as ma/Sir"' }); return; }
      let targets = extractNumbersRobust(cmd.target);
      if (targets.length === 0) {
        const { normalizeNumber } = await import('./agent.js');
        const single = normalizeNumber(cmd.target);
        if (single) targets = [single];
      }
      if (targets.length === 0) { await sock.sendMessage(sendTo, { text: `❌ Invalid number: ${cmd.target}` }); return; }
      
      let sent = 0, failed = 0;
      for (const normalized of targets) {
        const targetJid = `${normalized}@s.whatsapp.net`;
        try {
          console.log(`📤 Owner /send to ${targetJid}: ${cmd.message.slice(0,80)}...`);
          await sock.sendMessage(targetJid, { text: cmd.message });
          await memory.addMessage(targetJid, 'assistant', cmd.message);
          await memory.addOwnerMessage(targetJid, cmd.message);
          sent++;
          if (targets.length > 1) await delay(3000);
        } catch (e) {
          console.error(`❌ /send failed for ${targetJid}:`, e.message);
          failed++;
        }
      }
      await sock.sendMessage(sendTo, { text: `✅ Broadcast result: Sent ${sent}, Failed ${failed} to ${targets.join(', ')}\n\nMessage: ${cmd.message}` });
      break;
    }
    case 'style': {
      if (!cmd.target) { await sock.sendMessage(sendTo, { text: 'Usage: /style 2348012345678' }); return; }
      const targetJid = `${cmd.target}@s.whatsapp.net`;
      const samples = await memory.getOwnerStyle(targetJid);
      if (samples.length === 0) await sock.sendMessage(sendTo, { text: `No style learned yet for ${cmd.target}` });
      else {
        const preview = samples.slice(-10).map(s => `• ${s.content}`).join('\n');
        await sock.sendMessage(sendTo, { text: `🎭 Style for ${cmd.target} (${samples.length} samples):\n\n${preview}` });
      }
      break;
    }
    case 'status': {
      const uptime = Math.floor(process.uptime());
      const hours = Math.floor(uptime / 3600);
      const mins = Math.floor((uptime % 3600) / 60);
      const styleCount = await memory.getAllOwnerStylesCount();
      const agentTasks = await agentManager.listActiveTasks();
      const recent = await agentManager.getRecentSharedContacts(`${config.phoneNumber}@s.whatsapp.net`);
      await sock.sendMessage(sendTo, { text: `📊 *Bot Status - SUPER AGENT MODE*\n\n• Status: ${global.botStatus}\n• Uptime: ${hours}h ${mins}m\n• Model: ${config.geminiModel}\n• Learned: ${styleCount} contacts\n• Active agent tasks: ${agentTasks.length}\n• Recent shared contacts: ${recent.length > 0 ? recent.join(', ') : 'none'}\n• Media: Images, Stickers, Voice, Video, Contacts ✅\n• AI Chain: ${[config.geminiApiKey?'Gemini':null, config.groqApiKey?'Groq':null, config.openrouterApiKey?'OpenRouter':null, config.cerebrasApiKey?'Cerebras':null, config.githubToken?'GitHub':null].filter(Boolean).join(' → ')}\n• Connected: ${sock?.user ? 'Yes' : 'No'}\n\n🧠 Natural language: ON - Just talk to yourself!\nExamples:\n"Greet 0901... 0811... as ma/Sir"\nShare contacts + "greet them all"\n"Do same to all contacts I shared"\n\nOld: /agent 234... | Goal: ...\n📚 Import: /import` });
      break;
    }
    case 'help': {
      await sock.sendMessage(sendTo, { text: getOwnerHelpText() + '\n\n🧠 SUPER AGENT - No slash needed!\nJust say in self-chat:\n"Greet 0901 434 7620, 0811... ask how they are, ma for female Sir for male"\nOr share contacts and say "greet them all"\n\nBot understands:\n• Numbers with spaces: 0901 434 7620\n• Contact cards (WhatsApp share)\n• "them", "all", "same thing" = recent contacts\n• Gender from your history (ma/Sir)\n\nOld still works:\n/agent 234... | Goal: your goal\n/send 234... message' });
      break;
    }
  }
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
function delayRandom() {
  const min = config.replyDelayMin;
  const max = config.replyDelayMax;
  return delay(Math.floor(Math.random() * (max - min + 1)) + min);
}

async function transcribeAudio(buffer, mimeType = 'audio/ogg') {
  // Try Groq Whisper first (free, fast, no card)
  if (config.groqApiKey) {
    try {
      console.log(`🎙️ Transcribing audio with Groq Whisper (${mimeType}, ${buffer.length} bytes)...`);
      const formData = new FormData();
      // Determine extension from mimeType
      let ext = 'ogg';
      if (mimeType.includes('mp4')) ext = 'mp4';
      else if (mimeType.includes('mpeg') || mimeType.includes('mp3')) ext = 'mp3';
      else if (mimeType.includes('wav')) ext = 'wav';
      else if (mimeType.includes('webm')) ext = 'webm';
      else if (mimeType.includes('ogg')) ext = 'ogg';
      
      const blob = new Blob([buffer], { type: mimeType });
      formData.append('file', blob, `audio.${ext}`);
      formData.append('model', 'whisper-large-v3-turbo');
      formData.append('response_format', 'json');
      // Auto-detect language, but hint for Nigerian English + pidgin
      // formData.append('language', 'en');
      
      const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.groqApiKey}`
        },
        body: formData
      });
      
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Groq Whisper ${res.status}: ${errText.slice(0,200)}`);
      }
      
      const data = await res.json();
      const text = data.text || data.transcription || '';
      if (text) {
        console.log(`✅ Groq Whisper transcribed: "${text.slice(0,100)}..."`);
        return text.trim();
      }
    } catch (e) {
      console.error(`❌ Groq Whisper failed: ${e.message.slice(0,300)}`);
    }
  }
  
  // Fallback: Try HuggingFace Whisper if available
  if (config.hfApiKey) {
    try {
      console.log(`🎙️ Trying HuggingFace Whisper...`);
      // HF inference API for whisper
      const res = await fetch(`https://api-inference.huggingface.co/models/openai/whisper-large-v3-turbo`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.hfApiKey}`,
          'Content-Type': mimeType
        },
        body: buffer
      });
      if (res.ok) {
        const data = await res.json();
        const text = data.text || data.transcription || '';
        if (text) {
          console.log(`✅ HF Whisper: "${text.slice(0,100)}..."`);
          return text.trim();
        }
      }
    } catch (e) {
      console.error(`❌ HF Whisper failed: ${e.message.slice(0,200)}`);
    }
  }
  
  console.log(`⚠️ No transcription available, will handle as voice note without text`);
  return null;
}

process.on('SIGINT', async () => {
  console.log('\n👋 Shutting down...');
  if (sock) await sock.end();
  server.close();
  process.exit(0);
});
process.on('uncaughtException', (err) => { console.error('Uncaught:', err); });
process.on('unhandledRejection', (err) => { console.error('Unhandled:', err); });

startBot();
