import { expect, test, type Page } from '@playwright/test'

// Each test gets its own demo player: the page derives the identity from localStorage.
async function freshPlayer(page: Page) {
  await page.goto('/aieq')
  await page.evaluate(() => localStorage.setItem('aieq-demo-device', `pw-${Math.random().toString(36).slice(2, 12)}`))
  await page.goto('/aieq')
  await expect(page.locator('#startBtn')).toBeVisible()
}

async function answerAll(page: Page, pick = 1) {
  for (let i = 0; i < 8; i++) {
    const choices = page.locator('.choice')
    await expect(choices).toHaveCount(3)
    await choices.nth(pick).click()
    await page.waitForTimeout(700)
  }
  await expect(page.locator('.result-code')).toBeVisible()
}

const inFirstScreen = async (page: Page, selector: string) =>
  page.locator(selector).evaluate((el) => { const b = el.getBoundingClientRect(); return b.top >= 0 && b.bottom <= window.innerHeight })

test('start button is on the first screen', async ({ page }) => {
  await freshPlayer(page)
  expect(await inFirstScreen(page, '#startBtn')).toBe(true)
})

test('all three options stay on the first screen for every question, with equal heights', async ({ page }) => {
  await freshPlayer(page)
  await page.locator('#startBtn').click()
  for (let i = 0; i < 8; i++) {
    const choices = page.locator('.choice')
    await expect(choices).toHaveCount(3)
    const boxes = await choices.evaluateAll((els) => els.map((el) => { const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, h: b.height } }))
    for (const b of boxes) { expect(b.top).toBeGreaterThanOrEqual(0); expect(b.bottom).toBeLessThanOrEqual(page.viewportSize()!.height) }
    expect(Math.max(...boxes.map((b) => b.h)) - Math.min(...boxes.map((b) => b.h))).toBeLessThanOrEqual(1)
    await choices.nth(i % 3).click()
    await page.waitForTimeout(700)
  }
})

test('back works and a rapid triple tap sends one answer', async ({ page }) => {
  await freshPlayer(page)
  await page.locator('#startBtn').click()
  await page.locator('.choice').nth(0).click()
  await expect(page.locator('.counter')).toContainText('02')
  await page.locator('[data-kind=back]').click()
  await expect(page.locator('.counter')).toContainText('01')
  const posts: string[] = []
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().includes('/events')) posts.push(r.url()) })
  const c = page.locator('.choice')
  await Promise.all([c.nth(2).click({ force: true }), c.nth(0).click({ force: true }), c.nth(1).click({ force: true })])
  await page.waitForTimeout(1500)
  expect(posts).toHaveLength(1)
  await expect(page.locator('.counter')).toContainText('02')
})

test('a finished but unconfirmed result survives a reload, then confirm keeps it private', async ({ page }) => {
  await freshPlayer(page)
  await page.locator('#startBtn').click()
  await answerAll(page)
  const code = await page.locator('.result-code').innerText()
  await page.reload()
  await expect(page.locator('.result-code')).toHaveText(code)
  await page.locator('#confirmBtn').click()
  await expect(page.locator('#resultCard .panel')).toContainText('結果已確認')
  const visibility = await page.evaluate(() => (window as unknown as { profile?: { visibility?: string } }).profile?.visibility)
  expect(visibility).toBe('private')
})

test('the radar grows only once it is scrolled to the middle of the screen', async ({ page }) => {
  await freshPlayer(page)
  await page.locator('#startBtn').click()
  await answerAll(page)
  const shape = page.locator('.radar-shape')
  await expect(shape).toHaveAttribute('points', '160,150 160,150 160,150 160,150')
  await page.locator('.radar').evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await page.waitForTimeout(1400)
  const target = await shape.getAttribute('data-target')
  await expect(shape).toHaveAttribute('points', target!)
})

test('friends page guides an unconfirmed player to the confirm button', async ({ page }) => {
  await freshPlayer(page)
  await page.locator('#startBtn').click()
  await answerAll(page)
  await page.locator('nav [data-view=friends]').click()
  await expect(page.locator('#shareBtn')).toHaveText('先去確認結果，再邀請朋友')
  await page.locator('#shareBtn').click()
  await expect(page.locator('#resultView')).toBeVisible()
  await expect(page.locator('.panel.needs-confirm')).toBeVisible()
  await expect(page.locator('#confirmBtn')).toBeFocused()
})

test('friends of friends appear only after opting in, then replay clears everything', async ({ page }) => {
  await freshPlayer(page)
  await page.locator('#startBtn').click()
  await answerAll(page)
  await page.locator('nav [data-view=friends]').click()
  await expect(page.locator('#friendList')).not.toContainText('經由')
  await page.locator('#fofToggle').check()
  await expect(page.locator('#friendList')).toContainText('經由')
  await page.locator('#replayBtn').click()
  await expect(page.locator('#startBtn')).toBeVisible()
})
