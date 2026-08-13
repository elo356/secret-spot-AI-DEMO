const VOICE_ES = process.env.AZURE_TTS_VOICE_ES || 'es-US-PalomaNeural';
const VOICE_EN = process.env.AZURE_TTS_VOICE_EN || 'en-US-JennyNeural';
const REQUEST_TIMEOUT_MS = parseInt(process.env.AZURE_TTS_TIMEOUT_MS || '15000', 10);

async function generateSpeech(text, lang = 'es') {
  const key    = process.env.AZURE_TTS_KEY;
  const region = process.env.AZURE_TTS_REGION;
  const voice  = lang === 'en' ? VOICE_EN : VOICE_ES;
  const langCode = lang === 'en' ? 'en-US' : 'es-US';

  if (!key || !region) {
    throw new Error('Azure TTS is not configured. Missing AZURE_TTS_KEY or AZURE_TTS_REGION.');
  }

  const safe = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const ssml = `<speak version='1.0' xml:lang='${langCode}'>
    <voice name='${voice}'>${safe}</voice>
  </speak>`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(
      `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,
      {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': key,
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': 'audio-16khz-128kbitrate-mono-mp3',
        },
        body: ssml,
        signal: controller.signal,
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Azure TTS ${response.status}: ${errText}`);
    }

    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Azure TTS timeout after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { generateSpeech };
