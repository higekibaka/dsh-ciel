import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { readFile, mkdir, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

/** An owned, isolated browser profile. Never attaches to a user's existing tab. */
export async function launchOwnedBrowser(checkout) {
  const require = createRequire(join(checkout, 'apps/web/package.json'))
  const { chromium } = require('playwright')
  const executable = process.env.CIEL_CHROME_PATH || chromium.executablePath()
  if (existsSync(executable)) {
    const browser = await chromium.launch({ headless: true, executablePath: executable })
    return { browser, kind: 'playwright-linux', async close() { await browser.close() } }
  }
  const chrome = process.env.CIEL_WINDOWS_CHROME || '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe'
  if (!existsSync(chrome)) throw new Error('No isolated Chromium is available')
  const name = 'ciel-gui-' + randomUUID()
  const profile = '/mnt/c/temp/' + name
  await mkdir(profile, { recursive: true })
  const child = spawn(chrome, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions',
    '--disable-default-apps', '--disable-client-side-phishing-detection', '--disable-domain-reliability',
    '--metrics-recording-only', '--disable-breakpad', '--disable-features=Translate,OptimizationHints,MediaRouter',
    '--remote-debugging-port=0', '--user-data-dir=C:' + String.fromCharCode(92) + 'temp' + String.fromCharCode(92) + name, 'about:blank',
  ], { stdio: 'ignore' })
  let port
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    try {
      const first = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split(String.fromCharCode(10))[0]
      if (/^[0-9]+$/.test(first)) { port = Number(first); break }
    } catch { /* only our own newly created profile is polled */ }
    if (child.exitCode !== null) break
    await delay(200)
  }
  if (!port) { child.kill(); throw new Error('Owned Chrome did not announce its DevTools port') }
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port)
  return { browser, kind: 'windows-chrome-cdp', async close() {
    // Closing a CDP connection may only disconnect Playwright. Ask our owned
    // browser to exit explicitly so Windows releases profile files.
    try { const control = await browser.newBrowserCDPSession(); await control.send('Browser.close') } catch { /* closed transport is expected */ }
    await browser.close().catch(() => {}); child.kill()
    for (let i = 0; i < 100; i++) {
      try { await rm(profile, { recursive: true, force: true }); return } catch { await delay(100) }
    }
    throw new Error('Owned browser profile could not be removed')
  } }
}
