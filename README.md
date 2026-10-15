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
   - **自動定位**：AI 新增或手動輸入、但沒有座標的地點，App 會在背景依名稱搜尋（有高德 Key 時先用高德，否則用 OpenStreetMap），名稱相符且在旅程附近才採用，路線就能涵蓋每一站。自動定位的地點會標示出來，位置不對可在地點詳情「修正位置」；「午餐（附近找）」這類不是地點的名稱不會搜尋。
5. **匯出 PDF 行程表**：右上角 📄（或「我的旅程」、每天的「⋯」選單）可匯出全部或單日的 A4 行程表，含每天的路線地圖、時間、地址、備註與兩站之間的距離。地名和交通資訊可以點，會開啟 Google 地圖或高德地圖。手機上按「分享／儲存到檔案」即可存到檔案或傳到 LINE。

其他：多個旅程、分享連結（把行程傳到手機）、JSON 匯出／匯入、深色模式。

## 連接 AI

### 方法一：用你手機上的 Claude / ChatGPT App（免 API 金鑰，預設）

訂閱版（Claude Pro/Max、ChatGPT Plus）沒有開放給其他 App 直接連線，所以改用「傳過去、貼回來」：

1. 在 AI 討論輸入需求，按「傳送」，從分享選單選 Claude 或 ChatGPT App（電腦上會自動複製，貼到對話中即可）。
2. 在 AI App 送出。App 送出的內容已包含整個行程和回覆格式，AI 會在回覆最後附上一個 `travelplan` 修改區塊。
3. 複製 AI 的整則回覆，回到這裡按「📋 貼上回覆」，行程就會自動更新，訊息下方列出改了什麼，也可以一鍵復原。

在同一個 AI 對話裡繼續追問也可以：AI 每次都會給出這個請求「全部」的修改（版本號 rev 會加 1），貼上較新的回覆會取代先前套用的版本，所以只貼最後一則也不會漏。
如果回覆有問題（例如格式不完整），App 會先問你要不要套用沒問題的部分，並提供「複製修正請求給 AI」按鈕，貼回同一個 AI 對話即可。
貼錯旅程、貼到自己傳出去的內容、重複貼同一則都會被擋下；每次套用都可以一鍵復原。
地點詳細頁的「傳給 AI 查詢／貼上回覆存檔」也是同樣方式。

### 方法二：API 金鑰（AI 直接在 App 裡修改）

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
- `src/lib/autoLocate.ts`、`src/lib/placeMatch.ts`：背景自動定位與地名比對（繁簡轉換表 `src/lib/t2s.ts` 取自 OpenCC）
- `src/lib/pdf/`：PDF 行程表（內容、排版、地圖、以裝置字型繪製後組成 PDF）
- `src/components/`：畫面元件
