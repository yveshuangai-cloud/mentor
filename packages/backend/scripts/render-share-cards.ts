/**
 * Renders the 16 share cards (941x1672) from the dark result scenes plus a text layer.
 *
 * Layout follows the association's 2026-09-19 review:
 * - the top-left is left empty for the player's own name, which the LIFF page and the LINE Flex
 *   card draw on top, so the card says 「<名字> 的 AI 人格誌」 instead of carrying a wordmark;
 * - the animal and its title lead, with the four-letter shorthand small underneath;
 * - the green subtitle is a step larger than before;
 * - the closing block is 自然優勢.
 *
 * The portrait circle is left empty on purpose. It used to bake a stock face, which is what a
 * player saw when they saved the image. Its geometry is unchanged so the overlays still line up.
 *
 * Run: ./node_modules/.bin/tsx scripts/render-share-cards.ts
 */
import { chromium } from '/Users/weiting/.local/opt/playwright/node_modules/playwright/index.mjs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AIEQ_ANIMALS } from '../src/modules/aieq/catalog.js'

const backendDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoDir = join(backendDir, '../..')
const outDir = join(repoDir, 'output/design/ai-personality-share-cards-16')

const W = 941
const H = 1672
// The portrait circle the overlays fill: centre (773,192), radius 146.
const AVATAR = { cx: 773, cy: 192, r: 146 }

function page(animal: (typeof AIEQ_ANIMALS)[string], sceneDataUri: string, logoDataUri: string): string {
  const esc = (t: string) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string))
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@500;700;900&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
  *{margin:0;box-sizing:border-box}
  body{width:${W}px;height:${H}px;position:relative;overflow:hidden;background:#050505;
       font-family:"Noto Sans TC","PingFang TC",sans-serif;color:#f5f4f0;-webkit-font-smoothing:antialiased}
  .scene{position:absolute;inset:0;width:${W}px;height:${H}px;object-fit:cover}
  /* Scrims keep the type readable whatever the animal does behind it. */
  .top-scrim{position:absolute;left:0;right:0;top:0;height:620px;
             background:linear-gradient(180deg,#050505 0%,rgba(5,5,5,.95) 54%,rgba(5,5,5,0) 100%)}
  .bottom-scrim{position:absolute;left:0;right:0;bottom:0;height:430px;
                background:linear-gradient(0deg,#050505 0%,rgba(5,5,5,.93) 52%,rgba(5,5,5,0) 100%)}
  .ring{position:absolute;left:${AVATAR.cx - AVATAR.r}px;top:${AVATAR.cy - AVATAR.r}px;
        width:${AVATAR.r * 2}px;height:${AVATAR.r * 2}px;border-radius:50%;
        border:3px solid rgba(245,244,240,.16);background:rgba(245,244,240,.03)}
  .head{position:absolute;left:52px;top:300px;right:${W - 600}px}
  .name{font-size:76px;font-weight:900;line-height:1.06;letter-spacing:-.02em;white-space:nowrap}
  .name i{font-style:normal;color:#ff1785}
  .name b{font-weight:900;color:#f5f4f0}
  .name u{display:inline-block;width:3px;height:56px;background:rgba(245,244,240,.42);
          margin:0 26px;vertical-align:-6px;text-decoration:none}
  .code{margin-top:16px;font-family:"IBM Plex Mono",monospace;font-weight:400;font-size:40px;
        letter-spacing:.2em;color:#8f8f97}
  .tagline{margin-top:16px;font-size:34px;font-weight:700;line-height:1.45;color:#41ff78;letter-spacing:.01em}
  /* Stops short of the event mark: 941 - 318 = 623, and the mark starts at 647. */
  .edge{position:absolute;left:52px;bottom:96px;right:318px;border-left:7px solid #ff1785;padding-left:26px}
  .edge small{display:block;font-size:26px;font-weight:700;letter-spacing:.22em;color:#cfcfcf;margin-bottom:14px}
  .edge p{font-size:40px;font-weight:900;line-height:1.34;letter-spacing:-.01em}
  /* The event mark sits where the 2026-09-11 comp put it. Swap the source file for the
     official artwork when it arrives and re-run this script; nothing else has to change. */
  .event-logo{position:absolute;right:56px;bottom:76px;width:238px}
</style></head><body>
  <img class="scene" src="${sceneDataUri}" alt="">
  <div class="top-scrim"></div><div class="bottom-scrim"></div>
  <div class="ring"></div>
  <div class="head">
    <div class="name"><b>${esc(animal.name)}</b><u></u><i>${esc(animal.title)}</i></div>
    <div class="code">${esc(animal.displayCode)}</div>
    <div class="tagline">${esc(animal.tagline)}</div>
  </div>
  <div class="edge"><small>自然優勢</small><p>${esc(animal.edge)}</p></div>
  <img class="event-logo" src="${logoDataUri}" alt="2026 數位亞洲大會">
</body></html>`
}

const logo = `data:image/png;base64,${(await readFile(
  join(repoDir, 'assets/aieq/digiasia/digiasia-2026-mark-white.png'))).toString('base64')}`

// --scale 2 renders at twice the pixel size for review copies; --only <slug> does a single card.
const args = process.argv.slice(2)
const argOf = (name: string) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1] }
const scale = Number(argOf('--scale') ?? 1)
const only = argOf('--only')
const targetDir = argOf('--out') ? join(repoDir, argOf('--out') as string) : outDir

const browser = await chromium.launch()
const tab = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: scale })
let n = 0
for (const animal of Object.values(AIEQ_ANIMALS)) {
  if (only && animal.slug !== only) continue
  const scenePath = join(repoDir, animal.resultScenePath.replace('/aieq/scenes/', 'assets/ai-personality/scenes/'))
  const scene = `data:image/jpeg;base64,${(await readFile(scenePath)).toString('base64')}`
  await tab.setContent(page(animal, scene, logo), { waitUntil: 'load' })
  await tab.evaluate(() => document.fonts.ready)
  await tab.waitForTimeout(220)
  const file = animal.shareCardPath.split('/').pop() as string
  // A long closing line used to run under the event mark; refuse to ship a card where it still does.
  const clearance = await tab.evaluate(() => {
    const text = document.querySelector('.edge p') as HTMLElement
    const mark = document.querySelector('.event-logo') as HTMLElement
    const range = document.createRange()
    range.selectNodeContents(text)
    const lines = [...range.getClientRects()]
    const widest = Math.max(...lines.map((r) => r.right))
    const m = mark.getBoundingClientRect()
    return { gap: Math.round(m.left - widest), lines: lines.length }
  })
  if (clearance.gap < 16) throw new Error(`${file}: 「${animal.edge}」 comes within ${clearance.gap}px of the event mark`)
  const name = scale === 1 ? file : file.replace('.jpg', `@${scale}x.jpg`)
  await writeFile(join(targetDir, name), await tab.screenshot({ type: 'jpeg', quality: 92 }))
  n += 1
  console.log(`  ${name.padEnd(20)} ${W * scale}x${H * scale}  ${animal.edge.padEnd(14)} 距標誌 ${clearance.gap}px`)
}
await browser.close()
console.log(`\n${n} 張分享卡已重出（941x1672，頭像圈留空）`)
