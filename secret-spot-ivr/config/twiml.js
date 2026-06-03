const BASE_URL = process.env.BASE_URL;

/**
 * Wrap TwiML verbs in a <Response> block.
 */
function twiml(content) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n${content}\n</Response>`;
}

/**
 * <Say> with optional voice (kept as fallback)
 */
function say(text, voice = 'Polly.Joanna') {
  return `  <Say voice="${voice}">${escapeXml(text)}</Say>`;
}

/**
 * <Play> a URL (used with ElevenLabs pre-generated audio)
 */
function play(url) {
  return `  <Play>${url}</Play>`;
}

/**
 * <Redirect> to an internal route
 */
function redirect(path) {
  return `  <Redirect method="POST">${BASE_URL}${path}</Redirect>`;
}

/**
 * <Gather> that POSTs to an action route.
 * input can be "speech", "dtmf", or "speech dtmf"
 */
function gather({ action, input = 'speech', timeout = 5, speechTimeout = 'auto', numDigits, language, children = '' }) {
  const numDigitsAttr = numDigits ? ` numDigits="${numDigits}"` : '';
  const languageAttr = language ? ` language="${language}"` : '';
  return `  <Gather input="${input}" action="${BASE_URL}${action}" method="POST" timeout="${timeout}" speechTimeout="${speechTimeout}"${numDigitsAttr}${languageAttr}>\n${children}\n  </Gather>`;
}

/**
 * <Hangup/>
 */
function hangup() {
  return '  <Hangup/>';
}

/**
 * Escape XML special chars so AI responses don't break TwiML.
 */
function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

module.exports = { twiml, say, play, redirect, gather, hangup, escapeXml };
