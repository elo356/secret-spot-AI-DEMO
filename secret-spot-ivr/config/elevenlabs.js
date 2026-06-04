const VOICE_ES = process.env.AZURE_TTS_VOICE_ES || 'es-US-PalomaNeural';
const VOICE_EN = process.env.AZURE_TTS_VOICE_EN || 'en-US-JennyNeural';

async function generateSpeech(text, lang = 'es') {
  const key    = process.env.AZURE_TTS_KEY;
  const region = process.env.AZURE_TTS_REGION;
  const voice  = lang === 'en' ? VOICE_EN : VOICE_ES;
  const langCode = lang === 'en' ? 'en-US' : 'es-US';

  const ssml = `<speak version='1.0' xml:lang='${langCode}'>
    <voice name='${voice}'>${text}</voice>
  </speak>`;

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
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Azure TTS ${response.status}: ${errText}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

module.exports = { generateSpeech };
