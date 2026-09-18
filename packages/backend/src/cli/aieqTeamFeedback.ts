// Prints the 團隊反饋 (team feedback) collected by the 「團隊回報小標籤」.
// Local:   DATABASE_URL=... node dist/cli/aieqTeamFeedback.js [limit]
// Staging: run it where the service's DATABASE_URL / DATABASE_PUBLIC_URL is available (railway run / railway ssh).
import { pool } from '../db/index.js'
import { summarizeTeamFeedback, teamFeedbackSpotLabel, VERDICT_LABELS } from '../modules/aieq/teamFeedback.js'

const limit = Math.min(Math.max(Number(process.argv[2] ?? 100) || 100, 1), 1000)
const asJson = process.argv.includes('--json')
const taipei = (iso: string) => new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false })

try {
  const summary = await summarizeTeamFeedback(limit)
  if (asJson) {
    console.log(JSON.stringify(summary, null, 2))
  } else {
    console.log(`團隊反饋：${summary.total} 則，來自 ${summary.reporters} 位團隊成員\n`)
    console.log('依畫面（問題多的排前面）')
    for (const spot of summary.bySpot) {
      console.log(`  ${teamFeedbackSpotLabel(spot.spot).padEnd(8, '　')} 很好 ${spot.good}　有問題 ${spot.issue}　其他 ${spot.other}　最近 ${taipei(spot.lastAt)}`)
    }
    console.log(`\n最近 ${summary.entries.length} 則`)
    for (const entry of summary.entries) {
      const who = entry.displayName ?? entry.lineUserId
      console.log(`  ${taipei(entry.createdAt)}｜${who}${entry.typeCode ? `（${entry.typeCode}）` : ''}｜${teamFeedbackSpotLabel(entry.spot)}｜${VERDICT_LABELS[entry.verdict]}${entry.comment ? `｜${entry.comment}` : ''}`)
    }
  }
} finally {
  await pool.end()
}
