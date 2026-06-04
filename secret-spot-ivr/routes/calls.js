const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const openai = require('../config/openai');
const { twiml, play, redirect, gather, hangup, dial } = require('../config/twiml');
const { generateSpeech } = require('../config/elevenlabs');
const { SYSTEM_PROMPT_EN, SYSTEM_PROMPT_ES } = require('../prompts/systemPrompts');

const BASE_URL = process.env.BASE_URL;

// ─── Staff transfer config ────────────────────────────────────────────────────
const STAFF = [
  {
    name_es: 'Recepción / Estilistas',
    name_en: 'Reception / Stylists',
    number: process.env.TRANSFER_NUMBER || '+19392312803',
  },
  {
    name_es: 'Gerencia',
    name_en: 'Management',
    number: process.env.TRANSFER_NUMBER || '+19392312803',
  },
];

// ─── Audio cache ──────────────────────────────────────────────────────────────
const audioCache = new Map();

function storeAudio(buffer) {
  const id = crypto.randomUUID();
  audioCache.set(id, buffer);
  setTimeout(() => audioCache.delete(id), 5 * 60 * 1000);
  return `${BASE_URL}/audio/${id}`;
}

async function tts(text, session) {
  const buffer = await generateSpeech(text, session?.lang || 'es');
  if (session) session.elChars += text.length;
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
  const session = {
    lang: null,
    callerPhone: null,
    startTime: Date.now(),
    history: [],
    summaryDone: false,
    elChars: 0,
    oaiTokens: { prompt: 0, completion: 0 },
    sttTurns: 0,
  };
  callSessions.set(callSid, session);
  return session;
}

function isExpired(session) {
  return Date.now() - session.startTime > CALL_TIMEOUT_MS;
}

function cleanupSession(callSid) {
  callSessions.delete(callSid);
}

function snapshotSession(session) {
  return { ...session, history: session.history.map(t => ({ ...t })) };
}

// ─── AI-generated call summary ────────────────────────────────────────────────
async function generateCallSummary(callSid, snap) {
  if (!snap || snap.summaryDone) return;
  snap.summaryDone = true;

  const durationSec = Math.round((Date.now() - snap.startTime) / 1000);
  const min = Math.floor(durationSec / 60);
  const sec = durationSec % 60;
  const turns = Math.floor(snap.history.length / 2);
  const langLabel = snap.lang === 'es' ? 'Español' : 'English';

  const elCost     = snap.elChars * 0.000016; // Google Neural2: $16/1M chars
  const oaiCost    = (snap.oaiTokens.prompt * 0.15 + snap.oaiTokens.completion * 0.60) / 1_000_000;
  const twilioMin  = Math.max(1, Math.ceil(durationSec / 60));
  const twilioCost = twilioMin * 0.0085 + snap.sttTurns * 0.01;
  const total      = elCost + oaiCost + twilioCost;
  const fmt        = (n) => `$${n.toFixed(4)}`;

  console.log('\n' + '═'.repeat(62));
  console.log('  📋  RESUMEN DE LLAMADA');
  console.log('═'.repeat(62));
  console.log(`  📞  CallSid : ${callSid}`);
  console.log(`  📱  Caller  : ${snap.callerPhone || 'desconocido'}`);
  console.log(`  🌐  Idioma  : ${langLabel}`);
  console.log(`  ⏱   Duración: ${min}m ${sec}s`);
  console.log(`  💬  Turnos  : ${turns}`);
  console.log('─'.repeat(62));
  console.log('  💰  COSTO ESTIMADO');
  console.log(`      Google TTS  ${String(snap.elChars).padStart(6)} chars   → ${fmt(elCost)}`);
  console.log(`      OpenAI      ${String(snap.oaiTokens.prompt + snap.oaiTokens.completion).padStart(6)} tokens  → ${fmt(oaiCost)}`);
  console.log(`      Twilio      ${String(twilioMin).padStart(3)}min + ${snap.sttTurns} STT      → ${fmt(twilioCost)}`);
  console.log(`                                      ──────────`);
  console.log(`      TOTAL                           ${fmt(total)}`);
  console.log('─'.repeat(62));

  if (snap.history.length === 0) {
    console.log('  (sin conversación registrada)');
    console.log('═'.repeat(62) + '\n');
    return;
  }

  console.log('  🤖  Generando análisis con IA...\n');

  try {
    const transcript = snap.history
      .map(t => `${t.role === 'user' ? 'Cliente' : 'Asistente'}: ${t.content}`)
      .join('\n');

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 500,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
`Eres un analista de llamadas para The Secret Spot – Ladies & Men Grooming Studio, Isabela, Puerto Rico.
Analiza la transcripción y genera un JSON con los campos MÁS RELEVANTES para esta llamada específica.
Incluye SOLO los campos que apliquen según la conversación:
- caller_name: nombre si fue mencionado
- phone_number: número si fue mencionado; si no, usa "${snap.callerPhone || ''}"
- language: idioma de la llamada ("es" o "en")
- reason_for_call: motivo principal en español
- service_requested: servicio(s) de interés (string o array)
- preferred_date: fecha preferida si mencionada
- preferred_time: horario preferido si mencionado
- new_client: true/false si se puede determinar
- appointment_requested: true/false
- urgency: "alta" | "normal" | "baja"
- summary: resumen narrativo de 2-3 oraciones en español
- action_required: true/false
- follow_up_notes: notas para el equipo si aplica
Responde SOLO con JSON válido. Sin markdown ni texto extra.`,
        },
        { role: 'user', content: `Transcripción:\n${transcript}` },
      ],
    });

    const raw    = completion.choices[0]?.message?.content?.trim() || '{}';
    const parsed = JSON.parse(raw);
    if (!parsed.phone_number && snap.callerPhone) parsed.phone_number = snap.callerPhone;

    console.log('  📊  ANÁLISIS:');
    console.log(JSON.stringify(parsed, null, 2).split('\n').map(l => '  ' + l).join('\n'));
  } catch (err) {
    console.error('  ❌ Error generando análisis:', err.message);
  }

  console.log('\n' + '═'.repeat(62) + '\n');
}

// ─── 1. Incoming call → IVR language selection ───────────────────────────────
router.post('/incoming-call', async (req, res) => {
  const callSid = req.body?.CallSid;
  const session = createSession(callSid);
  session.callerPhone = req.body?.From || null;

  try {
    const [promptAudio, fallbackAudio] = await Promise.all([
      tts('Gracias por llamar a The Secret Spot. Para español, oprima 1. For English, press 2.', session),
      tts('No recibimos respuesta. ¡Hasta luego! We did not receive a response. Goodbye!', session),
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
      const invalidAudio = await tts('Opción no válida. Para español oprima 1. For English press 2.', session);
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
      tts(greetingText, session),
      tts(noResponseText, session),
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
    const snap = snapshotSession(session);
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
    generateCallSummary(callSid, snap).catch(err =>
      console.error(`[${callSid}] ❌ Summary error:`, err.message)
    );
    return;
  }

  if (!userMessage.trim()) {
    const listenMsg = lang === 'es'
      ? 'Lo siento, no le escuché. ¿En qué le puedo ayudar?'
      : "Sorry, I didn't catch that. How can I help you?";
    try {
      const listenAudio = await tts(listenMsg, session);
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
      max_tokens: 150,
      messages: [
        { role: 'system', content: systemPrompt },
        ...session.history,
      ],
    });

    if (completion.usage) {
      session.oaiTokens.prompt     += completion.usage.prompt_tokens;
      session.oaiTokens.completion += completion.usage.completion_tokens;
    }
    session.sttTurns++;

    const rawReply  = completion.choices[0]?.message?.content?.trim() ||
      (lang === 'es' ? '¿En qué más le puedo ayudar?' : 'How else can I help you?');

    const hasFin      = rawReply.includes('[FIN]');
    const hasTransfer = rawReply.includes('[TRANSFER]');
    const aiReply     = rawReply.replace(/\[FIN\]|\[TRANSFER\]/g, '').trim();
    // Safety guard: never hang up if the AI is still asking a question
    const shouldEnd      = hasFin && !aiReply.trimEnd().endsWith('?');
    const shouldTransfer = hasTransfer && !aiReply.trimEnd().endsWith('?');

    const marker = shouldEnd ? ' [FIN]' : shouldTransfer ? ' [TRANSFER]' : '';
    console.log(`[${callSid}] 🤖${marker}: ${aiReply}`);
    session.history.push({ role: 'assistant', content: aiReply });

    // ── Caller said goodbye → hang up and generate summary ──
    if (shouldEnd) {
      const finalAudio = await tts(aiReply, session);
      const snap = snapshotSession(session);
      cleanupSession(callSid);
      res.type('text/xml');
      res.send(twiml(finalAudio + '\n' + hangup()));
      generateCallSummary(callSid, snap).catch(err =>
        console.error(`[${callSid}] ❌ Summary error:`, err.message)
      );
      return;
    }

    // ── Caller wants to speak to staff → transfer menu ──
    if (shouldTransfer) {
      const transitionAudio = await tts(aiReply, session);
      res.type('text/xml');
      res.send(twiml(transitionAudio + '\n' + redirect('/transfer-menu')));
      return;
    }

    const continueMsg = lang === 'es'
      ? '¿Hay algo más en que le pueda ayudar?'
      : 'Is there anything else I can help you with?';

    const [replyAudio, continueAudio] = await Promise.all([
      tts(aiReply, session),
      tts(continueMsg, session),
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
      const errAudio = await tts(errorMsg, session);
      res.type('text/xml');
      res.send(twiml(errAudio + '\n' + hangup()));
    } catch {
      res.type('text/xml');
      res.send(twiml(hangup()));
    }
  }
});

// ─── 4. Goodbye – farewell audio + summary ───────────────────────────────────
router.post('/goodbye', async (req, res) => {
  const callSid = req.body?.CallSid;
  const session = getSession(callSid);
  const lang    = session?.lang || 'es';
  const snap    = session ? snapshotSession(session) : null;
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

  if (snap) {
    generateCallSummary(callSid, snap).catch(err =>
      console.error(`[${callSid}] ❌ Summary error:`, err.message)
    );
  }
});

// ─── 5. Transfer menu ────────────────────────────────────────────────────────
router.post('/transfer-menu', async (req, res) => {
  const callSid = req.body?.CallSid;
  const session = getSession(callSid);
  const lang    = session?.lang || 'es';

  const menuText = lang === 'es'
    ? `Para hablar con ${STAFF[0].name_es}, oprima 1. Para hablar con ${STAFF[1].name_es}, oprima 2.`
    : `To speak with ${STAFF[0].name_en}, press 1. To speak with ${STAFF[1].name_en}, press 2.`;

  try {
    const menuAudio = await tts(menuText);
    res.type('text/xml');
    res.send(twiml(
      gather({
        action: '/select-staff',
        input: 'dtmf',
        timeout: 8,
        numDigits: 1,
        children: menuAudio,
      }) +
      // No input → auto-dial option 1
      '\n' + dial(STAFF[0].number)
    ));
  } catch (err) {
    console.error(`[${callSid}] ❌ TTS error on transfer-menu:`, err.message);
    res.type('text/xml');
    res.send(twiml(dial(STAFF[0].number)));
  }
});

// ─── 6. Staff selected → dial ─────────────────────────────────────────────────
router.post('/select-staff', async (req, res) => {
  const callSid = req.body?.CallSid;
  const digit   = req.body?.Digits;
  const session = getSession(callSid);
  const lang    = session?.lang || 'es';

  const index  = digit === '2' ? 1 : 0;
  const staff  = STAFF[index];

  const connectingText = lang === 'es'
    ? 'Un momento por favor, le estamos conectando.'
    : 'One moment please, connecting you now.';

  console.log(`[${callSid}] 📲 Transferring to ${staff.name_es} (${staff.number})`);

  try {
    const connectingAudio = await tts(connectingText);
    res.type('text/xml');
    res.send(twiml(connectingAudio + '\n' + dial(staff.number)));
  } catch {
    res.type('text/xml');
    res.send(twiml(dial(staff.number)));
  }

  if (session) {
    const snap = snapshotSession(session);
    cleanupSession(callSid);
    generateCallSummary(callSid, snap).catch(err =>
      console.error(`[${callSid}] ❌ Summary error:`, err.message)
    );
  }
});

// ─── 7. Twilio status callback (fallback cleanup) ─────────────────────────────
router.post('/call-status', (req, res) => {
  const callSid = req.body?.CallSid;
  const status  = req.body?.CallStatus;
  if (['completed', 'busy', 'failed', 'no-answer', 'canceled'].includes(status)) {
    const session = getSession(callSid);
    if (session) {
      const snap = snapshotSession(session);
      cleanupSession(callSid);
      generateCallSummary(callSid, snap).catch(err =>
        console.error(`[${callSid}] ❌ Summary error:`, err.message)
      );
    }
    console.log(`[${callSid}] 📴 Llamada terminada: ${status}`);
  }
  res.sendStatus(200);
});

module.exports = router;
