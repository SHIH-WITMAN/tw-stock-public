# 台股含息趨勢觀察（公開免費雲端版）

- **開發設計者**：witman
- **線上網址**：`https://tw-stock-public.pages.dev/`
- **完整架構與規格書**：請參閱 **[doc/雲端版系統架構書.md](doc/雲端版系統架構書.md)**

純靜態、免登入、非營利之台股與 ETF 含息報酬趨勢與年度報酬觀測平台（與個人本機版 `stockV2.1-Flask` 完全隔離）。

## 架構亮點
- **單一計算真理（Python 預產 `tri[]` / `pri[]`）**：100% 向 TWSE／TPEx 官方端點取得資料（零 FinMind），統一處理分割、配股、現金／虧損減資、有償現金增資除權、颱風休市順延除息與除息日收盤再投入。
- **官方參考價發布閘門（Fail-Closed）**：任一交易日官方參考價異動若在事件表無對應紀錄，直接中止切換 `latest.json`。
- **極致輕量與資安（~83 KB、零外部套件）**：純 HTML + CSS + ES Modules + Canvas 2D HiDPI 互動圖表，零 `innerHTML`、全 CSSOM 樣式並通過嚴格 CSP（`web/_headers`）。
- **零外部金鑰全自動更新**：GitHub Actions 平日 18:30 自動抓取官方盤後資料、命中雲端 `data_raw/` 快取並以臨時 `GITHUB_TOKEN` 推回 `web/data/`，自動觸發 Cloudflare Pages 部署。
- **本機專用管理後台與離線預覽**：內建 `127.0.0.1:8898` 本機管理介面（搜尋 15,000+ 官方字典、啟用／隱藏標的、維護快速組合）與 `127.0.0.1:8899` 完全離線前台預覽工具。

## 常用指令與工具
- **本機後台管理**：雙擊 `開啟後台管理.command`
- **本機離線預覽**：雙擊 `離線開啟前台預覽.command`
- **本機抓資料並推送**：雙擊 `更新每日資料並推送.command`
- **推送程式與文件更新**：雙擊 `推送程式更新.command`

```bash
# 執行 Python 與 Node 單元測試
python3 -B -m unittest discover -s tests -v
node --test tests/model.test.mjs

# 產製 5 年官方衍生指數
python3 -B -m pipeline.build_public --years 5
```

## 文件索引
- **[雲端版系統架構書](doc/雲端版系統架構書.md)**（現行唯一架構與設計規範，後續變更須同步更新）
- [Phase 0 官方來源實測與授權評估報告](doc/Phase0_官方來源實測與授權評估報告.md)
- [TWSE／TPEx 授權確認信草稿](doc/TWSE_TPEx_授權確認信草稿.md)
- [GitHub 建倉與試跑步驟教學](doc/GitHub_建倉與試跑步驟教學.md)
- 歷史規劃封存：`doc/歷史規劃/`（原規劃書、Claude 審查意見、Codex 審查與改善方案）
