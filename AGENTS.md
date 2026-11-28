# tw-stock-public（台股含息趨勢觀察・公開雲端版）開發接續指引

本專案為獨立之純靜態公開雲端版（`~/Projects/tw-stock-public/`），與個人本機帳務系統 `stockV2.1-Flask` 完全隔離。

## 必讀現行文件
- **[雲端版系統架構書](doc/雲端版系統架構書.md)**：本專案唯一現行系統架構、資料管線、計算口徑、前台介面、本機後台與 GitHub Actions 自動排程規範。
- [Phase 0 官方來源實測與授權評估報告](doc/Phase0_官方來源實測與授權評估報告.md)：官方 TWSE／TPEx 端點實測與授權分級依據。
- `doc/歷史規劃/` 內之規劃書與 Claude／Codex 審查意見為歷史封存參考，不代表現行規格；若與程式不符，以現行程式與 `doc/雲端版系統架構書.md` 為準。

## 不可違反之專案原則
1. **同步更新架構文件**：凡修改資料管線、財務口徑、前台功能／版面、本機後台、批次檔或 GitHub Actions 排程，**必須同步更新 [doc/雲端版系統架構書.md](doc/雲端版系統架構書.md) 及其修訂紀錄**。
2. **與本機個人版隔離**：不可讀寫 `stockV2.1-Flask` 正式資料庫，不可導入 FinMind、個人帳本、登入或 Firestore。
3. **資料發布與快取邊界**：`data_raw/`（官方原始行情與事件快取）僅存於本機與 GitHub Actions Cache，**永不提交進 Git**；`web/data/v/*/series/*.json` 僅發布衍生累積指數 `tri[]`/`pri[]`（最新單日收盤價僅放於 `catalog.json`）。`admin/` 僅供 `127.0.0.1` 本機管理，不可放進 `web/`。
4. **前端安全與嚴格 CSP**：`web/` 維持零外部依賴、零 `innerHTML`；動態樣式一律走 CSSOM（`node.style.setProperty`），不放寬 `web/_headers` 之 `style-src 'self'` 與 `script-src 'self'`。
5. **財務計算與比較原則**：
   - 含息趨勢與 ETF 年度報酬共用 Python 預產 `tri[]`/`pri[]`（`tri_ex_close_gross_v1`），官方參考價閘門採 fail-closed。
   - 含息趨勢維持「模式 A（公平同起點）」＋ 起算日逢中段停牌沿用停牌前基準（≤ 14 天）＋ 單選晚掛牌自動對齊上市日 ＋ 結束日共同收盤對齊（≤ 7 天）。
   - 全站預設統一以 `TAIEX 加權報酬指數` 作為一致對照基準；ETF 年度報酬頁 `TAIEX` 依報酬率參與排名並以醒目分界線標示。
6. **零外部金鑰排程**：GitHub Actions（`.github/workflows/daily-update.yml`）使用單次自動銷毀之 `GITHUB_TOKEN` 推送 `web/data/`，不強依賴外部 Cloudflare API Token；本機推送腳本維持 `git pull --rebase --autostash -X theirs origin main` 防衝突。

## 驗證指令
修改後執行：
```bash
python3 -B -m unittest discover -s tests -v
node --test tests/model.test.mjs tests/backtest.test.mjs
node --check web/js/app.js && node --check web/js/model.js && node --check web/js/backtest.js && node --check web/js/chart.js
```
