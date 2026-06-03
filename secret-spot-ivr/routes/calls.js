const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const openai = require('../config/openai');
const { twiml, play, redirect, gather, hangup } = require('../config/twiml');
const { generateSpeech } = require('../config/elevenlabs');
const { SYSTEM_PROMPT_EN, SYSTEM_PROMPT_ES } = require('../prompts/systemPrompts');

const BASE_URL = process.env.BASE_URL;

// ─── Audio cache ──────────────────────────────────────────────────────────────
const audioCache = new Map();

function storeAudio(buffer) {
  const id = crypto.randomUUID();
  audioCache.set(id, buffer);
  setTimeout(() => audioCache.delete(id), 5 * 60 * 1000);
  return `${BASE_URL}/audio/${id}`;
}

async function tts(text) {
  const buffer = await generateSpeech(text);
  return play(storeAudio(buffer));
}

router.get('/audio/:id', (req, res) => {
  const buffer = audioCache.get(req.params.id);
  if (!buffer) return res.sendStatus(404);
  res.set('Content-Type', 'audio/mpeg');
  res.send(buffer);
});

// ─── Call state ───────────────────────────────────────────────────────────────
const callSessions = new Map();
const CALL_TIMEOUT_MS = 3 * 60 * 1000;

function getSession(callSid) {
  return callSessions.get(callSid);
}

function createSession(callSid) {
  const session = { lang: null, startTime: Date.now(), history: [], summaryPrinted: false };
  callSessions.set(callSid, session);
  return session;
}

function isExpired(session) {
  return Date.now() - session.startTime > CALL_TIMEOUT_MS;
}

function cleanupSession(callSid) {
  callSessions.delete(callSid);
}

function printCallSummary(callSid, session) {
  if (!session || session.summaryPrinted) return;
  session.summaryPrinted = true;

  const durationSec = Math.round((Date.now() - session.startTime) / 1000);
  const min = Math.floor(durationSec / 60);
  const sec = durationSec % 60;
  const turns = Math.floor(session.history.length / 2);
  const lang = session.lang === 'es' ? 'Español' : 'English';

  console.log('\n' + '═'.repeat(62));
  console.log('  📋  RESUMEN DE LLAMADA');
  console.log('═'.repeat(62));
  console.log(`  📞  CallSid : ${callSid}`);
  console.log(`  🌐  Idioma  : ${lang}`);
  console.log(`  ⏱   Duración: ${min}m ${sec}s`);
  console.log(`  💬  Turnos  : ${turns}`);
  console.log('─'.repeat(62));
  if (session.history.length === 0) {
    console.log('  (sin conversación registrada)');
  } else {
    session.history.forEach(turn => {
      const label = turn.role === 'user' ? '  👤 Cliente    ' : '  🤖 Asistente  ';
      const lines = turn.content.split('\n');
      console.log(`\n${label}: ${lines[0]}`);
      lines.slice(1).forEach(l => console.log(`                  ${l}`));
    });
  }
  console.log('\n' + '═'.repeat(62) + '\n');
}

// ─── 1. Incoming call → IVR language selection ───────────────────────────────
router.post('/incoming-call', async (req, res) => {
  const callSid = req.body?.CallSid;
  createSession(callSid);

  try {
    const [promptAudio, fallbackAudio] = await Promise.all([
      tts('Gracias por llamar a The Secret Spot. Para español, oprima 1. For English, press 2.'),
      tts('No recibimos respuesta. ¡Hasta luego! We did not receive a response. Goodbye!'),
    ]);

    res.type('text/xml');
    res.send(twiml(
      gather({
        action: '/select-language',
        input: 'dtmf',
        timeout: 8,
        numDigits: 1,
        children: promptAudio,
      }) +
      '\n' + fallbackAudio +
      '\n' + hangup()
    ));
  } catch (err) {
    console.error(`[${callSid}] ❌ TTS error on incoming-call:`, err.message);
    res.type('text/xml');
    res.send(twiml(hangup()));
  }
});

// ─── 2. Language selected → greeting ─────────────────────────────────────────
router.post('/select-language', async (req, res) => {
  const callSid = req.body?.CallSid;
  const digit = req.body?.Digits;
  const session = getSession(callSid) || createSession(callSid);

  let lang, greetingText;

  if (digit === '1') {
    lang = 'es';
    greetingText = '¡Hola! Bienvenido a The Secret Spot. ¿En qué le podemos ayudar hoy?';
  } else if (digit === '2') {
    lang = 'en';
    greetingText = 'Hi! Welcome to The Secret Spot. How can I help you today?';
  } else {
    try {
      const invalidAudio = await tts('Opción no válida. Para español oprima 1. For English press 2.');
      res.type('text/xml');
      res.send(twiml(
        gather({
          action: '/select-language',
          input: 'dtmf',
          timeout: 8,
          numDigits: 1,
          children: invalidAudio,
        }) +
        '\n' + hangup()
      ));
    } catch (err) {
      console.error(`[${callSid}] ❌ TTS error:`, err.message);
      res.type('text/xml');
      res.send(twiml(hangup()));
    }
    return;
  }

  session.lang = lang;
  const noResponseText = lang === 'es'
    ? 'No escuchamos respuesta. ¡Hasta luego!'
    : "We didn't hear a response. Goodbye!";

  try {
    const [greetAudio, noResponseAudio] = await Promise.all([
      tts(greetingText),
      tts(noResponseText),
    ]);

    res.type('text/xml');
    res.send(twiml(
      gather({
        action: '/ask-ai',
        input: 'speech',
        timeout: 5,
        speechTimeout: 'auto',
        language: lang === 'es' ? 'es-US' : 'en-US',
        children: greetAudio,
      }) +
      '\n' + noResponseAudio +
      '\n' + hangup()
    ));
  } catch (err) {
    console.error(`[${callSid}] ❌ TTS error on select-language:`, err.message);
    res.type('text/xml');
    res.send(twiml(hangup()));
  }
});

// ─── 3. Conversational AI loop ───────────────────────────────────────────────
router.post('/ask-ai', async (req, res) => {
  const callSid = req.body?.CallSid;
  const userMessage = req.body?.SpeechResult || '';

  const session = getSession(callSid) || createSession(callSid);
  const lang = session.lang || 'es';

  if (isExpired(session)) {
    printCallSummary(callSid, session);
    cleanupSession(callSid);
    const byeMsg = lang === 'es'
      ? 'Hemos alcanzado el tiempo máximo de la llamada. ¡Gracias por llamar a The Secret Spot! ¡Hasta luego!'
      : 'We have reached the maximum call time. Thank you for calling The Secret Spot! Goodbye!';
    try {
      const byeAudio = await tts(byeMsg);
      res.type('text/xml');
      res.send(twiml(byeAudio + '\n' + hangup()));
    } catch {
      res.type('text/xml');
      res.send(twiml(hangup()));
    }
    return;
  }

  if (!userMessage.trim()) {
    const listenMsg = lang === 'es'
      ? 'Lo siento, no le escuché. ¿En qué le puedo ayudar?'
      : "Sorry, I didn't catch that. How can I help you?";
    try {
      const listenAudio = await tts(listenMsg);
      res.type('text/xml');
      res.send(twiml(
        gather({
          action: '/ask-ai',
          input: 'speech',
          timeout: 6,
          speechTimeout: 'auto',
          language: lang === 'es' ? 'es-US' : 'en-US',
          children: listenAudio,
        }) +
        '\n' + hangup()
      ));
    } catch {
      res.type('text/xml');
      res.send(twiml(hangup()));
    }
    return;
  }

  console.log(`[${callSid}] 👤 (${lang}): ${userMessage}`);
  session.history.push({ role: 'user', content: userMessage });
  if (session.history.length > 20) session.history = session.history.slice(-20);

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

    const aiReply = completion.choices[0]?.message?.content?.trim() ||
      (lang === 'es' ? '¿En qué más le puedo ayudar?' : 'How else can I help you?');

    console.log(`[${callSid}] 🤖: ${aiReply}`);
    session.history.push({ role: 'assistant', content: aiReply });

    const continueMsg = lang === 'es'
      ? '¿Hay algo más en que le pueda ayudar?'
      : 'Is there anything else I can help you with?';

    const [replyAudio, continueAudio] = await Promise.all([
      tts(aiReply),
      tts(continueMsg),
    ]);

    res.type('text/xml');
    res.send(twiml(
      replyAudio +
      '\n' +
      gather({
        action: '/ask-ai',
        input: 'speech',
        timeout: 6,
        speechTimeout: 'auto',
        language: lang === 'es' ? 'es-US' : 'en-US',
        children: continueAudio,
      }) +
      '\n' + redirect('/goodbye')
    ));

  } catch (error) {
    console.error(`[${callSid}] ❌ Error:`, error.message);
    const errorMsg = lang === 'es'
      ? 'Estamos experimentando un problema técnico. Por favor llame de nuevo en unos momentos.'
      : 'We are experiencing a technical issue. Please call back in a moment.';
    try {
      const errAudio = await tts(errorMsg);
      res.type('text/xml');
      res.send(twiml(errAudio + '\n' + hangup()));
    } catch {
      res.type('text/xml');
      res.send(twiml(hangup()));
    }
  }
});

// ─── 4. Goodbye – prints summary + farewell ───────────────────────────────────
router.post('/goodbye', async (req, res) => {
  const callSid = req.body?.CallSid;
  const session = getSession(callSid);
  const lang = session?.lang || 'es';

  printCallSummary(callSid, session);
  if (session) cleanupSession(callSid);

  const byeMsg = lang === 'es'
    ? '¡Gracias por llamar a The Secret Spot! ¡Que tenga un excelente día!'
    : 'Thank you for calling The Secret Spot! Have a wonderful day!';

  try {
    const byeAudio = await tts(byeMsg);
    res.type('text/xml');
    res.send(twiml(byeAudio + '\n' + hangup()));
  } catch {
    res.type('text/xml');
    res.send(twiml(hangup()));
  }
});

// ─── 5. Twilio status callback (fallback cleanup) ─────────────────────────────
router.post('/call-status', (req, res) => {
  const callSid = req.body?.CallSid;
  const status = req.body?.CallStatus;
  if (['completed', 'busy', 'failed', 'no-answer', 'canceled'].includes(status)) {
    const session = getSession(callSid);
    if (session) {
      printCallSummary(callSid, session);
      cleanupSession(callSid);
    }
    console.log(`[${callSid}] 📴 Llamada terminada: ${status}`);
  }
  res.sendStatus(200);
});

module.exports = router;
