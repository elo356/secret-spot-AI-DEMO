const VOICE_ES = process.env.GOOGLE_TTS_VOICE_ES || 'es-US-Neural2-B';
const VOICE_EN = process.env.GOOGLE_TTS_VOICE_EN || 'en-US-Neural2-F';

async function generateSpeech(text, lang = 'es') {
  const apiKey = process.env.GOOGLE_TTS_API_KEY;
  const voice  = lang === 'en' ? VOICE_EN : VOICE_ES;
  const langCode = lang === 'en' ? 'en-US' : 'es-US';

  const response = await fetch(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: langCode, name: voice },
        audioConfig: { audioEncoding: 'MP3' },
      }),
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Google TTS ${response.status}: ${errText}`);
  }

  const { audioContent } = await response.json();
  return Buffer.from(audioContent, 'base64');
}

module.exports = { generateSpeech };
