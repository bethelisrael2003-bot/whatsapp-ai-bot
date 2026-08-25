import makeWASocket, { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import http from 'http';
import { config, validateConfig } from './config.js';
import { createAuthState } from './auth.js';
import { getMemoryStore } from './memory.js';
import { generateReply, isHandoffRequest, parseOwnerCommand, getOwnerHelpText } from './ai.js';

// Keep Render free web service alive + health check
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'ok', 
      uptime: process.uptime(),
      bot: global.botStatus || 'starting',
      timestamp: new Date().toISOString()
    }));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
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
    console.log('🚀 Starting WhatsApp AI Bot...');
    console.log('='.repeat(60));

    memory = await getMemoryStore();
    auth = await createAuthState();
    
    const { version } = await fetchLatestBaileysVersion();
    console.log(`📦 Baileys version: ${version.join('.')}`);

    const logger = pino({ level: 'silent' }); // set to 'info' for debugging

    sock = makeWASocket({
      version,
      auth: auth.state,
      logger,
      printQRInTerminal: false, // we handle pairing code ourselves
      browser: ['Ubuntu', 'Chrome', '20.0.04'],
      syncFullHistory: false,
      markOnlineOnConnect: true,
      generateHighQualityLinkPreview: false,
      // For stability
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
    });

    // Handle pairing code login if not registered
    if (!auth.state.creds.registered && config.phoneNumber && !pairingCodeRequested) {
      // Wait a bit for socket to initialize
      setTimeout(async () => {
        try {
          if (!auth.state.creds.registered) {
            console.log(`\n📱 Requesting pairing code for ${config.phoneNumber}...`);
            const code = await sock.requestPairingCode(config.phoneNumber);
            console.log('\n' + '█'.repeat(60));
            console.log(`🔑 YOUR PAIRING CODE: ${code}`);
            console.log('█'.repeat(60));
            console.log('\n📲 How to link:');
            console.log('1. Open WhatsApp on your phone');
            console.log('2. Settings → Linked Devices → Link a Device');
            console.log('3. Tap "Link with phone number instead" (bottom)');
            console.log(`4. Enter code: ${code}`);
            console.log('\n⏳ Code expires in ~60 seconds. If expired, restart service to get new code.');
            console.log('💡 Check Render Logs page on your phone browser to see this code!\n');
            pairingCodeRequested = true;
          }
        } catch (err) {
          console.error('❌ Failed to request pairing code:', err.message);
          console.log('Retrying in 10 seconds...');
          pairingCodeRequested = false;
          setTimeout(() => { if (!auth.state.creds.registered) startBot(); }, 10000);
        }
      }, 3000);
    } else if (!auth.state.creds.registered && !config.phoneNumber) {
      console.log('\n📷 No PHONE_NUMBER set, falling back to QR code...');
      console.log('Set PHONE_NUMBER env var (e.g. 2348012345678) to use pairing code instead.');
    }

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && !config.phoneNumber) {
        console.log('\n📷 Scan this QR code in WhatsApp: Settings → Linked Devices → Link a Device\n');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        
        console.log(`\n🔌 Connection closed. Status: ${statusCode}, Reason:`, lastDisconnect?.error?.message);
        global.botStatus = `disconnected-${statusCode}`;

        if (statusCode === DisconnectReason.loggedOut) {
          console.log('❌ Logged out - clearing auth and need to relink!');
          console.log('Delete Redis keys or auth_info folder and restart, then use new pairing code.');
          if (auth.clearState) await auth.clearState();
          // Don't auto-reconnect on logout, wait for manual fix
          return;
        }

        if (shouldReconnect) {
          console.log('🔄 Reconnecting in 5 seconds... (session saved, no rescan needed if Redis is set)');
          setTimeout(startBot, 5000);
        }
      } else if (connection === 'open') {
        console.log('\n✅ WhatsApp connected successfully! Bot is now active.');
        console.log(`📞 Connected as: ${sock.user?.id || 'unknown'}`);
        global.botStatus = 'connected';
        pairingCodeRequested = false;
      } else if (connection === 'connecting') {
        console.log('⏳ Connecting to WhatsApp...');
        global.botStatus = 'connecting';
      }
    });

    sock.ev.on('creds.update', auth.saveCreds);

    // Main message handler
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      for (const msg of messages) {
        try {
          await handleMessage(msg);
        } catch (err) {
          console.error('Error handling message:', err);
        }
      }
    });

    // Optional: handle calls? ignore for now

  } catch (err) {
    console.error('❌ Fatal error starting bot:', err);
    global.botStatus = 'error';
    console.log('🔄 Retrying in 10 seconds...');
    setTimeout(startBot, 10000);
  }
}

async function handleMessage(msg) {
  const jid = msg.key.remoteJid;
  if (!jid) return;

  // Ignore status broadcasts and newsletter
  if (jid === 'status@broadcast' || jid.includes('@newsletter')) return;

  // Ignore groups if configured
  if (config.ignoreGroups && jid.endsWith('@g.us')) {
    // Optionally log but don't reply
    return;
  }

  const isFromMe = msg.key.fromMe;
  const messageContent = extractMessageText(msg);
  
  if (!messageContent && !isFromMe) {
    // Might be image without caption, etc. - ignore for now or handle later
    return;
  }

  const contactName = msg.pushName || jid.split('@')[0];
  const isGroup = jid.endsWith('@g.us');

  // Handle owner commands (messages you send from your phone)
  if (isFromMe && messageContent) {
    const cmd = parseOwnerCommand(messageContent);
    if (cmd) {
      await handleOwnerCommand(cmd, jid);
      // Still save your message to history so bot remembers you intervened
      if (!cmd.target || cmd.action === 'status' || cmd.action === 'help') {
        // Don't save command messages to history of random chats
      } else {
        const targetJid = cmd.target.includes('@') ? cmd.target : `${cmd.target}@s.whatsapp.net`;
        if (cmd.action === 'pause') {
          await memory.setHandoff(targetJid, config.handoffMinutes);
          await sock.sendMessage(jid, { text: `⏸️ Bot paused for ${cmd.target} for ${config.handoffMinutes} min` });
        }
      }
      return;
    }
    // If it's fromMe but not a command, save it to memory as assistant or user? Save as user (owner speaking)
    // This helps bot remember what owner said
    if (messageContent && !messageContent.startsWith('/')) {
      await memory.addMessage(jid, 'user', `[Owner said]: ${messageContent}`);
      console.log(`📝 Saved owner message to ${jid}: ${messageContent.slice(0, 50)}...`);
    }
    return; // Don't auto-reply to your own messages
  }

  // Only process incoming messages from others
  if (isFromMe) return;

  console.log(`\n📩 Message from ${contactName} (${jid}): ${messageContent?.slice(0, 100)}`);

  // Check handoff state - if paused, do not reply, just store
  if (await memory.isHandoff(jid)) {
    console.log(`⏸️ Bot paused for ${jid} (handoff active) - storing message only`);
    await memory.addMessage(jid, 'user', messageContent);
    return;
  }

  // Check rate limit
  if (await memory.isRateLimited(jid)) {
    const count = await memory.getRateLimitCount(jid);
    console.log(`🚦 Rate limited ${jid}: ${count} messages/hour`);
    // Optionally send a polite rate limit message once
    if (count === config.maxPerHour + 1) {
      await delay(1000);
      await sock.sendMessage(jid, { text: "I'm getting lots of messages — I'll reply properly in a bit! 🙏" });
    }
    return;
  }

  // Check for handoff request from contact
  if (isHandoffRequest(messageContent)) {
    console.log(`🙋 Handoff requested by ${jid}`);
    await memory.setHandoff(jid, config.handoffMinutes);
    await memory.addMessage(jid, 'user', messageContent);
    await delayRandom();
    await sock.sendMessage(jid, { 
      text: `Got it — handing over to a human now. They'll reply here shortly! 🙏\n\n_Bot paused for ${config.handoffMinutes} minutes._` 
    });
    await memory.addMessage(jid, 'assistant', 'Handoff to human initiated');
    return;
  }

  // Normal AI reply flow
  try {
    await memory.addMessage(jid, 'user', messageContent);
    const history = await memory.getHistory(jid);

    // Show typing indicator
    await sock.sendPresenceUpdate('composing', jid);
    
    // Random delay 1-4 sec to seem human
    await delayRandom();

    const aiReply = await generateReply(jid, messageContent, history.slice(0, -1)); // history without latest which we already added

    // Send reply
    await sock.sendMessage(jid, { text: aiReply });
    console.log(`🤖 Replied to ${contactName}: ${aiReply.slice(0, 100)}...`);

    await memory.addMessage(jid, 'assistant', aiReply);
    
    await sock.sendPresenceUpdate('paused', jid);

  } catch (err) {
    console.error(`Error replying to ${jid}:`, err);
    try {
      await sock.sendMessage(jid, { text: "Sorry, I had a small hiccup — could you try again? 😅" });
    } catch {}
  }
}

function extractMessageText(msg) {
  const m = msg.message;
  if (!m) return '';

  // Handle different message types
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage?.caption) return m.imageMessage.caption;
  if (m.videoMessage?.caption) return m.videoMessage.caption;
  if (m.documentMessage?.caption) return m.documentMessage.caption;
  if (m.buttonsResponseMessage?.selectedButtonId) return m.buttonsResponseMessage.selectedButtonId;
  if (m.listResponseMessage?.singleSelectReply?.selectedRowId) return m.listResponseMessage.title || m.listResponseMessage.singleSelectReply.selectedRowId;
  if (m.templateButtonReplyMessage?.selectedId) return m.templateButtonReplyMessage.selectedId;
  if (m.reactionMessage?.text) return ''; // ignore reactions
  if (m.protocolMessage) return ''; // ignore protocol messages
  
  // For view once etc
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

  const sendTo = currentJid; // reply where command was sent

  switch (cmd.action) {
    case 'pause': {
      if (!cmd.target) {
        await sock.sendMessage(sendTo, { text: 'Usage: /pause 2348012345678' });
        return;
      }
      const targetJid = `${cmd.target}@s.whatsapp.net`;
      await memory.setHandoff(targetJid, config.handoffMinutes);
      await sock.sendMessage(sendTo, { text: `⏸️ Bot paused for ${cmd.target} for ${config.handoffMinutes} minutes. Use /resume ${cmd.target} to resume.` });
      break;
    }
    case 'resume': {
      if (!cmd.target) {
        await sock.sendMessage(sendTo, { text: 'Usage: /resume 2348012345678 or /resume all' });
        return;
      }
      const targetJid = `${cmd.target}@s.whatsapp.net`;
      await memory.clearHandoff(targetJid);
      await sock.sendMessage(sendTo, { text: `▶️ Bot resumed for ${cmd.target}` });
      break;
    }
    case 'resumeAll': {
      await memory.clearAllHandoffs();
      // Also clear local files if any
      if (!memory.isRedis) {
        // brute force clear handoff files
        const fs = await import('fs');
        const path = await import('path');
        const dir = './memory_store';
        if (fs.existsSync(dir)) {
          fs.readdirSync(dir).forEach(f => {
            if (f.includes('_handoff')) fs.unlinkSync(path.join(dir, f));
          });
        }
      }
      await sock.sendMessage(sendTo, { text: '▶️ Bot resumed for ALL contacts' });
      break;
    }
    case 'clear': {
      if (!cmd.target) {
        await sock.sendMessage(sendTo, { text: 'Usage: /clear 2348012345678' });
        return;
      }
      const targetJid = `${cmd.target}@s.whatsapp.net`;
      await memory.clearHistory(targetJid);
      await sock.sendMessage(sendTo, { text: `🗑️ History cleared for ${cmd.target}` });
      break;
    }
    case 'status': {
      const uptime = Math.floor(process.uptime());
      const hours = Math.floor(uptime / 3600);
      const mins = Math.floor((uptime % 3600) / 60);
      await sock.sendMessage(sendTo, { 
        text: `📊 *Bot Status*\n\n` +
              `• Status: ${global.botStatus}\n` +
              `• Uptime: ${hours}h ${mins}m\n` +
              `• Model: ${config.geminiModel}\n` +
              `• Storage: ${memory.isRedis ? 'Redis (persistent)' : 'Local (not persistent!)'}\n` +
              `• Groups ignored: ${config.ignoreGroups}\n` +
              `• Rate limit: ${config.maxPerHour}/hour per contact\n` +
              `• Connected: ${sock?.user ? 'Yes as ' + sock.user.id : 'No'}` 
      });
      break;
    }
    case 'help': {
      await sock.sendMessage(sendTo, { text: getOwnerHelpText() });
      break;
    }
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function delayRandom() {
  const min = config.replyDelayMin;
  const max = config.replyDelayMax;
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return delay(ms);
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n👋 Shutting down...');
  if (sock) await sock.end();
  server.close();
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
});

// Start!
startBot();
