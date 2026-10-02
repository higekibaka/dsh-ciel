// Recorded browser observations only; this list never grants execution tools.
export const BROWSER_EVIDENCE_TOOLS = new Set([
  'browser_navigate', 'browser_console_messages', 'browser_take_screenshot',
  'browser_evaluate', 'browser_click', 'browser_press_key', 'browser_wait_for',
  'browser_select_option', 'browser_fill_form', 'browser_snapshot', 'browser_network_requests',
].map(name => 'mcp__playwright__' + name))
export const EPHEMERAL_EVIDENCE_TOOLS = new Set(['bash', 'web_search', 'web_fetch', ...BROWSER_EVIDENCE_TOOLS])
