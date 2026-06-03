# The Secret Spot – IVR Receptionist 📞

AI-powered phone receptionist for **The Secret Spot – Ladies & Men Grooming Studio**, Isabela PR.  
Built with Node.js · Express · Twilio · OpenAI GPT-4o-mini.

---

## Features

- **IVR language selection** – press 1 for English, 2 for Spanish
- **Bilingual AI** – responds fully in the selected language using the right Polly voice
- **Persistent conversation** – remembers the full call history so context isn't lost between turns
- **3-minute auto-hangup** – politely ends the call if it runs over 3 minutes
- **No double-language responses** – the AI strictly speaks only the chosen language

---

## Project Structure

```
secret-spot-ivr/
├── index.js                   # App entry point
├── package.json
├── .env.example               # Copy to .env and fill in
├── config/
│   ├── openai.js              # OpenAI client
│   └── twiml.js               # TwiML helper functions
├── prompts/
│   └── systemPrompts.js       # EN + ES system prompts
└── routes/
    └── calls.js               # All Twilio webhook routes
```

---

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
```
Edit `.env`:
```
OPENAI_API_KEY=sk-...
BASE_URL=https://your-ngrok-url.ngrok-free.app
PORT=3000
```

### 3. Run the server
```bash
# Development (auto-reload)
npm run dev

# Production
npm start
```

### 4. Expose with ngrok
```bash
ngrok http 3000
```
Copy the HTTPS URL into your `.env` as `BASE_URL`.

---

## Twilio Configuration

In your Twilio phone number settings:

| Event | URL |
|-------|-----|
| **A call comes in** | `POST https://your-url/incoming-call` |
| **Call status callback** *(optional)* | `POST https://your-url/call-status` |

---

## Call Flow

```
Incoming call
    └─► IVR: "Press 1 for English, oprima 2 para español"
          ├─ 1 ─► English AI conversation loop
          └─ 2 ─► Spanish AI conversation loop
                       │
                       ├─ Keeps listening after every response
                       ├─ Remembers full conversation context
                       └─ Auto-hangs up after 3 minutes
```

---

## Notes

- Call sessions are stored **in memory**. If you restart the server mid-call, the language preference resets. For production, swap `callSessions` Map for Redis.
- The `/call-status` route cleans up memory when calls end. Wire it in Twilio for best results.
- `max_tokens: 120` keeps TTS responses short and natural. Increase if needed.
