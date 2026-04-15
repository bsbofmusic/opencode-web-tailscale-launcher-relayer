"use strict"

const { chromium } = require('C:/Users/Maxlead/AppData/Roaming/npm/node_modules/playwright')

const routerUrl = process.env.TAILNET_ROUTER_URL || 'https://opencode.cosymart.top/'
const targetHost = process.env.TAILNET_TARGET_HOST || '100.121.130.36'
const targetPort = process.env.TAILNET_TARGET_PORT || '3000'

async function run(label) {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
  })

  const start = Date.now()
  let rootsAt = null
  let projAt = null
  let msgAt = null

  page.on('response', (res) => {
    const u = res.url()
    const t = Date.now() - start
    if (!rootsAt && /\/session\?directory=.*roots=true/.test(u)) rootsAt = t
    if (!projAt && /\/project\/current/.test(u)) projAt = t
    if (!msgAt && /\/session\/[^/]+\/message/.test(u)) msgAt = t
  })

  await page.goto(routerUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.locator('#host').fill(targetHost)
  await page.locator('#port').fill(targetPort)
  await page.evaluate(() => document.querySelector('#open')?.click())
  await page.waitForURL(/\/session\//i, { timeout: 90000 })
  await page.waitForTimeout(12000)

  const body = await page.locator('body').innerText()
  const result = {
    label,
    rootsAt,
    projAt,
    msgAt,
    hasOlder: body.includes('加载更早的消息'),
    bodyLen: body.length,
    finalUrl: page.url(),
  }

  await browser.close()
  return result
}

async function main() {
  const first = await run('first')
  const second = await run('second')
  process.stdout.write(JSON.stringify({ first, second }, null, 2) + '\n')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
