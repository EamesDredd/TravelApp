# 旅遊行程規劃

手機也能用的旅遊行程規劃網頁 App（可「加入主畫面」當 App 使用，離線也能看已存的行程）。

## 功能

1. **依天安排行程**：上方的天數列可切換「第 1 天、第 2 天…」或「全部」。每天可以設定主題、時間，調整順序或移到其他天，兩站之間會顯示直線距離與粗估時間。
2. **候選地點與正式行程**
   - 候選地點分成 **景點、早餐、午晚餐** 三類，按「＋ 加入」即可排進某一天（可指定時間）。
   - 點任何地點會打開詳細頁，裡面有：
     - **小地圖**：中國大陸用 **高德地圖**，其他地區用 **Google 地圖**（依座標自動判斷，也可在旅程設定手動指定）。
     - **網路搜尋結果**：AI 即時搜尋整理（簡介、營業時間、門票、交通…並附來源）、維基百科結果，以及 Google／百度／小紅書／TripAdvisor／YouTube 快速搜尋。
3. **AI 討論（Claude 或 ChatGPT）**
   - 討論區可隨時打開，按「⇥」收合到畫面右側，不會擋住行程。
   - AI 可以直接修改 App 裡的資料：新增候選、排每天行程、修改或刪除地點、調整天數。例如只放了候選景點，說「**幫我按景點遠近安排各天行程**」就會依座標分組並排好動線與時間。
   - 每次 AI 修改都會列出改了什麼，並可「↶ 復原這次修改」。
4. **每日路線地圖**：每天的「🗺 路線地圖」按鈕會彈出當天路線，可切換 **開車／大眾運輸／步行**：
   - 其他地區：內嵌 Google 地圖路線，並可一鍵在 Google 地圖 App 開啟整天或分段導航。
   - 中國大陸：高德地圖，各段可直接開啟高德導航；設定高德 Key 後，App 內會顯示實際路線、轉乘方案與即時路況。
   - 下載 **KML** 匯入 **Google 我的地圖**，就有當天（或全部天數）的標記與路線圖層。

其他：多個旅程、分享連結（把行程傳到手機）、JSON 匯出／匯入、深色模式。

## 連接 AI

到右上角 ⚙ 設定：

| 服務 | 需要 | 備註 |
| --- | --- | --- |
| Claude | [Claude Console](https://platform.claude.com/settings/keys) 的 API 金鑰 | 預設模型 Claude Opus 5.5；可選 Sonnet 5.5、Haiku 5.5。討論時可搜尋網路。 |
| ChatGPT | [OpenAI](https://platform.openai.com/api-keys) 的 API 金鑰 | 按「測試連線」載入可用模型清單。地點詳細頁的 AI 搜尋會使用 OpenAI 的網路搜尋。 |
| OpenAI 相容服務 | 該服務的 API 金鑰與 Base URL | 例如 DeepSeek、通義千問、OpenRouter（在中國大陸較容易連線）。 |

> API 是另外計費的，和 Claude.ai／ChatGPT 的月費訂閱分開；網頁版訂閱帳號無法直接連到第三方 App。
>
> 金鑰只存在你自己裝置的瀏覽器裡，App 直接連到 Anthropic／OpenAI，不經過其他伺服器。

使用 Claude 時已開啟 server-side refusal fallback（`fallbacks: "default"`）：若 Claude 的安全機制誤擋請求，API 會自動改用 Anthropic 建議的備用模型回答。

## 地圖金鑰（選填）

不填也能使用所有連結與導航。填了之後：

- **Google Maps Embed API Key**（免費）：App 內嵌地圖與路線更穩定。
- **高德 Web 端（JS API）Key + 安全密鑰**：中國大陸地點搜尋更準確，路線地圖顯示實際路線、轉乘與即時路況。

地點搜尋（定位）預設使用 OpenStreetMap。

## 部署到手機可開的網址（GitHub Pages）

1. 把程式合併到 `main`。
2. GitHub 專案 → **Settings → Pages → Source** 選 **GitHub Actions**。
3. 之後每次推到 `main`，`.github/workflows/deploy.yml` 會自動測試、建置並發布到 `https://<帳號>.github.io/<專案名>/`。
4. 用手機開啟網址 →（iPhone Safari）分享 →「加入主畫面」；（Android Chrome）選單 →「安裝應用程式」。

資料存在各裝置的瀏覽器裡。電腦上排好的行程，可在「我的旅程 → 分享連結」用手機開啟匯入。

## 開發

```bash
npm install
npm run dev        # 本機開發 http://localhost:5173
npm test           # 單元測試
npm run build      # 型別檢查 + 建置到 dist/
```

技術：React 19、TypeScript、Vite、Zustand（localStorage 保存）、Leaflet、`@anthropic-ai/sdk`、vite-plugin-pwa。

主要程式位置：

- `src/lib/ai/agentTools.ts`：AI 可用的工具（新增候選、排行程…）與系統提示詞
- `src/lib/ai/claude.ts`、`src/lib/ai/openai.ts`：Claude／OpenAI 串流與工具呼叫流程
- `src/lib/geo.ts`：中國大陸範圍判斷、WGS-84 ↔ GCJ-02 座標轉換、距離
- `src/lib/maps.ts`：Google 地圖／高德連結、內嵌地圖、KML 匯出
- `src/components/`：畫面元件
