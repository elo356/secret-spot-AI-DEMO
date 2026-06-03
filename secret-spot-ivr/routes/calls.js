const express = require('express');
const router = express.Router();
const openai = require('../config/openai');
const { twiml, say, gather, hangup } = require('../config/twiml');
const { SYSTEM_PROMPT_EN, SYSTEM_PROMPT_ES } = require('../prompts/systemPrompts');

const BASE_URL = process.env.BASE_URL;

// ─── In-memory call state ─────────────────────────────────────────────────────
// Stores { lang, startTime, history[] } keyed by Twilio CallSid.
// A production app would use Redis or a DB instead.
const callSessions = new Map();

const CALL_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

function getSession(callSid) {
  return callSessions.get(callSid);
}

function createSession(callSid) {
  const session = { lang: null, startTime: Date.now(), history: [] };
  callSessions.set(callSid, session);
  return session;
}

function isExpired(session) {
  return Date.now() - session.startTime > CALL_TIMEOUT_MS;
}

function cleanupSession(callSid) {
  callSessions.delete(callSid);
}

// ─── 1. Incoming call → IVR language selection ───────────────────────────────
router.post('/incoming-call', (req, res) => {
  const callSid = req.body?.CallSid;
  createSession(callSid);

  res.type('text/xml');
  res.send(twiml(
    gather({
      action: '/select-language',
      input: 'dtmf',
      timeout: 8,
      numDigits: 1,
      children: say(
        'Thank you for calling The Secret Spot. ' +
        'For English, press 1. ' +
        'Para español, oprima 2.',
        'Polly.Joanna'
      )
    }) +
    '\n' +
    // No input fallback
    say('We did not receive a response. Goodbye! No recibimos respuesta. ¡Hasta luego!', 'Polly.Joanna') +
    '\n' +
    hangup()
  ));
});

// ─── 2. Language selected → greeting in chosen language ──────────────────────
router.post('/select-language', (req, res) => {
  const callSid = req.body?.CallSid;
  const digit = req.body?.Digits;

  const session = getSession(callSid) || createSession(callSid);

  let lang, greetingText, voice;

  if (digit === '1') {
    lang = 'en';
    voice = 'Polly.Joanna';
    greetingText = 'Hi! Welcome to The Secret Spot. How can I help you today?';
  } else if (digit === '2') {
    lang = 'es';
    voice = 'Polly.Lupe';
    greetingText = '¡Hola! Bienvenido a The Secret Spot. ¿En qué le podemos ayudar hoy?';
  } else {
    // Invalid input – ask again
    res.type('text/xml');
    res.send(twiml(
      gather({
        action: '/select-language',
        input: 'dtmf',
        timeout: 8,
        numDigits: 1,
        children: say('Invalid option. For English press 1. Para español oprima 2.', 'Polly.Joanna')
      }) +
      '\n' + hangup()
    ));
    return;
  }

  session.lang = lang;

  res.type('text/xml');
  res.send(twiml(
    gather({
      action: '/ask-ai',
      input: 'speech',
      timeout: 5,
      speechTimeout: 'auto',
      children: say(greetingText, voice)
    }) +
    '\n' +
    // If caller doesn't respond to greeting
    say(lang === 'es' ? 'No escuchamos respuesta. ¡Hasta luego!' : 'We didn\'t hear a response. Goodbye!', voice) +
    '\n' +
    hangup()
  ));
});

// ─── 3. Conversational AI loop ───────────────────────────────────────────────
router.post('/ask-ai', async (req, res) => {
  const callSid = req.body?.CallSid;
  const userMessage = req.body?.SpeechResult || '';

  const session = getSession(callSid) || createSession(callSid);
  const lang = session.lang || 'en';
  const voice = lang === 'es' ? 'Polly.Lupe' : 'Polly.Joanna';

  // ── 3-minute timeout check ──
  if (isExpired(session)) {
    cleanupSession(callSid);
    const byeMsg = lang === 'es'
      ? 'Hemos alcanzado el tiempo máximo de la llamada. ¡Gracias por llamar a The Secret Spot! ¡Hasta luego!'
      : 'We have reached the maximum call time. Thank you for calling The Secret Spot! Goodbye!';
    res.type('text/xml');
    res.send(twiml(say(byeMsg, voice) + '\n' + hangup()));
    return;
  }

  // ── If no speech detected, prompt again ──
  if (!userMessage.trim()) {
    const listenMsg = lang === 'es' ? 'Lo siento, no le escuché. ¿En qué le puedo ayudar?' : 'Sorry, I didn\'t catch that. How can I help you?';
    res.type('text/xml');
    res.send(twiml(
      gather({
        action: '/ask-ai',
        input: 'speech',
        timeout: 6,
        speechTimeout: 'auto',
        children: say(listenMsg, voice)
      }) +
      '\n' +
      hangup()
    ));
    return;
  }

  console.log(`[${callSid}] 👤 (${lang}): ${userMessage}`);

  // ── Append user turn to history ──
  session.history.push({ role: 'user', content: userMessage });

  // Keep history to last 10 turns to avoid bloating the prompt
  if (session.history.length > 20) {
    session.history = session.history.slice(-20);
  }

  try {
    const systemPrompt = lang === 'es' ? SYSTEM_PROMPT_ES : SYSTEM_PROMPT_EN;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 120,
      messages: [
        { role: 'system', content: systemPrompt },
        ...session.history,
      ],
    });

    const aiReply = completion.choices[0]?.message?.content?.trim() || (
      lang === 'es' ? '¿En qué más le puedo ayudar?' : 'How else can I help you?'
    );

    console.log(`[${callSid}] 🤖: ${aiReply}`);

    // Append assistant turn to history
    session.history.push({ role: 'assistant', content: aiReply });

    const continueMsg = lang === 'es' ? '¿Hay algo más en que le pueda ayudar?' : 'Is there anything else I can help you with?';

    res.type('text/xml');
    res.send(twiml(
      // Say AI response first
      say(aiReply, voice) +
      '\n' +
      // Then keep listening — conversation continues
      gather({
        action: '/ask-ai',
        input: 'speech',
        timeout: 6,
        speechTimeout: 'auto',
        children: say(continueMsg, voice)
      }) +
      '\n' +
      // Caller went silent after follow-up prompt
      say(
        lang === 'es'
          ? '¡Gracias por llamar a The Secret Spot! ¡Que tenga un excelente día!'
          : 'Thank you for calling The Secret Spot! Have a wonderful day!',
        voice
      ) +
      '\n' +
      hangup()
    ));

  } catch (error) {
    console.error(`[${callSid}] ❌ OpenAI error:`, error.message);

    const errorMsg = lang === 'es'
      ? 'Estamos experimentando un problema técnico. Por favor llame de nuevo en unos momentos.'
      : 'We are experiencing a technical issue. Please call back in a moment.';

    res.type('text/xml');
    res.send(twiml(say(errorMsg, voice) + '\n' + hangup()));
  }
});

// ─── 4. Twilio status callback (optional but useful for cleanup) ──────────────
router.post('/call-status', (req, res) => {
  const callSid = req.body?.CallSid;
  const status = req.body?.CallStatus;
  if (['completed', 'busy', 'failed', 'no-answer', 'canceled'].includes(status)) {
    cleanupSession(callSid);
    console.log(`[${callSid}] 📴 Call ended: ${status}`);
  }
  res.sendStatus(200);
});

module.exports = router;
