const openai = require('./openai');

const VOICE = process.env.OPENAI_TTS_VOICE || 'nova';

async function generateSpeech(text) {
  const response = await openai.audio.speech.create({
    model: 'tts-1',
    voice: VOICE,
    input: text,
    response_format: 'mp3',
  });

  return Buffer.from(await response.arrayBuffer());
}

module.exports = { generateSpeech };
