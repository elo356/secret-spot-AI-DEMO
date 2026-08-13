require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const openai = require('../config/openai');
const { twiml, say, play, redirect, gather, hangup, dial } = require('../config/twiml');
const { generateSpeech } = require('../config/elevenlabs');
const { SYSTEM_PROMPT_EN, SYSTEM_PROMPT_ES } = require('../prompts/systemPrompts');
const { sendSummaryEmail } = require('../config/email');

const router = express.Router();

const BASE_URL = process.env.BASE_URL;
const CALL_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_HISTORY_MESSAGES = 24;
const TRANSFER_TIMEOUT_SECONDS = 18;
const DEFAULT_LANGUAGE = 'es';
const DEFAULT_TRANSFER_INDEX = 0;

const STAFF = [
  {
    key: 'nails',
    name_es: 'el area de unas',
    name_en: 'the nails area',
    number: normalizePhone(process.env.TRANSFER_1 || '7874126940'),
  },
  {
    key: 'salon',
    name_es: 'color, corte y blow bar',
    name_en: 'color, cuts, and blow bar',
    number: normalizePhone(process.env.TRANSFER_2 || '9392401685'),
  },
  {
    key: 'mens',
    name_es: 'el area de caballeros',
    name_en: "the men's area",
    number: normalizePhone(process.env.TRANSFER_3 || '7879302891'),
  },
  {
    key: 'test',
    name_es: 'la linea temporal de prueba',
    name_en: 'the temporary test line',
    number: normalizePhone(process.env.TRANSFER_4 || '9392312803'),
  },
];

const audioCache = new Map();
const callSessions = new Map();
const SUMMARIES_DIR = path.join(__dirname, '..', 'summaries');

fs.mkdirSync(SUMMARIES_DIR, { recursive: true });

function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return value.startsWith('+') ? value : `+${digits}`;
}

function languageCode(lang) {
  return lang === 'en' ? 'en-US' : 'es-US';
}

function getSession(callSid) {
  return callSessions.get(callSid);
}

function createSession(callSid) {
  const session = {
    lang: null,
    callerPhone: null,
    startTime: Date.now(),
    history: [],
    finalized: false,
    ttsChars: 0,
    oaiTokens: { prompt: 0, completion: 0 },
    sttTurns: 0,
    transferTarget: null,
  };
  callSessions.set(callSid, session);
  return session;
}

function getOrCreateSession(callSid) {
  return getSession(callSid) || createSession(callSid);
}

function isExpired(session) {
  return Date.now() - session.startTime > CALL_TIMEOUT_MS;
}

function cleanupSession(callSid) {
  callSessions.delete(callSid);
}

function snapshotSession(session) {
  return {
    ...session,
    history: session.history.map((turn) => ({ ...turn })),
    oaiTokens: { ...session.oaiTokens },
    transferTarget: session.transferTarget ? { ...session.transferTarget } : null,
  };
}

function finalizeSession(callSid) {
  const session = getSession(callSid);
  if (!session || session.finalized) return null;
  session.finalized = true;
  const snap = snapshotSession(session);
  cleanupSession(callSid);
  return snap;
}

function storeAudio(buffer) {
  const id = crypto.randomUUID();
  audioCache.set(id, buffer);
  setTimeout(() => audioCache.delete(id), 10 * 60 * 1000);
  return `${BASE_URL}/audio/${id}`;
}

async function tts(text, session) {
  const lang = session?.lang || DEFAULT_LANGUAGE;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const buffer = await generateSpeech(text, lang);
      if (session) session.ttsChars += text.length;
      return play(storeAudio(buffer));
    } catch (error) {
      console.error(`❌ Azure TTS attempt ${attempt} failed:`, error.message);
    }
  }

  return say(text, {
    language: languageCode(lang),
  });
}

function buildGatherResponse({ action, prompt, session, input = 'speech', timeout = 6, speechTimeout = 'auto', numDigits, language, fallbackPath = '/goodbye' }) {
  return twiml(
    gather({
      action,
      input,
      timeout,
      speechTimeout,
      numDigits,
      language,
      children: prompt,
    }) +
    '\n' + redirect(fallbackPath)
  );
}

function appendHistory(session, role, content) {
  session.history.push({ role, content });
  if (session.history.length > MAX_HISTORY_MESSAGES) {
    session.history = session.history.slice(-MAX_HISTORY_MESSAGES);
  }
}

function detectTransferSelection(req) {
  const digit = req.body?.Digits;
  if (['1', '2', '3', '4'].includes(digit)) {
    return Number(digit) - 1;
  }

  const speech = String(req.body?.SpeechResult || '').toLowerCase();
  if (!speech) return -1;

  if (/\b1\b|uno|one|unas|uñas|nails/.test(speech)) return 0;
  if (/\b2\b|dos|two|color|corte|blow/.test(speech)) return 1;
  if (/\b3\b|tres|three|caballeros|barber|hombres|mens|men's/.test(speech)) return 2;
  if (/\b4\b|cuatro|four|test|temporal|prueba/.test(speech)) return 3;
  return -1;
}

function detectSpecificDepartment(text = '') {
  const speech = String(text).toLowerCase();
  if (!speech) return null;

  if (/unas|uñas|nails|manicure|pedicure/.test(speech)) return STAFF[0];
  if (/color|corte|blow|blow bar|mechas|salon|salón|styling/.test(speech)) return STAFF[1];
  if (/caballeros|barber|barberia|barbería|hombres|mens|men's|beard|barba/.test(speech)) return STAFF[2];
  if (/test|temporal|prueba/.test(speech)) return STAFF[3];
  return null;
}

function isTransferIntent(text = '') {
  return /transfer|transfier|transfiere|transfiera|comunica|comunicar|hablar con|speak with|connect me|department|departamento|area|área/.test(String(text).toLowerCase());
}

function isDepartmentIntent(req) {
  const digit = req.body?.Digits;
  if (digit === '1') return true;

  const speech = String(req.body?.SpeechResult || '').toLowerCase();
  return /\b1\b|departamento|department|transfer|transferir|comunicar|area|área/.test(speech);
}

function departmentDecisionPrompt(lang) {
  if (lang === 'en') {
    return 'If you would like to contact a department, press or say 1. If you need information or want to leave your details for a future appointment call back, press or say 2.';
  }

  return 'Si desea comunicarse con un departamento, oprima o diga 1. Si desea informacion o dejar sus datos para una llamada de cita, oprima o diga 2.';
}

function infoGreeting(lang) {
  if (lang === 'en') {
    return 'Perfect. How can I help you today?';
  }

  return 'Perfecto. Como le puedo ayudar hoy?';
}

function staffMenuText(lang) {
  if (lang === 'en') {
    return [
      `To speak with ${STAFF[0].name_en}, press or say 1.`,
      `For ${STAFF[1].name_en}, press or say 2.`,
      `For ${STAFF[2].name_en}, press or say 3.`,
      `For ${STAFF[3].name_en}, press or say 4.`,
    ].join(' ');
  }

  return [
    `Para hablar con ${STAFF[0].name_es}, oprima o diga 1.`,
    `Para ${STAFF[1].name_es}, oprima o diga 2.`,
    `Para ${STAFF[2].name_es}, oprima o diga 3.`,
    `Para ${STAFF[3].name_es}, oprima o diga 4.`,
  ].join(' ');
}

async function sendSummary(callSid, snap) {
  if (!snap) return;
  try {
    await generateCallSummary(callSid, snap);
  } catch (error) {
    console.error(`[${callSid}] ❌ Summary error:`, error.message);
  }
}

async function generateCallSummary(callSid, snap) {
  const now = new Date();
  const durationSec = Math.max(1, Math.round((Date.now() - snap.startTime) / 1000));
  const min = Math.floor(durationSec / 60);
  const sec = durationSec % 60;
  const turns = Math.floor(snap.history.length / 2);
  const langLabel = snap.lang === 'en' ? 'English' : 'Español';
  const dateStr = now.toLocaleString('es-PR', { timeZone: 'America/Puerto_Rico' });
  const ttsCost = snap.ttsChars * 0.000016;
  const oaiCost = (snap.oaiTokens.prompt * 0.15 + snap.oaiTokens.completion * 0.6) / 1_000_000;
  const twilioMin = Math.max(1, Math.ceil(durationSec / 60));
  const twilioCost = twilioMin * 0.0085 + snap.sttTurns * 0.01;
  const total = ttsCost + oaiCost + twilioCost;
  const fmt = (amount) => `$${amount.toFixed(4)}`;
  const LINE = '═'.repeat(62);
  const DASH = '─'.repeat(62);
  const transferLine = snap.transferTarget
    ? `  Transferido a: ${snap.transferTarget.name_es} (${snap.transferTarget.number})`
    : '  Transferido a: no';

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
    transferLine,
    DASH,
    '  COSTO ESTIMADO',
    `  Azure TTS    ${String(snap.ttsChars).padStart(7)} chars    → ${fmt(ttsCost)}`,
    `  OpenAI       ${String(snap.oaiTokens.prompt + snap.oaiTokens.completion).padStart(7)} tokens   → ${fmt(oaiCost)}`,
    `  Twilio       ${String(twilioMin).padStart(3)}min + ${String(snap.sttTurns).padStart(2)} STT   → ${fmt(twilioCost)}`,
    `  ${'─'.repeat(42)}`,
    `  TOTAL                                    ${fmt(total)}`,
    DASH,
  ];

  console.log(headerLines.join('\n'));

  const analysisLines = ['  ANÁLISIS IA'];

  if (snap.history.length > 0) {
    const transcript = snap.history
      .map((turn) => `${turn.role === 'user' ? 'CLIENTE   ' : 'ASISTENTE'}: ${turn.content}`)
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
Analiza la transcripción y responde SOLO con JSON válido.

Incluye estos campos si aplican:
- caller_name
- phone_number
- language
- reason_for_call
- service_requested
- preferred_date
- preferred_time
- new_client
- appointment_requested
- appointment_data_collected
- urgency
- summary
- topics_discussed
- action_required
- follow_up_notes
- call_outcome
- transferred_to
- duration_seconds
- estimated_cost_usd

Si falta un dato, usa null, false, [] o "" según corresponda.`,
          },
          {
            role: 'user',
            content: `Caller phone: ${snap.callerPhone || ''}\nTransfer target: ${snap.transferTarget?.name_es || ''}\nTranscripción:\n${transcript}`,
          },
        ],
      });

      const raw = completion.choices[0]?.message?.content?.trim() || '{}';
      const parsed = JSON.parse(raw);
      if (snap.callerPhone) parsed.phone_number = snap.callerPhone;
      if (parsed.appointment_data_collected && snap.callerPhone) {
        parsed.appointment_data_collected.phone_number = snap.callerPhone;
      }
      if (!parsed.transferred_to && snap.transferTarget) parsed.transferred_to = snap.transferTarget.name_es;

      analysisLines.push(
        JSON.stringify(parsed, null, 2)
          .split('\n')
          .map((line) => `  ${line}`)
          .join('\n')
      );
    } catch (error) {
      console.error('  ❌ Error generando análisis IA:', error.message);
      analysisLines.push('  (error generando análisis)');
    }
  } else {
    analysisLines.push('  (sin conversación registrada)');
  }

  const transcriptLines = [DASH, '  TRANSCRIPCIÓN COMPLETA'];
  if (snap.history.length > 0) {
    snap.history.forEach((turn) => {
      const role = turn.role === 'user' ? 'CLIENTE   ' : 'ASISTENTE';
      transcriptLines.push(`  ${role}: ${turn.content}`);
    });
  } else {
    transcriptLines.push('  (sin transcripción)');
  }
  transcriptLines.push(LINE, '');

  const summaryLines = [DASH, '  RESUMEN FINAL', ...analysisLines.slice(1), LINE, ''];
  const fullSummary = [...headerLines, ...transcriptLines, ...summaryLines].join('\n');

  const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `${timestamp}_${callSid}.txt`;
  const filePath = path.join(SUMMARIES_DIR, filename);

  try {
    fs.writeFileSync(filePath, fullSummary, 'utf8');
    console.log(`  💾  Resumen guardado: summaries/${filename}`);
  } catch (error) {
    console.error('  ❌ Error guardando resumen en archivo:', error.message);
  }

  console.log([...transcriptLines, ...summaryLines].join('\n'));

  try {
    const subject = `Llamada ${langLabel} | ${snap.callerPhone || 'desconocido'} | ${min}m${sec}s | ${dateStr}`;
    await sendSummaryEmail(subject, fullSummary, filePath);
  } catch (error) {
    console.error('  ❌ Error enviando email de resumen:', error.message);
  }
}

router.get('/audio/:id', (req, res) => {
  const buffer = audioCache.get(req.params.id);
  if (!buffer) return res.sendStatus(404);
  res.set('Content-Type', 'audio/mpeg');
  return res.send(buffer);
});

router.get('/health', (req, res) => {
  const required = [
    'OPENAI_API_KEY',
    'BASE_URL',
    'AZURE_TTS_KEY',
    'AZURE_TTS_REGION',
  ];
  const missing = required.filter((key) => !process.env[key]);
  res.json({
    ok: missing.length === 0,
    missing,
    transfers: STAFF.map((staff) => ({
      key: staff.key,
      number: staff.number,
    })),
  });
});

router.post('/incoming-call', async (req, res) => {
  const callSid = req.body?.CallSid;
  const session = getOrCreateSession(callSid);
  session.callerPhone = normalizePhone(req.body?.From || '') || null;

  try {
    const [promptAudio, noResponseAudio] = await Promise.all([
      tts('Gracias por llamar a The Secret Spot. Para espanol, oprima 1. For English, press 2.', session),
      tts('No recibimos respuesta. Gracias por llamar. Goodbye.', session),
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
  } catch (error) {
    console.error(`[${callSid}] ❌ Error on incoming-call:`, error.message);
    res.type('text/xml');
    res.send(twiml(say('Gracias por llamar. Intente nuevamente mas tarde.') + '\n' + hangup()));
  }
});

router.post('/select-language', async (req, res) => {
  const callSid = req.body?.CallSid;
  const digit = req.body?.Digits;
  const session = getOrCreateSession(callSid);

  if (digit === '1') {
    session.lang = 'es';
  } else if (digit === '2') {
    session.lang = 'en';
  } else {
    const invalidPrompt = await tts('Opcion no valida. Para espanol oprima 1. For English press 2.', session);
    res.type('text/xml');
    res.send(twiml(
      gather({
        action: '/select-language',
        input: 'dtmf',
        timeout: 8,
        numDigits: 1,
        children: invalidPrompt,
      }) +
      '\n' + hangup()
    ));
    return;
  }

  const lang = session.lang;
  const greetingText = departmentDecisionPrompt(lang);
  const noResponseText = lang === 'en'
    ? "I didn't hear a response. Thank you for calling. Goodbye."
    : 'No escuche respuesta. Gracias por llamar. Hasta luego.';

  try {
    const [greetingAudio, noResponseAudio] = await Promise.all([
      tts(greetingText, session),
      tts(noResponseText, session),
    ]);

    res.type('text/xml');
    res.send(twiml(
      gather({
        action: '/entry-choice',
        input: 'speech dtmf',
        timeout: 6,
        speechTimeout: 'auto',
        language: languageCode(lang),
        numDigits: 1,
        children: greetingAudio,
      }) +
      '\n' + noResponseAudio +
      '\n' + hangup()
    ));
  } catch (error) {
    console.error(`[${callSid}] ❌ Error on select-language:`, error.message);
    res.type('text/xml');
    res.send(twiml(hangup()));
  }
});

router.post('/entry-choice', async (req, res) => {
  const callSid = req.body?.CallSid;
  const session = getOrCreateSession(callSid);
  const lang = session.lang || DEFAULT_LANGUAGE;

  if (isDepartmentIntent(req)) {
    res.type('text/xml');
    res.send(twiml(redirect('/transfer-menu')));
    return;
  }

  const replyAudio = await tts(infoGreeting(lang), session);
  res.type('text/xml');
  res.send(buildGatherResponse({
    action: '/ask-ai',
    prompt: replyAudio,
    session,
    input: 'speech',
    timeout: 6,
    speechTimeout: 'auto',
    language: languageCode(lang),
  }));
});

router.post('/ask-ai', async (req, res) => {
  const callSid = req.body?.CallSid;
  const session = getOrCreateSession(callSid);
  const lang = session.lang || DEFAULT_LANGUAGE;
  const userMessage = String(req.body?.SpeechResult || '').trim();
  const directDepartment = detectSpecificDepartment(userMessage);

  if (isExpired(session)) {
    const snap = finalizeSession(callSid);
    const byeText = lang === 'en'
      ? 'The call time limit has been reached. Thank you for calling The Secret Spot. Goodbye.'
      : 'Se alcanzo el tiempo maximo de la llamada. Gracias por llamar a The Secret Spot. Hasta luego.';
    const byeAudio = await tts(byeText, session);
    res.type('text/xml');
    res.send(twiml(byeAudio + '\n' + hangup()));
    await sendSummary(callSid, snap);
    return;
  }

  if (!userMessage) {
    const retryText = lang === 'en'
      ? "Sorry, I didn't catch that. How can I help you?"
      : 'Disculpe, no le escuche bien. En que le puedo ayudar?';
    const retryAudio = await tts(retryText, session);
    res.type('text/xml');
    res.send(buildGatherResponse({
      action: '/ask-ai',
      prompt: retryAudio,
      session,
      input: 'speech',
      timeout: 6,
      speechTimeout: 'auto',
      language: languageCode(lang),
    }));
    return;
  }

  console.log(`[${callSid}] 👤 (${lang}): ${userMessage}`);
  appendHistory(session, 'user', userMessage);

  if (directDepartment && isTransferIntent(userMessage)) {
    session.transferTarget = directDepartment;
    const connectingText = lang === 'en'
      ? `Of course. Connecting you with ${directDepartment.name_en}.`
      : `Claro. Le conecto con ${directDepartment.name_es}.`;
    appendHistory(session, 'assistant', connectingText);
    const connectingAudio = await tts(connectingText, session);
    res.type('text/xml');
    res.send(twiml(
      connectingAudio +
      '\n' +
      dial(directDepartment.number, {
        action: '/after-transfer',
        method: 'POST',
        timeout: TRANSFER_TIMEOUT_SECONDS,
        answerOnBridge: 'true',
      })
    ));
    return;
  }

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 180,
      temperature: 0.5,
      messages: [
        { role: 'system', content: lang === 'en' ? SYSTEM_PROMPT_EN : SYSTEM_PROMPT_ES },
        ...session.history,
      ],
    });

    if (completion.usage) {
      session.oaiTokens.prompt += completion.usage.prompt_tokens;
      session.oaiTokens.completion += completion.usage.completion_tokens;
    }
    session.sttTurns += 1;

    const rawReply = completion.choices[0]?.message?.content?.trim()
      || (lang === 'en' ? 'How can I help you?' : 'En que le puedo ayudar?');
    const hasFin = rawReply.includes('[FIN]');
    const hasTransfer = rawReply.includes('[TRANSFER]');
    const aiReply = rawReply.replace(/\[FIN\]|\[TRANSFER\]/g, '').trim();
    const shouldEnd = hasFin && !aiReply.endsWith('?');
    const shouldTransfer = hasTransfer && !aiReply.endsWith('?');

    console.log(`[${callSid}] 🤖: ${aiReply}${shouldEnd ? ' [FIN]' : shouldTransfer ? ' [TRANSFER]' : ''}`);
    appendHistory(session, 'assistant', aiReply);

    if (shouldEnd) {
      const finalAudio = await tts(aiReply, session);
      const snap = finalizeSession(callSid);
      res.type('text/xml');
      res.send(twiml(finalAudio + '\n' + hangup()));
      await sendSummary(callSid, snap);
      return;
    }

    if (shouldTransfer) {
      const transitionAudio = await tts(aiReply, session);
      res.type('text/xml');
      res.send(twiml(transitionAudio + '\n' + redirect('/transfer-menu')));
      return;
    }

    const replyAudio = await tts(aiReply, session);
    res.type('text/xml');
    res.send(buildGatherResponse({
      action: '/ask-ai',
      prompt: replyAudio,
      session,
      input: 'speech',
      timeout: 6,
      speechTimeout: 'auto',
      language: languageCode(lang),
    }));
  } catch (error) {
    console.error(`[${callSid}] ❌ Error in AI loop:`, error.message);
    const errorText = lang === 'en'
      ? 'We are having a technical issue right now. Please call again in a few moments.'
      : 'Estamos teniendo un problema tecnico en este momento. Por favor llame de nuevo en unos minutos.';
    const errorAudio = await tts(errorText, session);
    const snap = finalizeSession(callSid);
    res.type('text/xml');
    res.send(twiml(errorAudio + '\n' + hangup()));
    await sendSummary(callSid, snap);
  }
});

router.post('/goodbye', async (req, res) => {
  const callSid = req.body?.CallSid;
  const session = getSession(callSid);
  const lang = session?.lang || DEFAULT_LANGUAGE;
  const byeText = lang === 'en'
    ? 'Thank you for calling The Secret Spot. Have a great day.'
    : 'Gracias por llamar a The Secret Spot. Que tenga excelente dia.';
  const byeAudio = await tts(byeText, session);
  const snap = finalizeSession(callSid);

  res.type('text/xml');
  res.send(twiml(byeAudio + '\n' + hangup()));
  await sendSummary(callSid, snap);
});

router.post('/transfer-menu', async (req, res) => {
  const callSid = req.body?.CallSid;
  const session = getOrCreateSession(callSid);
  const lang = session.lang || DEFAULT_LANGUAGE;
  const promptAudio = await tts(staffMenuText(lang), session);

  res.type('text/xml');
  res.send(buildGatherResponse({
    action: '/select-staff',
    prompt: promptAudio,
    session,
    input: 'speech dtmf',
    timeout: 8,
    speechTimeout: 'auto',
    numDigits: 1,
    language: languageCode(lang),
    fallbackPath: '/transfer-timeout',
  }));
});

router.post('/transfer-timeout', async (req, res) => {
  const callSid = req.body?.CallSid;
  const session = getSession(callSid);
  const lang = session?.lang || DEFAULT_LANGUAGE;
  const staff = STAFF[DEFAULT_TRANSFER_INDEX];

  if (session) {
    session.transferTarget = staff;
  }

  const text = lang === 'en'
    ? `We did not receive a selection. Connecting you with ${staff.name_en}.`
    : `No recibimos una seleccion. Le conectamos con ${staff.name_es}.`;
  const audio = await tts(text, session);

  res.type('text/xml');
  res.send(twiml(
    audio +
    '\n' +
    dial(staff.number, {
      action: '/after-transfer',
      method: 'POST',
      timeout: TRANSFER_TIMEOUT_SECONDS,
      answerOnBridge: 'true',
    })
  ));
});

router.post('/select-staff', async (req, res) => {
  const callSid = req.body?.CallSid;
  const session = getSession(callSid);
  const lang = session?.lang || DEFAULT_LANGUAGE;
  const selection = detectTransferSelection(req);

  if (selection < 0) {
    const invalidText = lang === 'en'
      ? 'I did not understand the selection. Please choose an option again.'
      : 'No entendi la seleccion. Por favor escoja una opcion nuevamente.';
    const invalidAudio = await tts(invalidText, session);
    res.type('text/xml');
    res.send(buildGatherResponse({
      action: '/select-staff',
      prompt: invalidAudio,
      session,
      input: 'speech dtmf',
      timeout: 8,
      speechTimeout: 'auto',
      numDigits: 1,
      language: languageCode(lang),
      fallbackPath: '/transfer-timeout',
    }));
    return;
  }

  const staff = STAFF[selection];
  if (session) session.transferTarget = staff;

  const connectingText = lang === 'en'
    ? `One moment please. Connecting you with ${staff.name_en}.`
    : `Un momento por favor. Le estamos conectando con ${staff.name_es}.`;
  const connectingAudio = await tts(connectingText, session);

  console.log(`[${callSid}] 📲 Transferring to ${staff.name_es} (${staff.number})`);

  res.type('text/xml');
  res.send(twiml(
    connectingAudio +
    '\n' +
    dial(staff.number, {
      action: '/after-transfer',
      method: 'POST',
      timeout: TRANSFER_TIMEOUT_SECONDS,
      answerOnBridge: 'true',
    })
  ));
});

router.post('/after-transfer', async (req, res) => {
  const callSid = req.body?.CallSid;
  const dialStatus = req.body?.DialCallStatus;
  const session = getSession(callSid);
  const lang = session?.lang || DEFAULT_LANGUAGE;

  console.log(`[${callSid}] 📞 Transfer result: ${dialStatus || 'unknown'}`);

  if (['completed', 'answered'].includes(dialStatus)) {
    const snap = finalizeSession(callSid);
    res.type('text/xml');
    res.send(twiml(hangup()));
    await sendSummary(callSid, snap);
    return;
  }

  const retryText = lang === 'en'
    ? 'We could not complete that transfer. Please choose another area.'
    : 'No pudimos completar esa transferencia. Por favor escoja otra area.';
  const retryAudio = await tts(retryText, session);
  res.type('text/xml');
  res.send(buildGatherResponse({
    action: '/select-staff',
    prompt: retryAudio,
    session,
    input: 'speech dtmf',
    timeout: 8,
    speechTimeout: 'auto',
    numDigits: 1,
    language: languageCode(lang),
    fallbackPath: '/transfer-timeout',
  }));
});

router.post('/call-status', async (req, res) => {
  const callSid = req.body?.CallSid;
  const status = req.body?.CallStatus;

  if (['completed', 'busy', 'failed', 'no-answer', 'canceled'].includes(status)) {
    const snap = finalizeSession(callSid);
    if (snap) {
      await sendSummary(callSid, snap);
    }
    console.log(`[${callSid}] 📴 Llamada terminada con estado: ${status}`);
  }

  res.sendStatus(200);
});

module.exports = router;
