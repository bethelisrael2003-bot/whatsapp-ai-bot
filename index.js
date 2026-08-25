import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import http from 'http';
import { config, validateConfig } from './config.js';
import { createAuthState } from './auth.js';
import { getMemoryStore } from './memory.js';
import { generateReply, isHandoffRequest, parseOwnerCommand, getOwnerHelpText } from './ai.js';
import { extractOwnerStyleFromExport } from './import.js';

// HTTP server with health + import UI
const server = http.createServer(async (req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime(), bot: global.botStatus || 'starting', timestamp: new Date().toISOString() }));
  } else if (req.url === '/import' && req.method === 'GET') {
    // Simple UI to paste old chats and import
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
<!DOCTYPE html>
<html>
<head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Import Old Chats - WhatsApp Bot</title>
<style>body{font-family:system-ui;padding:20px;max-width:700px;margin:auto;background:#f5f5f5} .card{background:white;padding:20px;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.1);margin-bottom:20px} textarea{width:100%;height:300px;padding:12px;border:1px solid #ddd;border-radius:8px;font-family:monospace;font-size:13px} input,button{padding:12px;border-radius:8px;border:1px solid #ddd;margin:5px 0;width:100%} button{background:#25D366;color:white;border:none;font-weight:bold;cursor:pointer} button:hover{background:#128C7E} .info{background:#e8f5e9;padding:12px;border-radius:8px;margin:10px 0;font-size:14px}</style>
</head>
<body>
<h2>📚 Import Old WhatsApp Chats</h2>
<div class="card">
<div class="info">
<b>How to export old chats from WhatsApp:</b><br>
1. Open WhatsApp → Open chat with person<br>
2. Tap 3 dots → More → Export chat → <b>Without media</b><br>
3. Send the .txt file to yourself, copy its content<br>
4. Paste below and import - bot will learn your style!
</div>
<label>Contact's WhatsApp number (e.g. 2348012345678):</label>
<input id="jid" placeholder="2348012345678" />
<label>Your name as it appears in export (e.g. You, or your name):</label>
<input id="ownerName" placeholder="You" value="You" />
<label>Paste exported chat .txt content:</label>
<textarea id="chatText" placeholder="12/08/2024, 12:39 - Boss Emma: Hello\n12/08/2024, 12:40 - You: Omo how far..."></textarea>
<button onclick="importChat()">📥 Import & Learn Style</button>
<div id="result" style="margin-top:15px"></div>
</div>
<div class="card">
<h3>📊 Learned Styles</h3>
<button onclick="loadStats()">Refresh Stats</button>
<div id="stats"></div>
</div>
<script>
async function importChat(){
  const jid = document.getElementById('jid').value.trim();
  const ownerName = document.getElementById('ownerName').value.trim() || 'You';
  const chatText = document.getElementById('chatText').value.trim();
  if(!jid || !chatText){ alert('Enter number and chat content'); return; }
  document.getElementById('result').innerHTML = '⏳ Importing...';
  try{
    const res = await fetch('/import', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ jid, ownerName, chatText }) });
    const data = await res.json();
    document.getElementById('result').innerHTML = '<div style=\"background:#e8f5e9;padding:12px;border-radius:8px\">✅ ' + data.message + '<br>Learned ' + data.learned + ' messages from you for ' + jid + '</div>';
  }catch(e){ document.getElementById('result').innerHTML = '❌ Error: ' + e.message; }
}
async function loadStats(){
  document.getElementById('stats').innerHTML = '⏳ Loading...';
  try{
    const res = await fetch('/stats');
    const data = await res.json();
    let html = '<p>Total contacts learned: ' + data.totalContacts + '</p>';
    for(const c of data.contacts){
      html += '<div style=\"border:1px solid #eee;padding:10px;margin:5px 0;border-radius:8px\"><b>' + c.jid + '</b> - ' + c.count + ' samples<br><small>' + (c.preview||'').slice(0,100) + '</small></div>';
    }
    document.getElementById('stats').innerHTML = html;
  }catch(e){ document.getElementById('stats').innerHTML = 'Error: ' + e.message; }
}
loadStats();
</script>
</body>
</html>
    `);
  } else if (req.url === '/import' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { jid, ownerName, chatText } = JSON.parse(body);
        if (!jid || !chatText) throw new Error('Missing jid or chatText');
        
        const mem = await getMemoryStore();
        const result = extractOwnerStyleFromExport(chatText, [ownerName, 'You']);
        
        // Import owner style samples for this contact
        const targetJid = jid.includes('@') ? jid : `${jid.replace(/[^0-9]/g,'')}@s.whatsapp.net`;
        let learned = 0;
        for (const sample of result.styleSamples) {
          await mem.addOwnerMessage(targetJid, sample);
          learned++;
        }
        // Also import conversation history
        for (const msg of result.conversation.slice(-20)) {
          await mem.addMessage(targetJid, msg.role, msg.content);
        }
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          success: true, 
          message: `Imported ${result.totalMessages} total messages (${result.ownerCount} from you, ${result.contactCount} from contact). Now bot knows your style!`,
          learned,
          contact: result.contactName
        }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
  } else if (req.url === '/stats') {
    try {
      const mem = await getMemoryStore();
      // Get all owner style keys
      let contacts = [];
      if (mem.isRedis && mem.redis && typeof mem.redis.keys === 'function') {
        const keys = await mem.redis.keys('owner:style:*');
        for (const key of keys.slice(0,20)) {
          const jid = key.replace('owner:style:', '');
          const samples = await mem.getOwnerStyle(jid);
          contacts.push({ jid, count: samples.length, preview: samples[0]?.content || '' });
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ totalContacts: contacts.length, contacts }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  } else {
    res.writeHead(404); res.end('Not found');
  }
});

server.listen(config.port, '0.0.0.0', () => {
  console.log(`🌐 Health server listening on 0.0.0.0:${config.port}`);
  console.log(`📚 Import UI available at /import`);
});

global.botStatus = 'starting';
validateConfig();

let sock = null;
let memory = null;
let auth = null;
let pairingCodeRequested = false;

async function startBot() {
  try {
    console.log('\n' + '='.repeat(60));
    console.log('🚀 WhatsApp AI Bot - Ghost Mode + Style Learning + History Import');
    console.log('='.repeat(60));

    memory = await getMemoryStore();
    auth = await createAuthState();
    const { version } = await fetchLatestBaileysVersion();
    console.log(`📦 Baileys version: ${version.join('.')}`);

    const logger = pino({ level: 'silent' });
    sock = makeWASocket({
      version,
      auth: auth.state,
      logger,
      printQRInTerminal: false,
      browser: ['Ubuntu', 'Chrome', '20.0.04'],
      syncFullHistory: false,
      markOnlineOnConnect: true,
      generateHighQualityLinkPreview: false,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
    });

    if (!auth.state.creds.registered && config.phoneNumber && !pairingCodeRequested) {
      setTimeout(async () => {
        try {
          if (!auth.state.creds.registered) {
            console.log(`\n📱 Requesting pairing code for ${config.phoneNumber}...`);
            const code = await sock.requestPairingCode(config.phoneNumber);
            console.log('\n' + '█'.repeat(60));
            console.log(`🔑 YOUR PAIRING CODE: ${code}`);
            console.log('█'.repeat(60));
            console.log(`Enter code: ${code}\n`);
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
      if (qr && !config.phoneNumber) {
        console.log('\n📷 Scan QR\n');
        qrcode.generate(qr, { small: true });
      }
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log(`\n🔌 Closed. Status: ${statusCode}, Reason:`, lastDisconnect?.error?.message);
        global.botStatus = `disconnected-${statusCode}`;
        if (statusCode === DisconnectReason.loggedOut) {
          console.log('❌ Logged out - delete Redis baileys:* keys and relink');
          if (auth.clearState) await auth.clearState();
          return;
        }
        if (shouldReconnect) {
          console.log('🔄 Reconnecting in 5s...');
          setTimeout(startBot, 5000);
        }
      } else if (connection === 'open') {
        console.log('\n✅ Connected! Ghost mode + Style learning + Import UI ON');
        console.log(`📞 As: ${sock.user?.id || 'unknown'}`);
        console.log(`📚 Import old chats at: https://YOUR-RENDER-URL.onrender.com/import`);
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
  const messageContent = extractMessageText(msg);
  const isDocument = !!msg.message?.documentMessage;
  const contactName = msg.pushName || jid.split('@')[0];

  // Handle document upload from owner - for importing old chat exports
  if (isFromMe && isDocument) {
    try {
      const doc = msg.message.documentMessage;
      const fileName = doc.fileName || '';
      console.log(`📄 Document from owner: ${fileName}, mimetype: ${doc.mimetype}`);
      
      if (fileName.endsWith('.txt') || doc.mimetype === 'text/plain') {
        console.log('📚 Detected chat export .txt, downloading...');
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage });
        const text = buffer.toString('utf-8');
        
        // Try to parse as WhatsApp export
        const result = extractOwnerStyleFromExport(text, ['You', contactName, '']);
        console.log(`📚 Parsed export: ${result.totalMessages} msgs, ${result.ownerCount} from owner`);
        
        if (result.styleSamples.length > 0) {
          // If this document was sent in a chat with someone, learn for that contact
          // Or if sent to self, we need to guess contact from export
          const targetJid = jid; // if sent to self, we need contact from export, but for now use current chat
          // Actually if sent to self (your own chat), we should try to import for contact in export
          // For simplicity, if sent in a chat with person, learn for that person
          // If sent to self, use contact name from export to create JID? We can't guess JID, so ask user to specify via /import command
          
          let imported = 0;
          for (const sample of result.styleSamples) {
            await memory.addOwnerMessage(jid, sample);
            imported++;
          }
          await sock.sendMessage(jid, { text: `✅ Imported ${imported} messages from your old chat with ${result.contactName}!\n\nNow I know how you chat with them. Total style samples: ${imported}\n\nFor better import with number, use: https://YOUR-RENDER-URL.onrender.com/import` });
          console.log(`✅ Imported ${imported} style samples for ${jid}`);
          return;
        }
      }
    } catch (e) {
      console.error('Document import error:', e.message);
    }
  }

  if (isFromMe && messageContent) {
    const cmd = parseOwnerCommand(messageContent);
    if (cmd) {
      await handleOwnerCommand(cmd, jid);
      return;
    }
    if (messageContent && !messageContent.startsWith('/')) {
      await memory.addOwnerMessage(jid, messageContent);
      await memory.addMessage(jid, 'assistant', messageContent);
      console.log(`📝 Learned YOUR style for ${contactName}: "${messageContent.slice(0,50)}..."`);
    }
    return;
  }

  if (isFromMe) return;
  if (!messageContent) return;

  console.log(`\n📩 From ${contactName} (${jid}): ${messageContent?.slice(0,100)}`);

  if (await memory.isHandoff(jid)) {
    console.log(`⏸️ Paused for ${jid}`);
    await memory.addMessage(jid, 'user', messageContent);
    return;
  }

  if (await memory.isRateLimited(jid)) {
    const count = await memory.getRateLimitCount(jid);
    console.log(`🚦 Rate limited ${jid}: ${count}/hour`);
    if (count === config.maxPerHour + 1) {
      await delay(1000);
      await sock.sendMessage(jid, { text: "Network dey slow small, I go reply you now 🙏" });
    }
    return;
  }

  if (isHandoffRequest(messageContent)) {
    console.log(`🙋 Handoff by ${jid}`);
    await memory.setHandoff(jid, config.handoffMinutes);
    await memory.addMessage(jid, 'user', messageContent);
    await delayRandom();
    await sock.sendMessage(jid, { text: `No wahala, make I call you back now now 🙏\n\n_Bot paused for ${config.handoffMinutes} mins_` });
    await memory.addMessage(jid, 'assistant', 'Handoff');
    return;
  }

  try {
    await memory.addMessage(jid, 'user', messageContent);
    const history = await memory.getHistory(jid);
    const ownerStyle = await memory.getOwnerStyle(jid);
    const ownerStyleTexts = ownerStyle.map(s => s.content);
    console.log(`🎭 Style samples for ${contactName}: ${ownerStyleTexts.length}`);

    await sock.sendPresenceUpdate('composing', jid);
    await delayRandom();

    const aiReply = await generateReply(jid, messageContent, history.slice(0, -1), ownerStyleTexts);

    await sock.sendMessage(jid, { text: aiReply });
    console.log(`🤖 Replied as YOU to ${contactName}: ${aiReply.slice(0,100)}...`);
    await memory.addMessage(jid, 'assistant', aiReply);
    await sock.sendPresenceUpdate('paused', jid);

  } catch (err) {
    console.error(`Error replying to ${jid}:`, err);
    try { await sock.sendMessage(jid, { text: "Omo network dey worry, I go reply you now 🙏" }); } catch {}
  }
}

function extractMessageText(msg) {
  const m = msg.message;
  if (!m) return '';
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage?.caption) return m.imageMessage.caption;
  if (m.videoMessage?.caption) return m.videoMessage.caption;
  if (m.documentMessage?.caption) return m.documentMessage.caption;
  if (m.buttonsResponseMessage?.selectedButtonId) return m.buttonsResponseMessage.selectedButtonId;
  if (m.listResponseMessage?.singleSelectReply?.selectedRowId) return m.listResponseMessage.title || m.listResponseMessage.singleSelectReply.selectedRowId;
  if (m.templateButtonReplyMessage?.selectedId) return m.templateButtonReplyMessage.selectedId;
  if (m.reactionMessage?.text) return '';
  if (m.protocolMessage) return '';
  if (m.viewOnceMessageV2?.message) {
    const inner = m.viewOnceMessageV2.message;
    if (inner.imageMessage?.caption) return inner.imageMessage.caption;
    if (inner.videoMessage?.caption) return inner.videoMessage.caption;
    if (inner.extendedTextMessage?.text) return inner.extendedTextMessage.text;
  }
  return '';
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
      if (samples.length === 0) {
        await sock.sendMessage(sendTo, { text: `No style learned yet for ${cmd.target}. Chat normally or import old chats at /import` });
      } else {
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
      await sock.sendMessage(sendTo, { 
        text: `📊 *Bot Status - Ghost + Import*\n\n• Status: ${global.botStatus}\n• Uptime: ${hours}h ${mins}m\n• Model: ${config.geminiModel}\n• Learned contacts: ${styleCount}\n• Connected: ${sock?.user ? 'Yes' : 'No'}\n\n📚 Import old chats: https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'YOUR-URL'}/import\n\nBot learns your style per person!` 
      });
      break;
    }
    case 'help': {
      await sock.sendMessage(sendTo, { text: getOwnerHelpText() + '\n\n📚 Import old chats: /import page' });
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
