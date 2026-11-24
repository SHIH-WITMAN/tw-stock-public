# 台股與 ETF 含息報酬趨勢觀察（Phase 1）

純靜態、免登入、非營利之台股與 ETF 含息報酬趨勢與年度報酬觀測原型。

## 架構特色
- **單一計算真理（Python 預產 `tri[]` / `pri[]`）**：盤後 Python 管線向 TWSE／TPEx 官方端點取得資料後，統一處理分割、配股、現金減資、彌補虧損減資與除息日收盤再投入，產出與官方交易日曆對齊的衍生累積指數。
- **前端零重型依賴（總計 ~62 KB）**：純 HTML + CSS + ES Modules + Canvas 2D 互動圖表，不依賴 Plotly 或資料庫，零 `innerHTML` 寫入並附嚴格 CSP（`web/_headers`）。
- **官方參考價發布閘門**：任一交易日官方參考價異動若在事件表中找不到對應事件，管線直接 fail-closed 中止切換 `latest.json`。
- **純訪客自選（無登入、無 Firestore）**：支援 `localStorage` 記憶、JSON 組合匯出／匯入、最新／固定快照雙模式分享連結與 2x PNG 圖卡匯出。

## 快速指令
```bash
# 執行 Python 與 Node 單元測試
python3 -B -m unittest discover -s tests -v
node --test tests/model.test.mjs

# 產製離線合成示範資料
python3 -B -m pipeline.build_public --synthetic

# 產製真實官方小樣本資料
python3 -B -m pipeline.build_public --tickers 0050,0056,00878,2330,2603,00679B --years 3

# 本機預覽靜態網站
python3 -m http.server 8899 --directory web
```

詳見：
- [Phase 0 官方來源實測與授權評估報告](docs/Phase0_官方來源實測與授權評估報告.md)
- [TWSE／TPEx 授權確認信草稿](docs/TWSE_TPEx_授權確認信草稿.md)
- [GitHub 建倉與試跑步驟教學](docs/GitHub_建倉與試跑步驟教學.md)
