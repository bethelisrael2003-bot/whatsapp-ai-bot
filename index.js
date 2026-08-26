import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import http from 'http';
import { config, validateConfig } from './config.js';
import { createAuthState } from './auth.js';
import { getMemoryStore } from './memory.js';
import { generateReply, isHandoffRequest, parseOwnerCommand, getOwnerHelpText } from './ai.js';
import { extractOwnerStyleFromExport } from './import.js';
import { getAgentManager, parseAgentCommand } from './agent.js';

const server = http.createServer(async (req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime(), bot: global.botStatus || 'starting', timestamp: new Date().toISOString() }));
  } else if (req.url === '/import' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Import Old Chats + Agent Control</title><style>body{font-family:system-ui;padding:20px;max-width:700px;margin:auto;background:#f5f5f5} .card{background:white;padding:20px;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.1);margin-bottom:20px} textarea{width:100%;height:200px;padding:12px;border:1px solid #ddd;border-radius:8px;font-family:monospace;font-size:13px} input,button{padding:12px;border-radius:8px;border:1px solid #ddd;margin:5px 0;width:100%} button{background:#25D366;color:white;border:none;font-weight:bold;cursor:pointer} button:hover{background:#128C7E} .info{background:#e8f5e9;padding:12px;border-radius:8px;margin:10px 0;font-size:14px} .agent{background:#fff3e0;padding:12px;border-radius:8px;margin:10px 0}</style></head><body>
<h2>📚 Import Old Chats + 🤖 Agent Control</h2>
<div class="card"><h3>Import Old Chats</h3><div class="info">Export: WhatsApp → Chat → 3 dots → More → Export → Without media → Copy .txt</div><label>Number (234...):</label><input id="jid" placeholder="2348012345678" /><label>Your name in export:</label><input id="ownerName" placeholder="You" value="You" /><label>Paste .txt:</label><textarea id="chatText"></textarea><button onclick="importChat()">📥 Import</button><div id="result"></div></div>
<div class="card"><h3>🤖 Agent Control - Message people with goals</h3><div class="agent"><b>How to use from your self-chat:</b><br>/agent 2348012345678 | Goal: Ask for payment and get confirmation<br>/agent 2348012345678,2348023456789 | Goal: Broadcast hello and collect replies<br>Bot will go chat with them and report back to you!</div>
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
        const nums = numbers.split(',').map(n => n.replace(/[^0-9]/g,'')).filter(n => n.length >= 10);
        let started = 0;
        for (const num of nums) {
          const targetJid = `${num}@s.whatsapp.net`;
          const ownerJid = `${config.phoneNumber}@s.whatsapp.net`;
          await agentManager.createTask(targetJid, goal, ownerJid);
          // Send initial message via agent
          const ownerStyle = await mem.getOwnerStyle(targetJid);
          const styleTexts = ownerStyle.map(s => s.content);
          const history = await mem.getHistory(targetJid);
          const initialMsg = await generateReply(targetJid, `Start conversation with goal: ${goal}. Write first message to contact as owner would.`, history, styleTexts, null);
          await global.sockRef.sendMessage(targetJid, { text: initialMsg });
          await mem.addMessage(targetJid, 'assistant', initialMsg);
          started++;
          await new Promise(r => setTimeout(r, 3000)); // delay between
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
});

global.botStatus = 'starting';
global.sockRef = null;
validateConfig();

let sock = null;
let memory = null;
let auth = null;
let pairingCodeRequested = false;
let agentManager = null;

async function startBot() {
  try {
    console.log('\n' + '='.repeat(60));
    console.log('🚀 WhatsApp AI Bot - Ghost + Style + Import + Media + AGENT');
    console.log('='.repeat(60));
    memory = await getMemoryStore();
    auth = await createAuthState();
    agentManager = await getAgentManager(memory, null);
    const { version } = await fetchLatestBaileysVersion();
    console.log(`📦 Baileys version: ${version.join('.')}`);
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
            console.log(`\n📱 Requesting pairing code for ${config.phoneNumber}...`);
            const code = await sock.requestPairingCode(config.phoneNumber);
            console.log('\n' + '█'.repeat(60));
            console.log(`🔑 YOUR PAIRING CODE: ${code}`);
            console.log('█'.repeat(60));
            pairingCodeRequested = true;
          }
        } catch (err) {
          console.error('❌ Pairing code failed:', err.message);
          pairingCodeRequested = false;
          setTimeout(() => { if (!auth.state.creds.registered) startBot(); }, 10000);
        }
      }, 3000);
    }

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr && !config.phoneNumber) { qrcode.generate(qr, { small: true }); }
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log(`\n🔌 Closed. Status: ${statusCode}, Reason:`, lastDisconnect?.error?.message);
        global.botStatus = `disconnected-${statusCode}`;
        if (statusCode === DisconnectReason.loggedOut) {
          if (auth.clearState) await auth.clearState();
          return;
        }
        if (shouldReconnect) setTimeout(startBot, 5000);
      } else if (connection === 'open') {
        console.log('\n✅ Connected! Ghost + Style + Media + AGENT ON');
        console.log(`📞 As: ${sock.user?.id || 'unknown'}`);
        console.log(`📚 Import: /import | Agent: /agent`);
        global.botStatus = 'connected';
        pairingCodeRequested = false;
      } else if (connection === 'connecting') {
        console.log('⏳ Connecting...');
        global.botStatus = 'connecting';
      }
    });

    sock.ev.on('creds.update', auth.saveCreds);
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        try { await handleMessage(msg); } catch (err) { console.error('Error:', err); }
      }
    });

  } catch (err) {
    console.error('❌ Fatal:', err);
    global.botStatus = 'error';
    setTimeout(startBot, 10000);
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
  const { text: messageContent, mediaInfo } = await extractContent(msg);

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

  if (isFromMe && messageContent) {
    // Check agent command first
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
    return;
  }

  if (isFromMe) return;
  if (!messageContent && !mediaInfo) return;

  console.log(`\n📩 From ${contactName} (${jid}): ${messageContent?.slice(0,100)} ${mediaInfo ? `[${mediaInfo.type}]` : ''}`);

  // Check if this contact has active agent task
  const activeTask = await agentManager.getTask(jid);
  if (activeTask) {
    console.log(`🤖 Agent task active for ${jid}: ${activeTask.goal}`);
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
    if (mediaInfo && (mediaInfo.type === 'image' || mediaInfo.type === 'sticker')) {
      try {
        console.log(`📥 Downloading ${mediaInfo.type} for AI...`);
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
        const base64 = buffer.toString('base64');
        mediaForAI = { type: mediaInfo.type, base64, mimeType: mediaInfo.mimeType || (mediaInfo.type === 'sticker' ? 'image/webp' : 'image/jpeg'), caption: mediaInfo.caption || '', emoji: mediaInfo.emoji || '' };
        console.log(`✅ Downloaded ${mediaInfo.type}: ${buffer.length} bytes`);
      } catch (e) { console.error(`❌ Failed download ${mediaInfo.type}:`, e.message); }
    }

    const aiReply = await generateReply(jid, messageContent || historyText, history.slice(0, -1), ownerStyleTexts, mediaForAI);

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
  
  await sock.sendMessage(ownerJid, { text: `🤖 *Starting Agent*\n\nTargets: ${numbers.length} numbers\nGoal: ${goal}\n\nI will message them one by one and bring discussion to end. Reporting progress here...` });

  for (const num of numbers) {
    try {
      const targetJid = `${num}@s.whatsapp.net`;
      await agentManager.createTask(targetJid, goal, ownerJid);
      
      const ownerStyle = await memory.getOwnerStyle(targetJid);
      const styleTexts = ownerStyle.map(s => s.content);
      const history = await memory.getHistory(targetJid);
      
      // Generate initial message with goal
      const initialPrompt = `You need to start a conversation with this contact to achieve this goal: ${goal}. Write the first message as owner would, in their unique style with this person. Be natural, not robotic. Start conversation.`;
      const initialMsg = await generateReply(targetJid, initialPrompt, history, styleTexts, null);
      
      await delayRandom();
      await sock.sendMessage(targetJid, { text: initialMsg });
      await memory.addMessage(targetJid, 'assistant', initialMsg);
      
      // Update task history
      await agentManager.updateTask(targetJid, { 
        history: [{ role: 'assistant', content: initialMsg }],
        steps: 1
      });
      
      console.log(`🤖 Agent started for ${targetJid}: ${initialMsg.slice(0,80)}...`);
      started++;
      
      // Delay between multiple numbers to avoid ban (5-10 sec)
      if (numbers.length > 1) await delay(5000 + Math.random() * 5000);
      
    } catch (e) {
      console.error(`Agent failed for ${num}:`, e.message);
      failed++;
    }
  }
  
  await sock.sendMessage(ownerJid, { text: `🚀 *Agent Launched*\n\n✅ Started: ${started}\n❌ Failed: ${failed}\n\nI will chat with them and report back when goal is achieved. You can check active tasks with /status` });
}

async function handleAgentReply(jid, messageContent, mediaInfo, task) {
  try {
    const historyText = messageContent || (mediaInfo ? `[${mediaInfo.type}]` : '');
    await memory.addMessage(jid, 'user', historyText);
    
    task.history.push({ role: 'user', content: historyText });
    task.steps++;
    
    console.log(`🤖 Agent step ${task.steps} for ${jid}: ${historyText.slice(0,80)}...`);
    
    // Check if max steps reached
    if (task.steps >= task.maxSteps) {
      await agentManager.completeTask(jid, `Max steps (${task.maxSteps}) reached. Last message: ${historyText}`);
      return;
    }
    
    // Generate reply with goal context
    const history = await memory.getHistory(jid);
    const ownerStyle = await memory.getOwnerStyle(jid);
    const styleTexts = ownerStyle.map(s => s.content);
    
    const goalPrompt = `You are in an AGENT TASK. Your goal: ${task.goal}. You are chatting with ${jid.split('@')[0]}. Continue conversation to achieve goal. Current step ${task.steps}/${task.maxSteps}. Be owner, use unique style, be seamless. If goal achieved, say so naturally and wrap up.`;
    
    const fullHistory = [...history.slice(0, -1), { role: 'system', content: goalPrompt }];
    
    await sock.sendPresenceUpdate('composing', jid);
    await delayRandom();
    
    let mediaForAI = null;
    if (mediaInfo && (mediaInfo.type === 'image' || mediaInfo.type === 'sticker')) {
      try {
        const buffer = await downloadMediaMessage({ key: { remoteJid: jid }, message: { [mediaInfo.type + 'Message']: {} } }, 'buffer', {}, { logger: pino({ level: 'silent' }) }).catch(() => null);
        // For agent replies, we already have message, need to download from original msg - skip for simplicity in agent flow
      } catch {}
    }
    
    const aiReply = await generateReply(jid, messageContent || historyText, fullHistory, styleTexts, mediaForAI);
    
    await sock.sendMessage(jid, { text: aiReply });
    console.log(`🤖 Agent replied to ${jid}: ${aiReply.slice(0,100)}...`);
    
    await memory.addMessage(jid, 'assistant', aiReply);
    task.history.push({ role: 'assistant', content: aiReply });
    
    await agentManager.updateTask(jid, { history: task.history, steps: task.steps });
    
    // Check if goal achieved
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
  if (m.contactMessage) return { text: `[Contact: ${m.contactMessage.displayName}]`, mediaInfo: null };
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
      if (!cmd.target) { await sock.sendMessage(sendTo, { text: 'Usage: /clear 2348012345678' }); return; }
      const targetJid = `${cmd.target}@s.whatsapp.net`;
      await memory.clearHistory(targetJid);
      await sock.sendMessage(sendTo, { text: `🗑️ History cleared for ${cmd.target}` });
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
      await sock.sendMessage(sendTo, { text: `📊 *Bot Status - AGENT MODE*\n\n• Status: ${global.botStatus}\n• Uptime: ${hours}h ${mins}m\n• Model: ${config.geminiModel}\n• Learned: ${styleCount} contacts\n• Active agent tasks: ${agentTasks.length}\n• Media: Images, Stickers, Voice, Video ✅\n• AI Chain: ${[config.geminiApiKey?'Gemini':null, config.groqApiKey?'Groq':null, config.openrouterApiKey?'OpenRouter':null, config.cerebrasApiKey?'Cerebras':null, config.githubToken?'GitHub':null].filter(Boolean).join(' → ')}\n• Connected: ${sock?.user ? 'Yes' : 'No'}\n\n🤖 Agent: Message yourself /agent number | Goal: ...\n📚 Import: /import` });
      break;
    }
    case 'help': {
      await sock.sendMessage(sendTo, { text: getOwnerHelpText() + '\n\n🤖 AGENT MODE:\n/agent 234... | Goal: your goal\n/agent 234...,234... | Goal: broadcast\n\nBot will go message them and bring discussion to end, report back to you!' });
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

process.on('SIGINT', async () => {
  console.log('\n👋 Shutting down...');
  if (sock) await sock.end();
  server.close();
  process.exit(0);
});
process.on('uncaughtException', (err) => { console.error('Uncaught:', err); });
process.on('unhandledRejection', (err) => { console.error('Unhandled:', err); });

startBot();
