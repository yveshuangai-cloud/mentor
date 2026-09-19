/** Finds the first row of each result scene where the animal itself begins,
 *  ignoring the faint city grid by requiring a long run of strong pixels. */
import { chromium } from '/Users/weiting/.local/opt/playwright/node_modules/playwright/index.mjs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AIEQ_ANIMALS } from '../src/modules/aieq/catalog.js'

const repoDir = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const browser = await chromium.launch()
const page = await browser.newPage()
await page.setContent('<canvas id=c></canvas>')
const tops: Record<string, number> = {}
for (const animal of Object.values(AIEQ_ANIMALS)) {
  const file = join(repoDir, animal.resultScenePath.replace('/aieq/scenes/', 'assets/ai-personality/scenes/'))
  const b64 = (await readFile(file)).toString('base64')
  const top = await page.evaluate(async (data) => {
    const img = new Image(); img.src = 'data:image/jpeg;base64,' + data; await img.decode()
    const c = document.getElementById('c') as HTMLCanvasElement
    c.width = img.width; c.height = img.height
    const ctx = c.getContext('2d')!; ctx.drawImage(img, 0, 0)
    const d = ctx.getImageData(0, 0, img.width, img.height).data
    for (let y = 0; y < img.height; y++) {
      let run = 0
      for (let x = 0; x < img.width; x++) {
        const i = (y * img.width + x) * 4
        const [r, g, b] = [d[i], d[i + 1], d[i + 2]]
        const strong = r + g + b > 210 || (r > 110 && r - b > 45)
        run = strong ? run + 1 : 0
        if (run >= 55) return y
      }
    }
    return img.height
  }, b64)
  tops[animal.slug] = top
  console.log(`  ${animal.slug.padEnd(11)} ${animal.name.padEnd(4)} 動物起始 y=${top}`)
}
await browser.close()
console.log('\n最高的動物：y=' + Math.min(...Object.values(tops)))
