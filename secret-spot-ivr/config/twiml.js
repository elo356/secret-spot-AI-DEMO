const BASE_URL = process.env.BASE_URL;

/**
 * Wrap TwiML verbs in a <Response> block.
 */
function twiml(content) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n${content}\n</Response>`;
}

/**
 * <Say> fallback if external TTS fails.
 */
function say(text, options = {}) {
  const attrs = [];
  if (options.voice) attrs.push(`voice="${options.voice}"`);
  if (options.language) attrs.push(`language="${options.language}"`);
  const attrString = attrs.length ? ` ${attrs.join(' ')}` : '';
  return `  <Say${attrString}>${escapeXml(text)}</Say>`;
}

/**
 * <Play> a URL for pre-generated audio
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
 * <Dial> to a phone number.
 */
function dial(number, options = {}) {
  const attrs = [];
  if (options.action) attrs.push(`action="${BASE_URL}${options.action}"`);
  if (options.method) attrs.push(`method="${options.method}"`);
  if (options.timeout) attrs.push(`timeout="${options.timeout}"`);
  if (options.answerOnBridge) attrs.push(`answerOnBridge="${options.answerOnBridge}"`);
  const attrString = attrs.length ? ` ${attrs.join(' ')}` : '';
  return `  <Dial${attrString}>${escapeXml(number)}</Dial>`;
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

module.exports = { twiml, say, play, redirect, gather, hangup, dial, escapeXml };
