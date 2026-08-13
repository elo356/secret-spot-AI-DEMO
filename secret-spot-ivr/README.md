# The Secret Spot IVR

Production-ready bilingual phone receptionist for **The Secret Spot – Ladies & Men Grooming Studio** in Isabela, Puerto Rico.

## What It Does

- Answers incoming calls in Spanish or English.
- Uses **OpenAI** for the conversational flow.
- Uses **Azure TTS only** for spoken responses.
- Keeps replies short, fluid, and natural for phone audio.
- Transfers callers to the correct area:
  - Nails: `787-412-6940`
  - Color / Cut / Blow Bar: `939-240-1685`
  - Men's Area: `787-930-2891`
  - Temporary Test Line: `939-231-2803`
- Generates a summary for every finished call.
- Saves summaries to `summaries/`.
- Emails summaries when `EMAIL_*` variables are configured.

## Routes

- `POST /incoming-call`
- `POST /select-language`
- `POST /ask-ai`
- `POST /transfer-menu`
- `POST /select-staff`
- `POST /after-transfer`
- `POST /transfer-timeout`
- `POST /goodbye`
- `POST /call-status`
- `GET /audio/:id`
- `GET /health`

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create your environment file:

```bash
cp .env.example .env
```

3. Fill in:

- `OPENAI_API_KEY`
- `BASE_URL`
- `AZURE_TTS_KEY`
- `AZURE_TTS_REGION`
- Optional email settings for summaries

4. Run locally:

```bash
npm start
```

5. Expose the server publicly:

```bash
ngrok http 3000
```

6. Put the public HTTPS URL into `BASE_URL`.

## Twilio Configuration

Set your Twilio number webhooks to:

- Incoming Call: `POST https://YOUR-BASE-URL/incoming-call`
- Status Callback: `POST https://YOUR-BASE-URL/call-status`

## Production Notes

- The app refuses to start if required Azure/OpenAI variables are missing.
- If Azure TTS times out or fails, the app falls back to Twilio `<Say>` so the caller is not left hanging.
- Failed transfers return the caller to the transfer menu instead of dropping the call.
- If no transfer option is selected, the call defaults to the nails area.
- Sessions are stored in memory. For a multi-server deployment, move sessions to Redis.
