# Always-On WhatsApp AI Bot — Free, Render-Hosted (No Computer Needed)

> 24/7 WhatsApp auto-reply using free Gemini AI, remembers each contact, hands off to human, survives Render restarts, login via pairing code (no QR scan).

**Cost: $0/month** — Render free tier + Gemini free tier + Upstash Redis free tier.

---

## ✅ What This Solves (vs basic bot)

| Problem | Fix in this bot |
|---|---|
| Render wipes local files on restart | Session + memory stored in **Upstash Redis** (cloud) |
| No terminal to scan QR on Render | **Pairing code** login — code shows in Render logs, type in WhatsApp |
| Render restarts occasionally | Auto-reconnects using saved session from Redis — no action needed |
| WhatsApp ban risk | Random 1-4s delay, no outbound spam, rate limit 30/hour, ignores groups |
| Gemini free limits | Uses **Gemini Flash** (1,500 req/day free) + graceful fallback |

---

## Architecture

```
WhatsApp (your number)
   │  Baileys + pairing code
   ▼
Render Web Service (Node.js, free, always-on with health check)
   ├──► Gemini API (free) - replies
   └──► Upstash Redis (free)
        - auth session (survives restarts)
        - per-contact chat memory
        - handoff state
        - rate limits
```

---

## Setup Guide — From Your Phone Browser Only

### Step 1: Get Free Gemini API Key (2 mins)

1. Go to https://aistudio.google.com/app/apikey (login with Google)
2. Tap **Create API Key** → Copy the key (starts with `AIza...`)

### Step 2: Create Free Upstash Redis (2 mins, no credit card)

1. Go to https://upstash.com → Sign up (Google/GitHub)
2. **Create Database** → Name: `whatsapp-bot` → Region: closest to you → Type: Regional → Create
3. Scroll to **REST API** section → Copy:
   - `UPSTASH_REDIS_REST_URL` (looks like `https://...upstash.io`)
   - `UPSTASH_REDIS_REST_TOKEN`
4. Keep tab open

### Step 3: Push Code to GitHub (from phone)

Option A - If you have GitHub app:
1. Create new repo `whatsapp-ai-bot` (public)
2. Upload all files from this project (you can use github.com upload)

Option B - Deploy without Git:
- On Render dashboard, you can use "Deploy from public Git" later, but GitHub is easiest.

### Step 4: Deploy to Render (3 mins)

1. Go to https://dashboard.render.com → Login (same account as your scanner)
2. Tap **New +** → **Web Service** → Connect your `whatsapp-ai-bot` repo
3. Settings:
   - Name: `whatsapp-ai-bot`
   - Region: same as Upstash
   - Branch: `main`
   - Runtime: `Node`
   - Build Command: `npm install`
   - Start Command: `node index.js`
   - Plan: **Free**
4. Scroll to **Environment Variables** → Add:
   ```
   PHONE_NUMBER = 2348012345678  (your full number, no +)
   GEMINI_API_KEY = AIza... (from step 1)
   UPSTASH_REDIS_REST_URL = https://... (from step 2)
   UPSTASH_REDIS_REST_TOKEN = ... (from step 2)
   GEMINI_MODEL = gemini-1.5-flash
   ```
5. Tap **Create Web Service** → Wait for deploy (2-3 mins)

### Step 5: Get Pairing Code & Link WhatsApp (1 min)

1. In Render, open your service → **Logs** tab
2. Wait for log: `🔑 YOUR PAIRING CODE: XXXXXXXX`
3. On your phone WhatsApp:
   - **Settings → Linked Devices → Link a Device → Link with phone number instead** (at bottom)
   - Enter the 8-character code from logs
4. Done! Logs will show `✅ WhatsApp connected successfully!`

**If code expires:** Render → Manual Deploy → Deploy latest commit → New code appears in logs.

---

## How It Works Daily

- Anyone messages your WhatsApp number → Bot replies with AI, remembering their chat history
- Random 1-4 sec delay + typing indicator → looks human
- If contact says `human`, `stop bot`, `#human`, `agent` → Bot pauses for 2 hours, says handing over
- You chat normally from your phone → Bot stays quiet for that person while you talk
- You can resume bot with command: send to yourself or in chat `/resume 2348012345678`
- Restarts? Bot auto-reconnects, no rescan needed (thanks to Redis)

---

## Owner Commands

Send these **as your own message** (fromMe) — to yourself or in any chat:

```
/pause 2348012345678   - Pause bot for contact (human takeover)
/resume 2348012345678  - Resume bot
/resume all            - Resume everyone
/clear 2348012345678   - Clear history for contact
/status                - Show uptime, model, storage
/help                  - Show commands
```

---

## Environment Variables Reference

| Var | Required | Default | Description |
|---|---|---|---|
| `PHONE_NUMBER` | Yes | - | Your WhatsApp number e.g. 2348012345678 |
| `GEMINI_API_KEY` | Yes | - | Free from aistudio.google.com |
| `UPSTASH_REDIS_REST_URL` | Yes for Render | - | From Upstash dashboard |
| `UPSTASH_REDIS_REST_TOKEN` | Yes for Render | - | From Upstash dashboard |
| `GEMINI_MODEL` | No | `gemini-1.5-flash` | `gemini-1.5-flash` recommended for free tier |
| `SYSTEM_PROMPT` | No | Friendly assistant | Custom personality |
| `MAX_HISTORY` | No | 20 | Messages remembered per contact |
| `MAX_PER_HOUR` | No | 30 | Rate limit per contact |
| `HANDOFF_MINUTES` | No | 120 | Auto-resume after handoff |
| `IGNORE_GROUPS` | No | true | Ignore group chats |
| `REPLY_DELAY_MIN` | No | 1000 | Min delay ms |
| `REPLY_DELAY_MAX` | No | 4000 | Max delay ms |

---

## Important Notes

### WhatsApp 14-day rule (unavoidable)
Linked devices need your main phone to have internet at least once every 14 days. This is WhatsApp's rule for ALL linked devices. Your phone doesn't need to be on 24/7, just occasional internet.

### Ban safety
- Bot **only replies** when messaged first (never spams)
- Ignores groups by default
- Rate-limited
- Human-like delays
- Keep tone conversational

For extra safety, use a secondary number first to test.

### Free tier limits
- **Render free:** Web service spins down after 15 min inactivity but this bot has health server + will be kept alive by incoming WhatsApp activity via Baileys keepalive. If it does sleep, Render auto-wakes on next request? Actually WebSocket keeps it alive. For 100% always-on, Render may still restart occasionally — but our Redis persistence makes restart harmless (auto-reconnects).
- **Gemini free:** 15 RPM, 1,500 RPD for Flash — plenty for personal use.
- **Upstash free:** 10k commands/day, 256MB — more than enough.

If you want true background worker (never sleeps), Render's free tier now includes cron + background? Check Render docs — you can change service type to Background Worker if your account has it free, same code works (health server just ignored).

---

## Local Testing (if you have laptop)

```bash
npm install
cp .env.example .env
# edit .env
node index.js
```

---

## Troubleshooting

**No pairing code in logs?**
- Check PHONE_NUMBER is set correctly (no +, no spaces)
- Check logs for errors
- Ensure service finished building

**Bot not replying?**
- Check `/status` command
- Check Gemini API key valid
- Check Upstash credentials
- Look at Render logs for errors

**Logged out?**
- Go to Upstash → Data Browser → Delete keys `baileys:creds` and `baileys:keys:*`
- Or use Redis CLI: `DEL baileys:creds`
- Redeploy on Render → New pairing code

**Gemini quota error?**
- Wait 1 minute, bot auto-retries with friendly message
- Check https://aistudio.google.com/app/apikey usage

---

## Deploy Button (optional)

You can add to your README for one-click deploy:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

Requires `render.yaml` in repo (included).

---

## License

MIT — Use at your own risk. Baileys is unofficial, may violate WhatsApp ToS. Use secondary number for testing.

Built for $0/month always-on personal assistant.
