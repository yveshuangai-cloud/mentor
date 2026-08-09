# MiniMax Speech 2.8 官方情緒與聲音標籤

本表以 MiniMax 國際版現行 Speech 2.8 文件為準。模型頁標示 7 種情緒；T2A HTTP 文件列出 19 種 interjection tags。

## 七種情緒

| API 值 | 用途 |
|---|---|
| `happy` | 開心、祝賀、感謝、明亮鼓勵 |
| `sad` | 悲傷、失落、歉意、同理陪伴 |
| `angry` | 憤怒、不公、堅定界線 |
| `fearful` | 害怕、危險、擔憂 |
| `disgusted` | 噁心、厭惡、嚴重反感 |
| `surprised` | 驚訝、驚喜、意外發現 |
| `calm` | 冷靜、安定、沉著引導 |

沒有明確情緒時省略 `voice_setting.emotion`。`neutral` 不是 Speech 2.8 的七種情緒之一；`fluent` 與 `whisper` 是舊版文件中的特殊模式，不作為 Speech 2.8 標準情緒。

## 十九種非語言聲音標籤

| MiniMax 標籤 | 中文語意 |
|---|---|
| `(laughs)` | 大笑、自然笑聲 |
| `(chuckle)` | 輕笑、低聲笑 |
| `(coughs)` | 咳嗽 |
| `(clear-throat)` | 清喉嚨 |
| `(groans)` | 呻吟、低吟 |
| `(breath)` | 呼吸、深呼吸 |
| `(pant)` | 喘氣、喘息 |
| `(inhale)` | 吸氣 |
| `(exhale)` | 吐氣、呼氣 |
| `(gasps)` | 驚呼、倒吸一口氣 |
| `(sniffs)` | 抽鼻子、吸鼻子 |
| `(sighs)` | 嘆氣 |
| `(snorts)` | 哼鼻子、噴鼻息 |
| `(burps)` | 打嗝 |
| `(lip-smacking)` | 咂嘴、嘴唇聲 |
| `(humming)` | 哼唱 |
| `(hissing)` | 嘶聲、噓聲 |
| `(emm)` | 嗯、沉吟 |
| `(sneezes)` | 打噴嚏 |

## 其他控制

- 停頓格式：`<#x#>`，`x` 為 `0.01` 到 `99.99` 秒。
- Speech 2.8 語速可用範圍為 `0.5` 到 `2.0`；饅頭只在自然人聲的小範圍內調整。
- 音量範圍為大於 `0` 到 `10`，音高範圍為 `-12` 到 `12`。
- 追查問題時記錄 model、emotion（省略時記為 auto）、speed、pitch、interjections 與 `trace_id`。

## 官方來源

- https://platform.minimax.io/docs/guides/models-intro
- https://platform.minimax.io/docs/api-reference/speech-t2a-http
- https://platform.minimax.io/docs/guides/mcp-guide
