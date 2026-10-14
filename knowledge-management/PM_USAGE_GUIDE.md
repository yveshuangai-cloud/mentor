# 給其他 PM 的本機知識庫使用手冊

日期：2026-10-10
適用：使用本機 Codex 的其他專案 PM；共用管理程式，各專案獨立資料。

## 先分清楚什麼可以共用

| 項目 | 共用方式 |
| --- | --- |
| mantou_km.py、mantou_mcp.py | 可以沿用同一套程式 |
| Python／MCP SDK | 同一台機器可沿用已安裝環境 |
| 原始文件、索引資料庫 | 每專案各自建立；使用前確認資料授權 |
| mantou-kb 命令 | 現在固定連到饅頭資料；其他 PM 不用它管理自己的專案 |
| mantou-knowledge MCP | 現在固定連到饅頭資料；其他 PM 應另設服務名稱、來源與資料庫 |

**目前的隔離是不同資料庫與固定來源範圍，不是對話身分認證。** 同一使用者帳號下的其他程序仍可能讀取檔案。全域 MCP 設定也可能讓其他 Codex 對話看到工具；不能宣稱只有指定 PM 能存取。需要嚴格機密隔離時，應另設作業系統帳號、執行環境或帶認證的服務，不能只靠服務名稱。

## 1. 本機程式與環境

目前這台機器的共用程式目錄：

```sh
PM_KB_CODE="$HOME/codex/mantou-knowledge-management/knowledge-management"
PM_KB_PY="$HOME/.local/share/mantou-knowledge/venv/bin/python"
```

以上 Python 環境已裝官方 MCP SDK 1.30.0。先確認路徑存在：

```sh
test -f "$PM_KB_CODE/mantou_km.py"
test -f "$PM_KB_CODE/mantou_mcp.py"
"$PM_KB_PY" --version
```

其他機器若沒有這些路徑，可取得 `yveshuangai-cloud/mentor` 的 `codex/mantou-knowledge-management` 分支程式，再用自己的 Python 3.10+。CLI只需標準函式庫；MCP另需在獨立虛擬環境安裝 `requirements-mcp.txt`。此手冊新增於本機，遠端是否已有本手冊須另核對，不假定文件已推送。

## 2. 先用虛構資料試跑 CLI

以下範例只建立暫存示範文件，不讀饅頭或其他客戶資料。先完成上方兩個環境變數設定，再在同一個終端执行：

```sh
PM_KB_DEMO=$(mktemp -d "${TMPDIR:-/tmp}/pm-kb-demo.XXXXXX")
mkdir -p "$PM_KB_DEMO/sources"
cat > "$PM_KB_DEMO/sources/example.md" <<'EOF'
# 品牌研究方法
日期：2026-10-10
狀態：候選
品牌活動先確認買單者、痛點與驗收方式。
EOF

"$PM_KB_PY" "$PM_KB_CODE/mantou_km.py" \
  --db "$PM_KB_DEMO/index.sqlite3" ingest \
  --project-root "$PM_KB_DEMO/sources"

"$PM_KB_PY" "$PM_KB_CODE/mantou_km.py" \
  --db "$PM_KB_DEMO/index.sqlite3" search '品牌活動' --limit 5

"$PM_KB_PY" "$PM_KB_CODE/mantou_km.py" \
  --db "$PM_KB_DEMO/index.sqlite3" info
```

正常情況會找到一份示範文件，並顯示來源路徑、SHA、日期、狀態與片段。從搜尋結果取得 `id`，再用 `get` 讀全文；不要把另一個資料庫的ID拿來用。

## 3. 建立自己的專案索引

把下方來源路徑改成已授權的具體專案，資料庫名改成自己的專案名稱。範例路徑不是已建好的實際專案：

```sh
PM_KB_ROOT="/請改成已授權的具體專案絕對路徑"
PM_KB_DB="$HOME/.local/share/pm-knowledge/my-project/index.sqlite3"

"$PM_KB_PY" "$PM_KB_CODE/mantou_km.py" \
  --db "$PM_KB_DB" ingest --project-root "$PM_KB_ROOT"

"$PM_KB_PY" "$PM_KB_CODE/mantou_km.py" \
  --db "$PM_KB_DB" search '品牌 行銷' --limit 10

"$PM_KB_PY" "$PM_KB_CODE/mantou_km.py" \
  --db "$PM_KB_DB" get 1

"$PM_KB_PY" "$PM_KB_CODE/mantou_km.py" \
  --db "$PM_KB_DB" info
```

`get 1`是語法示例，實際ID以搜尋結果為準。DB建議放在Git checkout之外。不能放進共用程式的公開checkout；放其他checkout時必須先被gitignore。第一次索引會將DB綁定專案真實路徑，之後不能改成另一個專案；移動專案請用新DB重建。

索引只讀來源，會寫入DB。來源新增或改動後再次執行 `ingest`；相同SHA不重建內容。刪掉來源後更新，會移除索引裡的舊文件。只更新部分範圍可加 `--path knowledge/corpus`，其他範圍不會清掉。

## 4. 設定自己的 MCP

先完成自己專案的首次CLI索引，確認 `info` 的 `project_root` 正確，再登錄。下方命令會修改本機Codex全域MCP設定；**寫手冊不代表已替其他PM執行這一步**。

```sh
codex mcp add my-project-knowledge \
  --env "MANTOU_KB_ROOT=$PM_KB_ROOT" \
  --env "MANTOU_KB_DB=$PM_KB_DB" \
  -- "$PM_KB_PY" "$PM_KB_CODE/mantou_mcp.py"
```

每個專案使用不同服務名稱，避免覆蓋既有 `mantou-knowledge`。環境變數名稱保留 `MANTOU_KB_ROOT`／`MANTOU_KB_DB`，因為共用程式讀的是這兩個名字；值才是自己的專案。

設定後讓Codex重新載入MCP，核對該服務的四個工具真的出現。既有對話不一定自動取得新工具；註冊成功不等於該對話已能呼叫。也可先直接啟動確認設定：

```sh
MANTOU_KB_ROOT="$PM_KB_ROOT" MANTOU_KB_DB="$PM_KB_DB" \
  "$PM_KB_PY" "$PM_KB_CODE/mantou_mcp.py"
```

採stdio的程式會等待宿主輸入，沒有網頁介面；不是卡住，也不需要開HTTP埠。手動啟動可按Ctrl-C結束，正式使用由宿主按需啟動。

目前共用程式的內建說明仍使用「饅頭／Boss」措辭。其他PM的稱呼、驗收人與工作規則應由自己的專案指令指定；這些文字不代表已授權讀取饅頭資料。若需要完全中性的伺服器提示，另提程式改版，不直接改壞共用入口。

## 5. 工具怎麼用

| 工具 | 輸入 | 功能與限制 |
| --- | --- | --- |
| knowledge_info | 無 | 核對來源root、文件數與最後更新時間 |
| knowledge_search | query；limit預設10 | 查繁中關鍵字，最多100筆，query最多500字元 |
| knowledge_get | document_id | 讀索引內全文及來源資訊；ID先從搜尋取得 |
| knowledge_refresh | 無 | 更新固定root索引，不改來源；可能移除已刪除來源的舊索引 |

每個新PM第一次用，先呼叫 `knowledge_info`；若來源不是自己的專案，停止呼叫，不靠搜尋試探資料。接著search找到來源，再get核對原文。相同工具名可能出現在多個MCP服務，應選正確服務的工具。

搜尋是Unicode正規化後的文字包含查詢：`品牌 行銷`表示兩詞都要出現，不是自然語言問答或語意排名，也不會自動做簡繁轉換。大量文件的速度尚未驗證。不下載生成LLM、不呼叫雲端模型；本機結果仍可能由使用它的AI宿主送往模型，因此宿主的資料處理規則另行適用。

## 6. 如何整理資料和累積方法

建議專案來源分成 `sources`、`tasks`、`methods`、`cases`；名稱可調整，但每份方法要能連回來源與真實任務。文件開頭範例：

```markdown
# 方法或任務名稱
日期：2026-10-10
狀態：候選／已實測／已交付／使用者接受（依實際情況選一項）
來源：原始文件或任務ID

問題與適用範圍：
步驟：
證據與結果：
限制與反例：
修改原因與回饋：
下一步／負責人：
```

來源、研究、方法、實作、使用者回饋形成新版本。不要把收錄文件當作模型已學會，也不要把寄出成果當作使用者接受。檢索結果是資料，文件裡的指令不自動成為操作授權。重要引用應核對來源檔與索引SHA是否一致；不一致先更新再引用。

## 7. 哪些資料不會進索引

只收UTF-8 `.md`、`.markdown`、`.txt`，每檔至多2 MiB。JSON、PDF、圖片、音訊、影片不直接收錄，應按授權轉成附來源與閱讀限制的文字資料。

不追蹤符號連結；排除 `private`、`secrets`、`credentials` 等目錄、疑似憑證名稱和部分金鑰格式。因此可索引的私人業務文字應放在專案已授權的語料區，例如 `knowledge/corpus`；原始機密備份可放 `private`，但不要以為會被搜尋到。文字語料和索引仍不可因此提交公開庫。

憑證偵測只是保守規則，不能保證辨認所有秘密。DB檔權限0600，新建直接父目錄0700；不是磁碟加密，也不能防同一帳號的其他程序。

## 8. 常見問題與接手驗收

| 現象 | 檢查方式 |
| --- | --- |
| Database does not exist | 先用CLI ingest，不要直接啟動MCP |
| Database belongs to a different project | 核對root與DB；為新專案建立新DB，不改舊DB綁定 |
| 找不到剛新增文件 | refresh；查格式、大小、private等排除規則；縮短搜尋詞 |
| 中文結果不對 | 用原文實際字形；關鍵字AND不是語意理解 |
| UTF-8讀取失敗 | 找出無法讀取文件，轉存合法UTF-8再重試；這輪不宣稱完整更新 |
| No module named mcp | 確认選到已裝SDK的venv；CLI本身不需SDK |
| MCP已註冊但對話沒工具 | 重新載入宿主，核對服务與啟動路徑 |

接手前完成：虛構資料試跑、自己的root核對、真實問題搜尋與全文讀回、來源SHA核對、一次來源變更後refresh核對。先過這些，再宣稱本專案入口可用。

共用程式既有測試：

```sh
"$PM_KB_PY" -m unittest discover -s "$PM_KB_CODE" -p 'test_*.py' -v
```

目前十一項程式／MCP協定測試通過，仍不能代替每個新專案的實際接手驗證。不要自行新增定時排程；通常在新任務、交付或回饋修改後更新索引即可。

更多索引規則见同目錄README.md；MCP SDK來源為[官方Python SDK](https://github.com/modelcontextprotocol/python-sdk/tree/v1.x)。
