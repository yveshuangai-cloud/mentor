# 📞 漫漫「打電話」— 即時雙向語音通話功能包

這是 **漫漫（吳慢慢）AI 的即時雙向語音通話**功能的前後端程式碼快照，從主線抽出來打包成一個自足資料夾，方便單獨檢視／移植／重用。

> ⚠️ **快照**：抽包自 commit `7a7fb2e`（分支 `voice-call-package`）。這裡是**副本**，主線在 `packages/backend`、`packages/liff`。要跑正式版請回主線。
> ⚠️ 部分後端模組（大腦、prompt 組裝、config、db、skill 載入等）是**跨功能共用**的，沒有全部拷進來——見下方「共用相依」。

---

## 這是什麼

使用者在 LINE 裡開啟 LIFF 頁面 → 按下通話 → 手機麥克風的聲音即時串流到後端 → 語音辨識 → 漫漫的大腦串流生成 → 語音合成串流回放，**像真的打電話一樣一來一往**（目標延遲 ~1.5–2 秒）。

## 資料流（一通電話怎麼跑）

```
LINE App
  └─ LIFF 前端 (packages/liff)  ← 這個包的 frontend/
       │  麥克風 PCM 音訊
       │  WebSocket  wss://<後端>/api/voice-call/ws
       ▼
後端 WS 路由 (routes/voice-call.ts)  ← backend/routes/
       ▼
語音通話引擎 (voice-pipeline.ts)  ── 統籌一通電話的生命週期、輪次、打斷
       ├─ 即時語音辨識  streaming-asr.ts        （使用者說的話 → 文字）
       ├─ 通話大腦      voice-brain.ts           （串流生成漫漫的回話；接主線 brain/記憶/人格）
       ├─ 語音合成      minimax-realtime.ts / minimax-tts.ts / mouth.ts（回話 → 音訊串流）
       ├─ 語音濾波      voice/echo-filter.ts / voice/bg-filter.ts / voice/tts-player.ts
       ├─ 通話品質判斷  voice-judge.ts
       └─ session 管理  voice-session.ts
       ▼
   音訊串流回 LIFF 播放（BreathingOrb/Waveform 視覺化）
```

通話邀請（漫漫主動邀對方打電話的 Flex 卡片）：`voice-call-trigger.ts`。

---

## 檔案清單

### 後端 `backend/`
| 檔案 | 作用 |
|------|------|
| `routes/voice-call.ts` | **WS 入口**：`POST /api/voice-call/session`（預檢）、`GET /sessions`（管理）、`WS /api/voice-call/ws`（通話通道）|
| `modules/voice-pipeline.ts` | **核心引擎**：一通電話的統籌（輪次、打斷、收尾、摘要、掛斷後內心獨白）|
| `modules/voice-brain.ts` | 通話大腦：串流生成漫漫回話（接主線人格/記憶/憲法）|
| `modules/streaming-asr.ts` | 即時語音辨識（串流 ASR）|
| `modules/minimax-realtime.ts` | MiniMax 即時串流 TTS |
| `modules/minimax-tts.ts` | MiniMax TTS（合成）|
| `modules/mouth.ts` | 輸出層：語音合成前的文字清理／情緒／發音（與文字路徑共用）|
| `modules/ear.ts` | Whisper 語音辨識／校正（批次；與訊息路徑共用）|
| `modules/voice-session.ts` | 通話 session 狀態 |
| `modules/voice-judge.ts` | 通話品質／狀態判斷 |
| `modules/voice-call-trigger.ts` | 漫漫主動邀請打電話的 Flex 卡片 + 推送 |
| `modules/voice/echo-filter.ts` | 回音消除 |
| `modules/voice/bg-filter.ts` | 背景雜訊過濾 |
| `modules/voice/tts-player.ts` | TTS 播放排程 |
| `modules/voice/utils.ts` | 音訊工具 |

### 前端 `frontend/`（整個 LIFF App，React + Vite）
| 檔案 | 作用 |
|------|------|
| `src/App.tsx` / `src/main.tsx` | App 入口 |
| `src/components/CallScreen.tsx` | 通話主畫面 |
| `src/components/BreathingOrb.tsx` / `Waveform.tsx` | 通話中的視覺化（呼吸球／聲波）|
| `src/components/DialTone.tsx` | 撥號音 |
| `src/components/MicPermission.tsx` | 麥克風權限 |
| `src/components/MonologuePanel.tsx` | 內心獨白面板 |
| `src/components/HealthIndicator.tsx` | 連線健康指示 |
| `src/components/RainWindow.tsx` / `LocationConsentCard.tsx` | 氛圍／地點同意 |
| `src/hooks/useWebSocket.ts` | **與後端的 WS 雙向通訊**（連 `/api/voice-call`）|
| `src/hooks/useAudio.ts` | 麥克風擷取 + 音訊播放 |
| `src/lib/liff.ts` | LINE LIFF SDK 初始化 |
| `public/audio/fillers/*.mp3` | 思考時的填充語音（減少延遲空白感）|
| `vite.config.ts` / `wrangler.toml` / `tailwind` … | 建置／部署設定（前端部署在 Cloudflare Pages）|

---

## 環境變數

### 前端（`frontend/.env.example` — 皆為 client 端公開值，非機密）
```
VITE_LIFF_ID=<LINE LIFF app id>
VITE_WS_URL=wss://<後端網域>/api/voice-call/ws
```

### 後端（機密，放後端 `.env` / Secret Manager，**不在此包**）
```
DEEPGRAM_API_KEY=      # 即時 ASR
MINIMAX_API_KEY=       # 串流 TTS
MINIMAX_GROUP_ID=       # 國際版通常留空；舊帳號要求時才填
VOICE_ID_ZH= / VOICE_ID_EN=   # 聲紋
ANTHROPIC_API_KEY= / OPENROUTER_API_KEY=（或 Vertex ADC）  # 通話大腦
LINE_CHANNEL_TOKEN= / LINE_CHANNEL_SECRET=
LIFF_ID=
```

---

## WS 路由怎麼掛（主線 `packages/backend/src/index.ts`）
```ts
import { voiceCallRoutes } from './routes/voice-call.js';
await app.register(voiceCallRoutes, { prefix: '/api/voice-call' }); // 📞 語音通話 WebSocket
// 另需處理 WebSocket upgrade 請求（見 index.ts：upgrade header 判斷，避免 ERR_HTTP_SOCKET_ASSIGNED）
```

## 怎麼跑
- **前端**：`cd frontend && npm i && npm run dev`（或 `npm run build` → 部署 Cloudflare Pages / `wrangler.toml`）。設好 `.env`（`VITE_LIFF_ID`/`VITE_WS_URL`）。
- **後端**：這些模組要放回一個有 Fastify + `@fastify/websocket` + 主線共用模組的後端裡跑；把 `voice-call.ts` register 到 `/api/voice-call`。

---

## 共用相依（**不在此包**，移植時要一併帶）
通話大腦與輸出會呼叫主線這些共用件：`modules/brain.ts`（文字大腦/prompt 組裝）、`promptBuilder.ts`、`skillLoader.ts`、`soulContext.ts`、`memory.ts`、`config.ts`、`db/`、`replyStyle.ts`、`timeUtils.ts` 等。單獨移植語音通話時，這些要嘛一起帶、要嘛換成對應實作。

---

*打包者：快快（漫漫的保姆 Agent）· 快照 commit 7a7fb2e*
