// Credential-shaped text admission check; no filesystem access.
const PLACEHOLDER_VALUE = /^(?:\.{2,}|…+|<[^<>]*>|\{\{?[^{}]*\}?\}|\[(?:redacted|hidden|removed|masked|secret|token|api[-_ ]?key)\]|x{3,}|\*{3,}|-{3,}|redacted|hidden|masked|placeholder|example|sample|dummy|your[-_ ].*|changeme|change[-_ ]?me|password|passwd|token|secret|api[-_ ]?key|access[-_ ]?token|client[-_ ]?secret|todo|tbd|null|none|undefined|true|false|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|process\.env\.[A-Za-z_][A-Za-z0-9_]*|env\.[A-Za-z_][A-Za-z0-9_]*)$/i

/** The shortest value a real credential-shaped field is expected to carry. */
const SECRET_MIN_LENGTH = 8

/** Wrapper punctuation a documented placeholder is commonly quoted or listed in. */
const TRAILING_PUNCTUATION = /[)\]}>"'\u0060+,;:!?。，、；：！？）】」』]+$/u

/** Strip the wrapper punctuation a placeholder may be wrapped in. */
function cleanValue(value) {
  return value.replace(TRAILING_PUNCTUATION, '')
}

/** Whether a captured credential-shaped value is a placeholder, not a secret. */
function placeholderValue(value) {
  const cleaned = cleanValue(value)
  if (cleaned.length < SECRET_MIN_LENGTH && value.length < SECRET_MIN_LENGTH) return true
  return PLACEHOLDER_VALUE.test(cleaned) || PLACEHOLDER_VALUE.test(value)
}

/** Whether any query parameter carries a credential-looking value. */
function querySecret(text) {
  for (const match of text.matchAll(/[?&](?:access_token|api_key|token|password|secret)=([^\s&#"'\u0060<>]+)/gi)) {
    if (!placeholderValue(match[1])) return true
  }
  return false
}

/** Whether any assignment or key carries a quoted credential-looking value. */
function assignedSecret(text) {
  const quoted = /\b(?:[A-Za-z0-9_]*(?:password|passwd|api_?key|access_?token|auth_?token|client_?secret|private_?key)|secret|token)\s*["']?\s*[:=]\s*["'\u0060]([^"'\u0060\r\n]{4,})["'\u0060]/gi
  for (const match of text.matchAll(quoted)) {
    if (!placeholderValue(match[1])) return true
  }
  const bare = /\b(?:PASSWORD|PASSWD|API_KEY|ACCESS_TOKEN|CLIENT_SECRET|SECRET)\s*=\s*([^\s"'\u0060;$]{4,})/g
  for (const match of text.matchAll(bare)) {
    if (!placeholderValue(match[1])) return true
  }
  return false
}

/** Returns only a boolean, never matched text. False is NOT a guarantee of safety. */
export function detectSensitiveText(text) {
  if (typeof text !== 'string') return true
  return /-----BEGIN (?:[A-Z0-9 ]*PRIVATE KEY|OPENSSH PRIVATE KEY)-----/.test(text)
    || /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}|\bxox[baprs]-[A-Za-z0-9-]{10,}/.test(text)
    || /\bAIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])|\bnpm_[A-Za-z0-9]{36,}(?![A-Za-z0-9])/.test(text)
    || /\b(?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s/@:]+:[^\s/@]+@/i.test(text)
    || querySecret(text)
    || /\b(?:authorization\s*[:=]\s*["'\u0060]?\s*)?(?:Bearer\s+[A-Za-z0-9._~+/-]{12,}|Basic\s+[A-Za-z0-9+/]{12,}={0,2})/i.test(text)
    || assignedSecret(text)
}
