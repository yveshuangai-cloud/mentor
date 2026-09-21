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
  await expect(page.locator('.result-title')).toBeVisible()
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

test('a finished result survives a reload and saves itself privately, with no extra tap', async ({ page }) => {
  await freshPlayer(page)
  await page.locator('#startBtn').click()
  await answerAll(page)
  const shown = await page.locator('.result-title').innerText()
  await expect(page.locator('.saved-chip')).toContainText('只有你看得到')
  await page.reload()
  await expect(page.locator('.result-title')).toHaveText(shown)
  // The app keeps its state in module scope, so read the stored profile back through the API with the same demo identity.
  const visibility = await page.evaluate(async () => {
    const token = 'local-demo:' + localStorage.getItem('aieq-demo-device')
    const res = await fetch('/api/aieq/me', { headers: { Authorization: 'Bearer ' + token } })
    return ((await res.json()) as { profile?: { visibility?: string } }).profile?.visibility
  })
  // Seeing your own result stores it; showing it to anyone else is still a separate opt-in.
  expect(visibility).toBe('private')
})

test('the result is one page: story, cover and share all live on the same scroll', async ({ page }) => {
  await freshPlayer(page)
  await page.locator('#startBtn').click()
  await answerAll(page)
  await expect(page.locator('[data-pane]')).toHaveCount(0)
  await expect(page.locator('#confirmBtn')).toHaveCount(0)
  await expect(page.locator('.result-title')).toBeVisible()
  await expect(page.locator('#coverSection')).toBeAttached()
  await page.locator('#toCover').click()
  await expect(page.locator('#coverSection')).toBeInViewport({ timeout: 4000 })
  // The share button lives at the end of that same scroll, no tab to find.
  await page.locator('#resultShareBtn').scrollIntoViewIfNeeded()
  await expect(page.locator('#resultShareBtn')).toBeInViewport()
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

test('the share page is ready to invite straight away, with no confirmation detour', async ({ page }) => {
  await freshPlayer(page)
  await page.locator('#startBtn').click()
  await answerAll(page)
  await page.locator('nav [data-view=friends]').click()
  await expect(page.locator('nav [data-view=friends]')).toHaveText('分享給好友')
  await expect(page.locator('#shareBtn')).toHaveText('邀請一位朋友')
  await expect(page.locator('#friendsHint')).not.toContainText('還沒確認')
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

test('one player can start at most three plays', async ({ page }) => {
  await freshPlayer(page)
  for (let play = 1; play <= 3; play++) {
    await page.locator('#startBtn').click()
    await answerAll(page, play % 3)
    await expect(page.locator('#replayBtn')).toContainText(`${play}/3`)
    if (play < 3) {
      await expect(page.locator('#replayBtn')).toBeEnabled()
      await page.locator('#replayBtn').click()
      await expect(page.locator('#startBtn')).toBeVisible()
    }
  }
  await expect(page.locator('#replayBtn')).toHaveText('已達上限 3/3')
  await expect(page.locator('#replayBtn')).toBeDisabled()
})

test('team feedback tag records a verdict with a note and remembers it after reload', async ({ page }) => {
  await freshPlayer(page)
  const tag = page.locator('#introTag .team-tag')
  await expect(tag).toHaveAttribute('data-spot', 'intro')
  await tag.getByRole('button', { name: '這裡規劃有問題' }).click()
  await tag.locator('textarea').fill('封面字太小')
  await tag.getByRole('button', { name: '送出回報' }).click()
  await expect(page.locator('#introTag .team-tag-note')).toContainText('已記錄：這裡規劃有問題（封面字太小）')
  await page.reload()
  await expect(page.locator('#introTag [data-verdict="issue"]')).toHaveClass(/active/)

  await page.locator('#startBtn').click()
  const questionTag = page.locator('#questionCard .team-tag')
  await expect(questionTag).toHaveAttribute('data-spot', 'question:q01_new_tool')
  await questionTag.getByRole('button', { name: '這裡規劃得很好' }).click()
  await expect(questionTag.locator('.team-tag-note')).toContainText('已記錄：這裡規劃得很好')
  // Answering still works with the tag below the choices.
  await page.locator('.choice').nth(0).click()
  await expect(page.locator('.counter')).toContainText('02')
})
