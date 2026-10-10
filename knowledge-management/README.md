# 饅頭本機知識管理 CLI

獨立的 Python 標準函式庫工具，將**明確指定的專案目錄**中的 UTF-8 Markdown／純文字索引到私人 SQLite。提供繁中關鍵字搜尋、全文讀回與來源 SHA、日期、類型、狀態。不讀取人格、不更動既有 App 或資料庫、不傳送內容、不連網、不需要 Railway。

## 最短使用流程

需要 Python 3.10+（含 SQLite），沒有第三方套件。以下只用虛構測試資料；請把專案目錄與資料庫位置改成你批准的本機路徑。

```sh
python3 knowledge-management/mantou_km.py --db "$HOME/.local/share/mantou-knowledge/example.sqlite3" ingest --project-root "$PWD/knowledge-management/fixtures"
python3 knowledge-management/mantou_km.py --db "$HOME/.local/share/mantou-knowledge/example.sqlite3" search '品牌 行銷'
python3 knowledge-management/mantou_km.py --db "$HOME/.local/share/mantou-knowledge/example.sqlite3" info
python3 knowledge-management/mantou_km.py --db "$HOME/.local/share/mantou-knowledge/example.sqlite3" get 1
```

預設 DB 是使用者家目錄下 `.local/share/mantou-knowledge/index.sqlite3`。此工具拒絕把 DB 放在**本程式的公開 Git checkout**，即使被 gitignore 也拒絕。其他 checkout 中必須先讓 DB 被 gitignore；沒有 Git 可核對時拒絕寫入。新建 DB 檔案權限 0600，新建 DB 直接父目錄 0700；不保證整個使用者家目錄或原有父目錄的權限，也不提供磁碟加密。

## 索引範圍與更新

第一次 ingest 將 DB 固定綁定 `--project-root` 的真實路徑；之後不能把另一個專案混進同一 DB。每專案用獨立 DB，可降低跨客戶混查。不能指定家目錄或檔案系統根目錄作專案。

```sh
python3 knowledge-management/mantou_km.py --db /approved/private/index.sqlite3 ingest --project-root /approved/project --path knowledge/corpus
```

`--path` 可選目錄或單檔，但必須在授權根目錄內。全根目錄更新會清掉來源已刪除或改成排除類型的舊內容；部分範圍更新只清該範圍，不影響其他已索引文件。SHA 相同不重建內容；來源檔不會被寫入。來源無法讀取或不是 UTF-8 時整輪交易回滾，不宣稱完整索引，也不刪掉先前紀錄。

每筆資料含相對來源路徑、原始位元組 SHA-256、副檔名、來源修改時間 UTC、索引時間 UTC、標題、狀態及全文。`source_date` 只接受開頭30行中明寫的 `date:`／`source_date:`／`日期：YYYY-MM-DD`，也接受 ISO 時間中的日期部分；保留來源明示的日曆日期，不推算或轉換發布時區。沒有日期為 null，不把任意內文日期當發布日。SHA相同仍更新解析 metadata，方便修正解析版本。`status:`／`狀態：` 原樣存為來源標籤，未提供為 `unspecified`，不推定已核准或完成。這些來源是資料，工具不執行文件內的指令。

## 繁中搜尋

SQLite `instr` 實作 Unicode NFKC 正規化後的大小寫不敏感 literal substring。`品牌 行銷` 代表兩詞均須出現，完整中文詞不需要斷詞；百分號與底線沒有萬用字元作用。使用參數綁定，不拼接查詢內容。每次預設最多20筆、可設1–100筆；排序按相對路徑，不宣稱語意相關性排序。

這條實作不需要 FTS5，也不依賴各機器的 trigram tokenizer 支援；代價是大型資料集需掃描。這是本機專案級工具，未測數十萬份文件。NFKC 不是簡繁轉換，繁中／簡中不同字形需使用實際字形搜尋。摘要是最多240字的文字片段，完整內容可 `get` 讀回。

## 排除資料

- 只允許 `.md`、`.markdown`、`.txt`，單檔至多2 MiB；JSON、資料庫、媒體不索引。
- 不追蹤檔案或目錄符號連結；選定路徑有符號連結就拒絕。
- 排除 `.git`、`node_modules`、`private`、`local-data`、`secrets`、`credentials` 等目錄。
- 檔案或目錄名稱含 secret／credential／password／API key／access token／`.env` 亦排除。
- 內文偵測私鑰標頭、常見金鑰格式、非 placeholder 的 password/token/key 賦值；疑似憑證檔整份跳過，更新時刪掉其先前索引內容。
- `secure_delete` 加 `VACUUM` 清除 SQLite 中已刪除內容的殘留頁；**不能清除備份、檔案系統快照、曾被複製的 DB 或作業系統暫存**。

這是明確規則與保守啟發式，不能保證辨認所有秘密；新型格式或寫在自然語言裡的秘密可能漏判，也可能誤判正常文字。先準備允許索引的語料目錄，未核准資料不要放入。合法的本機私人信件來源 metadata、郵件地址本身不會被當成 API 憑證；它們仍只存在本機 DB，不能提交公開 repo。

CLI 的搜尋結果可能含私人資料，只在本機查看；不要把終端輸出、DB、查詢匯出或真實 fixtures 貼到公開 issue 或 commit。本模組 `.gitignore` 排除 DB／private；實際資料在其他目錄時也須自行排除。本模組沒有伺服器、網頁或網路埠。

## 驗證

```sh
python3 -m unittest discover -s knowledge-management -p 'test_mantou_km.py' -v
```

測試全部使用虛構 fixtures 和暫存目錄，涵蓋繁中、全形／ASCII、literal特殊字元、metadata/SHA、原始來源不變、修改重建、刪除清理、部分範圍更新、UTF-8錯誤回滾、secret/private排除、符號連結、越界與DB跨專案重綁拒絕、檔案權限與公開checkout DB拒絕。

未串接正式租戶系統或人格記憶；目前資料隔離是本機 DB 與指定專案，不是雲端多租戶權限系統。

## 選用：本地 MCP 介面

MCP橋接使用MIT授權的[官方Python SDK](https://github.com/modelcontextprotocol/python-sdk/tree/v1.x)，版本固定於requirements-mcp.txt；CLI本身仍不需要第三方套件。

在獨立venv安裝requirements-mcp.txt，設定MANTOU_KB_ROOT與MANTOU_KB_DB為已索引且彼此綁定的專案與私人資料庫，再啟動mantou_mcp.py。採stdio傳輸，不開HTTP埠、不下載LLM。提供knowledge_info、knowledge_search、knowledge_get及knowledge_refresh；工具參數不可指定其他路徑。宿主需重新載入MCP設定才會取得工具。

安裝SDK後可執行全部11項測試：

```sh
python -m unittest discover -s knowledge-management -p 'test_*.py' -v
```

協定測試只使用合成來源；包含真實stdio初始化與呼叫、全文狀態核對、錯誤參數、來源不被refresh改動、跨專案DB啟動拒絕。
