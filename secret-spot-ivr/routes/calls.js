require('dotenv').config();
const express  = require('express');
const router   = express.Router();
const crypto   = require('crypto');
const fs       = require('fs');
const path     = require('path');
const openai   = require('../config/openai');
const { twiml, play, redirect, gather, hangup, dial } = require('../config/twiml');
const { generateSpeech: generateSpeechAzure }       = require('../config/elevenlabs');
const { generateSpeech: generateSpeechElevenLabs } = require('../config/tts-elevenlabs');
const { SYSTEM_PROMPT_EN, SYSTEM_PROMPT_ES } = require('../prompts/systemPrompts');
const { sendSummaryEmail } = require('../config/email');

const BASE_URL = process.env.BASE_URL;

// ─── Staff / transfer config (Persona 1–4, placeholder until real names/numbers given) ──
const STAFF = [
  {
    name_es: 'Persona 1',
    name_en: 'Person 1',
    number:  process.env.TRANSFER_1 || process.env.TRANSFER_NUMBER || '+17879302891',
  },
  {
    name_es: 'Persona 2',
    name_en: 'Person 2',
    number:  process.env.TRANSFER_2 || process.env.TRANSFER_NUMBER || '+17879302891',
  },
  {
    name_es: 'Persona 3',
    name_en: 'Person 3',
    number:  process.env.TRANSFER_3 || process.env.TRANSFER_NUMBER || '+17879302891',
  },
  {
    name_es: 'Persona 4',
    name_en: 'Person 4',
    number:  process.env.TRANSFER_4 || process.env.TRANSFER_NUMBER || '+17879302891',
  },
];

// ─── Audio cache ──────────────────────────────────────────────────────────────
const audioCache = new Map();

function storeAudio(buffer) {
  const id = crypto.randomUUID();
  audioCache.set(id, buffer);
  setTimeout(() => audioCache.delete(id), 10 * 60 * 1000);
  return `${BASE_URL}/audio/${id}`;
}

async function tts(text, session) {
  const lang     = session?.lang || 'es';
  const provider = session?.ttsProvider || 'elevenlabs';
  const buffer   = provider === 'elevenlabs'
    ? await generateSpeechElevenLabs(text)
    : await generateSpeechAzure(text, lang);
  if (session) session.elChars += text.length;
  return play(storeAudio(buffer));
}

router.get('/audio/:id', (req, res) => {
  const buffer = audioCache.get(req.params.id);
  if (!buffer) return res.sendStatus(404);
  res.set('Content-Type', 'audio/mpeg');
  res.send(buffer);
});

// ─── Call sessions ────────────────────────────────────────────────────────────
const callSessions = new Map();
const CALL_TIMEOUT_MS = 10 * 60 * 1000; // 10 min max per call

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
    ttsProvider: 'elevenlabs',
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

// ─── Ensure summaries directory exists ───────────────────────────────────────
const SUMMARIES_DIR = path.join(__dirname, '..', 'summaries');
fs.mkdirSync(SUMMARIES_DIR, { recursive: true });

// ─── Call summary: console + TXT file + email ─────────────────────────────────
async function generateCallSummary(callSid, snap) {
  if (!snap || snap.summaryDone) return;
  snap.summaryDone = true;

  const now         = new Date();
  const durationSec = Math.round((Date.now() - snap.startTime) / 1000);
  const min         = Math.floor(durationSec / 60);
  const sec         = durationSec % 60;
  const turns       = Math.floor(snap.history.length / 2);
  const langLabel   = snap.lang === 'es' ? 'Español' : 'English';
  const dateStr     = now.toLocaleString('es-PR', { timeZone: 'America/Puerto_Rico' });

  // Cost estimates
  const elCost     = snap.elChars * 0.000016;
  const oaiCost    = (snap.oaiTokens.prompt * 0.15 + snap.oaiTokens.completion * 0.60) / 1_000_000;
  const twilioMin  = Math.max(1, Math.ceil(durationSec / 60));
  const twilioCost = twilioMin * 0.0085 + snap.sttTurns * 0.01;
  const total      = elCost + oaiCost + twilioCost;
  const fmt        = (n) => `$${n.toFixed(4)}`;

  const LINE = '═'.repeat(62);
  const DASH = '─'.repeat(62);

  // Build header lines (written now, AI analysis appended after)
  const headerLines = [
    '',
    LINE,
    '  RESUMEN DE LLAMADA – THE SECRET SPOT',
    LINE,
    `  CallSid   : ${callSid}`,
    `  Caller    : ${snap.callerPhone || 'desconocido'}`,
    `  Idioma    : ${langLabel}`,
    `  Duración  : ${min}m ${sec}s`,
    `  Turnos    : ${turns}`,
    `  Fecha     : ${dateStr}`,
    DASH,
    '  COSTO ESTIMADO',
    `  ElevenLabs   ${String(snap.elChars).padStart(7)} chars    → ${fmt(elCost)}`,
    `  OpenAI       ${String(snap.oaiTokens.prompt + snap.oaiTokens.completion).padStart(7)} tokens   → ${fmt(oaiCost)}`,
    `  Twilio       ${String(twilioMin).padStart(3)}min + ${String(snap.sttTurns).padStart(2)} STT   → ${fmt(twilioCost)}`,
    `  ${'─'.repeat(42)}`,
    `  TOTAL                                    ${fmt(total)}`,
    DASH,
  ];

  console.log(headerLines.join('\n'));

  // ── AI analysis ──
  let aiAnalysis = null;
  const analysisLines = ['  ANÁLISIS IA'];

  if (snap.history.length > 0) {
    console.log('  🤖  Generando análisis con IA...\n');

    const transcript = snap.history
      .map(t => `${t.role === 'user' ? 'CLIENTE   ' : 'ASISTENTE'}: ${t.content}`)
      .join('\n');

    try {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 700,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
`Eres un analista de llamadas para The Secret Spot – Ladies & Men Grooming Studio, Isabela, Puerto Rico.
Analiza la transcripción y genera un JSON con TODOS los campos que apliquen a esta llamada:

- caller_name: nombre del cliente si fue mencionado
- phone_number: número si fue mencionado; si no, usa "${snap.callerPhone || ''}"
- language: idioma de la llamada ("es" o "en")
- reason_for_call: motivo principal de la llamada
- service_requested: servicio(s) de interés (string o array)
- preferred_date: fecha preferida si fue mencionada
- preferred_time: horario preferido si fue mencionado
- new_client: true/false si se puede determinar
- appointment_requested: true/false
- appointment_data_collected: objeto con name/phone/service/date si se recopiló para cita
- urgency: "alta" | "normal" | "baja"
- summary: resumen narrativo de 3-4 oraciones describiendo la conversación completa
- topics_discussed: array de temas que se trataron
- action_required: true/false — ¿necesita seguimiento del equipo?
- follow_up_notes: notas específicas para el equipo si aplica
- call_outcome: "informacional" | "cita_pendiente" | "transferido" | "sin_resolver" | "resuelto"
- duration_seconds: ${durationSec}
- estimated_cost_usd: ${total.toFixed(4)}

Responde SOLO con JSON válido. Sin markdown ni texto extra.`,
          },
          { role: 'user', content: `Transcripción:\n${transcript}` },
        ],
      });

      const raw = completion.choices[0]?.message?.content?.trim() || '{}';
      aiAnalysis = JSON.parse(raw);
      if (!aiAnalysis.phone_number && snap.callerPhone) aiAnalysis.phone_number = snap.callerPhone;

      const analysisJson = JSON.stringify(aiAnalysis, null, 2)
        .split('\n')
        .map(l => '  ' + l)
        .join('\n');
      analysisLines.push(analysisJson);
    } catch (err) {
      console.error('  ❌ Error generando análisis IA:', err.message);
      analysisLines.push('  (error generando análisis)');
    }
  } else {
    analysisLines.push('  (sin conversación registrada)');
  }

  // ── Full transcript ──
  const transcriptLines = [DASH, '  TRANSCRIPCIÓN COMPLETA'];
  if (snap.history.length > 0) {
    snap.history.forEach(t => {
      const role = t.role === 'user' ? 'CLIENTE   ' : 'ASISTENTE';
      transcriptLines.push(`  ${role}: ${t.content}`);
    });
  } else {
    transcriptLines.push('  (sin transcripción)');
  }
  transcriptLines.push(LINE, '');

  const fullSummary = [
    ...headerLines,
    ...analysisLines,
    ...transcriptLines,
  ].join('\n');

  console.log([...analysisLines, ...transcriptLines].join('\n'));

  // ── Save to TXT file ──
  const timestamp  = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename   = `${timestamp}_${callSid}.txt`;
  const filePath   = path.join(SUMMARIES_DIR, filename);

  try {
    fs.writeFileSync(filePath, fullSummary, 'utf8');
    console.log(`  💾  Resumen guardado: summaries/${filename}\n`);
  } catch (fileErr) {
    console.error('  ❌ Error guardando resumen en archivo:', fileErr.message);
  }

  // ── Send email ──
  try {
    const callerLabel = snap.callerPhone || 'desconocido';
    const subject = `📋 Llamada ${langLabel} | ${callerLabel} | ${min}m${sec}s | ${dateStr}`;
    await sendSummaryEmail(subject, fullSummary, filePath);
  } catch (emailErr) {
    console.error('  ❌ Error enviando email de resumen:', emailErr.message);
  }
}

// ─── 1. Incoming call → language selection ────────────────────────────────────
router.post('/incoming-call', async (req, res) => {
  const callSid = req.body?.CallSid;
  const session = createSession(callSid);
  session.callerPhone = req.body?.From || null;

  try {
    const [promptAudio, noResponseAudio] = await Promise.all([
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
      '\n' + noResponseAudio +
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
  const digit   = req.body?.Digits;
  const session = getSession(callSid) || createSession(callSid);

  let lang, greetingText;

  if (digit === '1') {
    lang         = 'es';
    greetingText = '¡Hola! Bienvenido a The Secret Spot. ¿En qué le podemos ayudar hoy?';
  } else if (digit === '2') {
    lang         = 'en';
    greetingText = 'Hi! Welcome to The Secret Spot. How can we help you today?';
  } else {
    try {
      const invalidAudio = await tts(
        'Opción no válida. Para español oprima 1. For English press 2.', session
      );
      res.type('text/xml');
      res.send(twiml(
        gather({
          action: '/select-language',
          input: 'dtmf',
          timeout: 8,
          numDigits: 1,
          children: invalidAudio,
        }) + '\n' + hangup()
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

// ─── 3. Conversational AI loop ────────────────────────────────────────────────
router.post('/ask-ai', async (req, res) => {
  const callSid     = req.body?.CallSid;
  const userMessage = req.body?.SpeechResult || '';
  const session     = getSession(callSid) || createSession(callSid);
  const lang        = session.lang || 'es';

  // ── Session expired ──
  if (isExpired(session)) {
    const snap   = snapshotSession(session);
    cleanupSession(callSid);
    const byeMsg = lang === 'es'
      ? '¡El tiempo máximo de la llamada fue alcanzado. Gracias por llamar a The Secret Spot! ¡Hasta luego!'
      : 'The maximum call time has been reached. Thank you for calling The Secret Spot! Goodbye!';
    try {
      const byeAudio = await tts(byeMsg, session);
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

  // ── No speech detected ──
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
        }) + '\n' + hangup()
      ));
    } catch {
      res.type('text/xml');
      res.send(twiml(hangup()));
    }
    return;
  }

  // ── Voice test trigger ──
  const VOICE_TEST_KW = [
    'probar voces', 'prueba de voz', 'test voices', 'probar voz',
    'voice test', 'escuchar voces', 'elegir voz', 'cambiar voz',
  ];
  if (VOICE_TEST_KW.some(kw => userMessage.toLowerCase().includes(kw))) {
    res.type('text/xml');
    res.send(twiml(redirect('/voice-test')));
    return;
  }

  console.log(`[${callSid}] 👤 (${lang}): ${userMessage}`);
  session.history.push({ role: 'user', content: userMessage });
  if (session.history.length > 30) session.history = session.history.slice(-30);

  try {
    const systemPrompt = lang === 'es' ? SYSTEM_PROMPT_ES : SYSTEM_PROMPT_EN;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 200,
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

    const rawReply = completion.choices[0]?.message?.content?.trim() ||
      (lang === 'es' ? '¿En qué más le puedo ayudar?' : 'How else can I help you?');

    const hasFin      = rawReply.includes('[FIN]');
    const hasTransfer = rawReply.includes('[TRANSFER]');
    const aiReply     = rawReply.replace(/\[FIN\]|\[TRANSFER\]/g, '').trim();

    // Never hang up mid-question
    const shouldEnd      = hasFin      && !aiReply.trimEnd().endsWith('?');
    const shouldTransfer = hasTransfer && !aiReply.trimEnd().endsWith('?');

    const marker = shouldEnd ? ' [FIN]' : shouldTransfer ? ' [TRANSFER]' : '';
    console.log(`[${callSid}] 🤖${marker}: ${aiReply}`);
    session.history.push({ role: 'assistant', content: aiReply });

    // ── End call ──
    if (shouldEnd) {
      const finalAudio = await tts(aiReply, session);
      const snap       = snapshotSession(session);
      cleanupSession(callSid);
      res.type('text/xml');
      res.send(twiml(finalAudio + '\n' + hangup()));
      generateCallSummary(callSid, snap).catch(err =>
        console.error(`[${callSid}] ❌ Summary error:`, err.message)
      );
      return;
    }

    // ── Transfer to staff ──
    if (shouldTransfer) {
      const transitionAudio = await tts(aiReply, session);
      res.type('text/xml');
      res.send(twiml(transitionAudio + '\n' + redirect('/transfer-menu')));
      return;
    }

    // ── Continue conversation — AI reply IS the gather prompt ──
    // No auto "¿hay algo más?" — the AI decides when to ask follow-ups
    const replyAudio = await tts(aiReply, session);

    res.type('text/xml');
    res.send(twiml(
      gather({
        action: '/ask-ai',
        input: 'speech',
        timeout: 6,
        speechTimeout: 'auto',
        language: lang === 'es' ? 'es-US' : 'en-US',
        children: replyAudio,
      }) +
      '\n' + redirect('/goodbye')
    ));

  } catch (error) {
    console.error(`[${callSid}] ❌ Error en AI loop:`, error.message);
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

// ─── 4. Goodbye ───────────────────────────────────────────────────────────────
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
    const byeAudio = await tts(byeMsg, session);
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

// ─── 5. Transfer menu (4 options) ────────────────────────────────────────────
router.post('/transfer-menu', async (req, res) => {
  const callSid = req.body?.CallSid;
  const session = getSession(callSid);
  const lang    = session?.lang || 'es';

  const menuText = lang === 'es'
    ? `Para hablar con ${STAFF[0].name_es}, oprima 1. ` +
      `Para ${STAFF[1].name_es}, oprima 2. ` +
      `Para ${STAFF[2].name_es}, oprima 3. ` +
      `Para ${STAFF[3].name_es}, oprima 4.`
    : `To speak with ${STAFF[0].name_en}, press 1. ` +
      `For ${STAFF[1].name_en}, press 2. ` +
      `For ${STAFF[2].name_en}, press 3. ` +
      `For ${STAFF[3].name_en}, press 4.`;

  const noInputText = lang === 'es'
    ? 'No recibimos su selección. Le conectamos con el equipo.'
    : 'We did not receive your selection. Connecting you now.';

  try {
    const [menuAudio, noInputAudio] = await Promise.all([
      tts(menuText, session),
      tts(noInputText, session),
    ]);
    res.type('text/xml');
    res.send(twiml(
      gather({
        action: '/select-staff',
        input: 'dtmf',
        timeout: 8,
        numDigits: 1,
        children: menuAudio,
      }) +
      '\n' + noInputAudio +
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

  const index = ['1', '2', '3', '4'].indexOf(digit);
  const staff = STAFF[index >= 0 ? index : 0];

  const connectingText = lang === 'es'
    ? `Un momento por favor, le estamos conectando con ${staff.name_es}.`
    : `One moment please, connecting you with ${staff.name_en}.`;

  console.log(`[${callSid}] 📲 Transferring to ${staff.name_es} (${staff.number})`);

  try {
    const connectingAudio = await tts(connectingText, session);
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

// ─── 7. Voice test (kept for internal QA) ────────────────────────────────────
router.post('/voice-test', async (req, res) => {
  const callSid  = req.body?.CallSid;
  const session  = getSession(callSid);
  const lang     = session?.lang || 'es';

  const sampleText = lang === 'es'
    ? 'Hola, soy la asistente de The Secret Spot. ¿En qué le puedo ayudar hoy?'
    : 'Hello, I am the assistant at The Secret Spot. How can I help you today?';
  const introText = lang === 'es'
    ? 'Escuchará dos opciones de voz. Presione 1 para la opción uno, presione 2 para la opción dos.'
    : 'You will hear two voice options. Press 1 for option one, press 2 for option two.';
  const label1    = lang === 'es' ? 'Opción uno.' : 'Option one.';
  const label2    = lang === 'es' ? 'Opción dos.' : 'Option two.';
  const chooseText = lang === 'es'
    ? 'Diga voz uno o voz dos para elegir.'
    : 'Say voice one or voice two to choose.';

  try {
    const [introAudio, labelAudio1, sample1, labelAudio2, sample2, chooseAudio] =
      await Promise.all([
        generateSpeechAzure(introText, lang),
        generateSpeechElevenLabs(label1),
        generateSpeechElevenLabs(sampleText),
        generateSpeechAzure(label2, lang),
        generateSpeechAzure(sampleText, lang),
        generateSpeechAzure(chooseText, lang),
      ]);

    res.type('text/xml');
    res.send(twiml(
      play(storeAudio(introAudio)) +
      '\n' + play(storeAudio(labelAudio1)) +
      '\n' + play(storeAudio(sample1)) +
      '\n' + play(storeAudio(labelAudio2)) +
      '\n' + play(storeAudio(sample2)) +
      '\n' +
      gather({
        action: '/voice-select',
        input: 'speech',
        timeout: 8,
        speechTimeout: 'auto',
        language: lang === 'es' ? 'es-US' : 'en-US',
        children: play(storeAudio(chooseAudio)),
      })
    ));
  } catch (err) {
    console.error(`[${callSid}] ❌ Voice test error:`, err.message);
    res.type('text/xml');
    res.send(twiml(redirect('/ask-ai')));
  }
});

router.post('/voice-select', async (req, res) => {
  const callSid = req.body?.CallSid;
  const speech  = (req.body?.SpeechResult || '').toLowerCase();
  const session = getSession(callSid);
  const lang    = session?.lang || 'es';

  const isOne = /uno|one|\bvoz 1\b|\bvoz one\b/.test(speech);
  if (session) session.ttsProvider = isOne ? 'elevenlabs' : 'azure';

  const confirmText = lang === 'es'
    ? 'Perfecto, usaremos esa voz. ¿En qué le puedo ayudar?'
    : 'Perfect, we will use that voice. How can I help you?';

  try {
    const confirmAudio = await tts(confirmText, session);
    res.type('text/xml');
    res.send(twiml(
      gather({
        action: '/ask-ai',
        input: 'speech',
        timeout: 5,
        speechTimeout: 'auto',
        language: lang === 'es' ? 'es-US' : 'en-US',
        children: confirmAudio,
      }) + '\n' + redirect('/goodbye')
    ));
  } catch (err) {
    console.error(`[${callSid}] ❌ Voice select error:`, err.message);
    res.type('text/xml');
    res.send(twiml(redirect('/ask-ai')));
  }
});

// ─── 8. Twilio status callback → cleanup + summary on unexpected disconnect ───
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
    console.log(`[${callSid}] 📴 Llamada terminada con estado: ${status}`);
  }

  res.sendStatus(200);
});

module.exports = router;
