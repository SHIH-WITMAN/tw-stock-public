# Phase 1 試跑操作與獨立 GitHub 建倉教學（選項 A）

本專案已完整獨立建置於 `~/Projects/tw-stock-public/`，與你原本的個人 `stockV2.1-Flask` 完全隔離。

---

## 一、先在本機預覽目前的 Phase 1 原型（30 秒）

目前專案內已用 `--synthetic` 產好 40 檔標的（含 0050 分割、2603 現金減資、00679B 上櫃債券 ETF、國外成分 ETF）的示範資料，可直接在本機瀏覽器打開試玩：

```bash
cd ~/Projects/tw-stock-public
python3 -m http.server 8899 --directory web
```

打開瀏覽器造訪 `http://127.0.0.1:8899`，你可以實測：
- **含息趨勢頁**：套用中性主題範本、點卡片複選自動縮放 Y 軸、匯出 PNG 圖卡、切換深淺主題、匯出／匯入組合設定檔、複製「最新」或「固定快照」分享連結。
- **ETF 年度報酬頁**：確認預設依代號升冪、債券型／國外成分股不對比台股大盤並附類別中位數、存續偏誤提示。
- **資料狀態與口徑頁**：查看版本號、演算法版本、來源顯名與健檢狀態。

### 改跑「真實 TWSE／TPEx 官方資料」小樣本試跑（約 1～2 分鐘）
```bash
cd ~/Projects/tw-stock-public
"$HOME/.venvs/stockV2.1-Flask/bin/python" -B -m pipeline.build_public \
  --tickers 0050,0056,00878,2330,2603,00679B --years 3
```
> 註：原始官方回應只會暫存在本機 `data_raw/`（已列進 `.gitignore`，**絕不會進 Git，也不會發布到 `web/data/`**）；前端 `web/data/` 僅放衍生累積指數 `tri[]` / `pri[]`。

---

## 二、建立獨立的 Private GitHub Repository（一步一步做）

### 步驟 1：在 GitHub 網頁開一個空的 Private Repo
1. 登入 GitHub → 右上角 `+` → **New repository**。
2. **Repository name**：填 `tw-stock-public`。
3. **Visibility**：先選 **Private**（選項 A 內部試跑期；等 TWSE／TPEx 授權確認後再決定是否公開）。
4. **不要勾選** Add a README / `.gitignore` / license（因為本機都已經幫你建好了）。
5. 點 **Create repository**，複製畫面上的 HTTPS 或 SSH 網址（例如 `https://github.com/你的帳號/tw-stock-public.git`）。

### 步驟 2：把本機專案推上去
```bash
cd ~/Projects/tw-stock-public
git init -b main
git add .
git commit -m "feat: Phase 1 MVP derived-index pipeline and lightweight frontend"
git remote add origin https://github.com/你的帳號/tw-stock-public.git
git push -u origin main
```

---

## 三、接上 Cloudflare Pages 試跑（等 GitHub 建好後再做）

1. 登入 Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**。
2. 選擇你剛建立的 Private Repo `tw-stock-public`。
3. Build settings 填入：
   - **Framework preset**：`None`
   - **Build command**：留空（不需 Node 建置！）
   - **Build output directory**：`web`
4. 點 **Save and Deploy**（Cloudflare 會給一個 `*.pages.dev` 測試網址；試跑期間可在 Pages → Settings → **Access policy** 設成僅限自己 Email 登入預覽）。

---

## 四、上線前檢查清單（選項 A）

- [ ] 寄出 [TWSE_TPEx_授權確認信草稿.md](TWSE_TPEx_授權確認信草稿.md) 並保留官方書面回覆。
- [ ] 在 Private Repo 開啟 `.github/workflows/daily-update.yml`，連續觀察 2～4 週盤後自動更新與官方參考價閘門。
- [ ] 將 `.github/workflows/daily-update.yml` 內的第三方 Action 鎖定成完整 40 碼 commit SHA，並建立最小權限 Cloudflare API Token。
- [ ] 確認一切穩定與合規後，再切為正式公開網址。
