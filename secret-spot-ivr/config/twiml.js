const BASE_URL = process.env.BASE_URL;

/**
 * Wrap TwiML verbs in a <Response> block.
 */
function twiml(content) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n${content}\n</Response>`;
}

/**
 * <Say> with optional voice
 */
function say(text, voice = 'Polly.Joanna') {
  return `  <Say voice="${voice}">${escapeXml(text)}</Say>`;
}

/**
 * <Gather> that POSTs to an action route.
 * input can be "speech", "dtmf", or "speech dtmf"
 */
function gather({ action, input = 'speech', timeout = 5, speechTimeout = 'auto', numDigits, children = '' }) {
  const numDigitsAttr = numDigits ? ` numDigits="${numDigits}"` : '';
  return `  <Gather input="${input}" action="${BASE_URL}${action}" method="POST" timeout="${timeout}" speechTimeout="${speechTimeout}"${numDigitsAttr}>\n${children}\n  </Gather>`;
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

module.exports = { twiml, say, gather, hangup, escapeXml };
