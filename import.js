/**
 * WhatsApp Chat Export Parser
 * Parses WhatsApp's "Export chat" .txt format to learn owner's style
 * Format: 12/08/2024, 12:39 - Boss Emma: Message
 *         25/08/2026, 23:20 - You: Hi Boss how far
 */

export function parseWhatsAppExport(text, ownerIdentifiers = []) {
  // ownerIdentifiers: names that represent YOU in export (e.g., "You", "Full Blooded shrine", your phone number name)
  // WhatsApp export uses your contact name or "You"
  const lines = text.split('\n');
  const messages = [];
  
  // Regex for WhatsApp export: date, time - name: message
  // Supports both 12/08/2024 and 12/08/24 formats
  const regex = /^(\d{1,2}\/\d{1,2}\/\d{2,4}),?\s+(\d{1,2}:\d{2}(?:\s*[AP]M)?)\s*-\s*([^:]+):\s*(.*)$/i;
  
  let currentMsg = null;
  
  for (let line of lines) {
    line = line.trim();
    if (!line) continue;
    
    // Skip system messages
    if (line.includes('Messages and calls are end-to-end encrypted') || 
        line.includes('created group') ||
        line.includes('added you') ||
        line.includes('changed the subject')) continue;
    
    const match = line.match(regex);
    if (match) {
      // New message
      if (currentMsg) messages.push(currentMsg);
      
      const [, date, time, sender, content] = match;
      // Skip if content is <Media omitted> or deleted
      if (content.includes('<Media omitted>') || content.includes('This message was deleted') || content.includes('image omitted')) {
        currentMsg = null;
        continue;
      }
      
      currentMsg = {
        date: date.trim(),
        time: time.trim(),
        sender: sender.trim(),
        content: content.trim(),
        timestamp: parseDate(date, time)
      };
    } else {
      // Continuation of previous message (multiline)
      if (currentMsg) {
        currentMsg.content += '\n' + line;
      }
    }
  }
  if (currentMsg) messages.push(currentMsg);
  
  // Separate owner vs contact messages
  const ownerMessages = [];
  const contactMessages = [];
  const contacts = new Set();
  
  for (const msg of messages) {
    const senderLower = msg.sender.toLowerCase();
    const isOwner = ownerIdentifiers.some(id => senderLower.includes(id.toLowerCase())) || 
                    senderLower === 'you' ||
                    senderLower.includes('you');
    
    if (isOwner) {
      ownerMessages.push(msg);
    } else {
      contactMessages.push(msg);
      contacts.add(msg.sender);
    }
  }
  
  return {
    all: messages,
    owner: ownerMessages,
    contact: contactMessages,
    contacts: Array.from(contacts),
    total: messages.length
  };
}

function parseDate(dateStr, timeStr) {
  try {
    // Try to parse dd/mm/yyyy and time
    const [d, m, y] = dateStr.split('/').map(Number);
    const year = y < 100 ? 2000 + y : y;
    // Simple timestamp
    return new Date(year, m-1, d).getTime();
  } catch {
    return Date.now();
  }
}

/**
 * Group owner messages by contact for per-contact style learning
 * WhatsApp export is per-chat, so all messages in file are with ONE contact
 * We return owner messages as style samples for that contact
 */
export function extractOwnerStyleFromExport(text, ownerIdentifiers = []) {
  const parsed = parseWhatsAppExport(text, ownerIdentifiers);
  
  // Owner messages are the style to learn
  const styleSamples = parsed.owner.map(m => m.content).filter(c => c.length > 0 && c.length < 500);
  
  // Also get conversation flow for context
  const conversation = parsed.all.slice(-30).map(m => ({
    role: ownerIdentifiers.some(id => m.sender.toLowerCase().includes(id.toLowerCase())) || m.sender.toLowerCase() === 'you' ? 'assistant' : 'user',
    content: m.content
  }));
  
  return {
    styleSamples,
    conversation,
    contactName: parsed.contacts[0] || 'Unknown',
    totalMessages: parsed.total,
    ownerCount: parsed.owner.length,
    contactCount: parsed.contact.length
  };
}

/**
 * Parse multiple exports or bulk import
 */
export function bulkImportFromExports(exports) {
  // exports: array of { text, contactJid, ownerIdentifiers }
  const allStyles = {};
  for (const exp of exports) {
    const result = extractOwnerStyleFromExport(exp.text, exp.ownerIdentifiers);
    const jid = exp.contactJid;
    if (!allStyles[jid]) allStyles[jid] = [];
    allStyles[jid].push(...result.styleSamples);
  }
  return allStyles;
}
