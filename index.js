import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import http from 'http';
import { config, validateConfig } from './config.js';
import { createAuthState } from './auth.js';
import { getMemoryStore } from './memory.js';
import { generateReply, isHandoffRequest, parseOwnerCommand, getOwnerHelpText } from './ai.js';

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime(), bot: global.botStatus || 'starting', timestamp: new Date().toISOString() }));
  } else { res.writeHead(404); res.end('Not found'); }
});
server.listen(config.port, '0.0.0.0', () => {
  console.log(`🌐 Health server listening on 0.0.0.0:${config.port}`);
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
    console.log('🚀 Starting WhatsApp AI Bot - Ghost Mode + Style Learning');
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
            console.log('\n📲 WhatsApp → Settings → Linked Devices → Link a Device → Link with phone number instead');
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
        console.log('\n📷 Scan QR: Settings → Linked Devices → Link a Device\n');
        qrcode.generate(qr, { small: true });
      }
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log(`\n🔌 Connection closed. Status: ${statusCode}, Reason:`, lastDisconnect?.error?.message);
        global.botStatus = `disconnected-${statusCode}`;
        if (statusCode === DisconnectReason.loggedOut) {
          console.log('❌ Logged out - delete Redis baileys:* keys and relink');
          if (auth.clearState) await auth.clearState();
          return;
        }
        if (shouldReconnect) {
          console.log('🔄 Reconnecting in 5 seconds...');
          setTimeout(startBot, 5000);
        }
      } else if (connection === 'open') {
        console.log('\n✅ WhatsApp connected! Bot active - Ghost mode + Style learning ON');
        console.log(`📞 Connected as: ${sock.user?.id || 'unknown'}`);
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
        try { await handleMessage(msg); } catch (err) { console.error('Error handling:', err); }
      }
    });

  } catch (err) {
    console.error('❌ Fatal error:', err);
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
  if (!messageContent && !isFromMe) return;

  const contactName = msg.pushName || jid.split('@')[0];

  // OWNER MESSAGES - LEARN YOUR STYLE PER CONTACT (KEY FOR SEAMLESS MIMICRY)
  if (isFromMe && messageContent) {
    const cmd = parseOwnerCommand(messageContent);
    if (cmd) {
      await handleOwnerCommand(cmd, jid);
      return;
    }
    // This is YOU chatting - bot learns your unique style with THIS person
    if (messageContent && !messageContent.startsWith('/')) {
      await memory.addOwnerMessage(jid, messageContent);
      // Also save to history as assistant (so bot knows what you said)
      await memory.addMessage(jid, 'assistant', messageContent);
      console.log(`📝 Learned YOUR style for ${contactName}: "${messageContent.slice(0,50)}..."`);
    }
    return;
  }

  if (isFromMe) return;

  console.log(`\n📩 From ${contactName} (${jid}): ${messageContent?.slice(0,100)}`);

  if (await memory.isHandoff(jid)) {
    console.log(`⏸️ Paused for ${jid} - storing only`);
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
    console.log(`🙋 Handoff requested by ${jid}`);
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
    const ownerStyle = await memory.getOwnerStyle(jid); // LEARNED STYLE PER CONTACT
    const ownerStyleTexts = ownerStyle.map(s => s.content);

    console.log(`🎭 Style samples for ${contactName}: ${ownerStyleTexts.length} messages`);

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
      await sock.sendMessage(sendTo, { text: `⏸️ Paused for ${cmd.target} for ${config.handoffMinutes} mins` });
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
      if (!cmd.target) { await sock.sendMessage(sendTo, { text: 'Usage: /style 2348012345678 to see learned style' }); return; }
      const targetJid = `${cmd.target}@s.whatsapp.net`;
      const samples = await memory.getOwnerStyle(targetJid);
      if (samples.length === 0) {
        await sock.sendMessage(sendTo, { text: `No style learned yet for ${cmd.target}. Chat with them normally, I will learn!` });
      } else {
        const preview = samples.slice(-10).map(s => `• ${s.content}`).join('\n');
        await sock.sendMessage(sendTo, { text: `🎭 Learned style for ${cmd.target} (${samples.length} samples):\n\n${preview}` });
      }
      break;
    }
    case 'status': {
      const uptime = Math.floor(process.uptime());
      const hours = Math.floor(uptime / 3600);
      const mins = Math.floor((uptime % 3600) / 60);
      const styleCount = await memory.getAllOwnerStylesCount();
      await sock.sendMessage(sendTo, { 
        text: `📊 *Bot Status - Ghost Mode*\n\n• Status: ${global.botStatus}\n• Uptime: ${hours}h ${mins}m\n• Model: ${config.geminiModel}\n• Storage: ${memory.isRedis ? 'Redis' : 'Local'}\n• Learned contacts: ${styleCount} people\n• Rate limit: ${config.maxPerHour}/hour\n• Connected: ${sock?.user ? 'Yes' : 'No'}\n\nBot is learning your unique chat style per person!` 
      });
      break;
    }
    case 'help': {
      await sock.sendMessage(sendTo, { text: getOwnerHelpText() });
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
