# 發票載具與 AI 代理設定

小帳不把財政部 AppID 或 Gemini API key 放進瀏覽器。載具及 AI 請求會先到你自己的 Google Apps Script（GAS）代理，再由代理呼叫官方服務。

## 資料流

```text
小帳 PWA ──私人通行碼──> 你的 GAS 代理 ──AppID──> 財政部電子發票 API
                              └──Gemini key──> Gemini（僅商家與品項）
```

截圖 OCR 完全在瀏覽器執行，不會把圖片送到 GAS 或 Gemini。

## 1. 申請財政部 AppID

1. 閱讀財政部「電子發票應用 API 規格」。
2. 到[電子發票 API 申請頁](https://www.einvoice.nat.gov.tw/APMEMBERVAN/APIService/Registration)申請 AppID／APIKey。
3. 保存核發資料，不要放入前端程式碼或 Git。

目前代理使用「載具發票表頭查詢」與「載具發票明細查詢」；兩者皆為 HTTPS `POST`、`application/x-www-form-urlencoded`，API 版本 0.5。

## 2. 建立 Gemini API key

在 [Google AI Studio](https://aistudio.google.com/app/apikey) 建立 Gemini API key。代理預設使用較強的 `gemini-3.7-flash` structured output，輸出只能落在小帳的大小分類 taxonomy；可用 GAS 指令碼屬性 `GEMINI_MODEL` 覆寫。

## 3. 部署 GAS 代理

1. 建立一個新的 Google Apps Script 專案。
2. 將 [`gas/invoice-proxy.gs`](../gas/invoice-proxy.gs) 的內容貼入專案。
3. 在「專案設定 → 指令碼屬性」加入：

   - `PROXY_TOKEN`：自己產生的長隨機字串，建議至少 32 字元。
   - `EINVOICE_APP_ID`：財政部核發的 AppID。
   - `EINVOICE_UUID`：這個裝置／服務固定使用的 UUID。
   - `GEMINI_API_KEY`：Google AI Studio 的 key（選填；未設定時仍可載具同步，分類改用 app 本機規則）。

4. 選「部署 → 新增部署作業 → 網頁應用程式」。執行身分選自己，存取權限選「任何人」。
5. 複製以 `/exec` 結尾的部署網址。

代理程式日後有更新時（例如新增收入 AI 分類），請回到「部署 → 管理部署作業」，將現有 Web App 改用「新版本」後再部署，才會載入最新程式。

`PROXY_TOKEN` 是公開網頁應用程式的第二層保護；不要把它寫進程式碼、網址或公開文件。若懷疑外洩，立刻更換指令碼屬性中的值。

## 4. 在小帳同步

1. 開啟「備份與設定 → 智慧匯入」。
2. 填入 GAS `/exec` 網址、代理通行碼、手機條碼與載具驗證碼。
3. 選月份與記入帳戶，按「同步並自動去重」。

小帳只保存代理網址與手機條碼，**不保存**代理通行碼、載具驗證碼、財政部 AppID 或 Gemini key。

## 去重規則

1. 有發票號碼時，正規化為「兩碼英文＋八碼數字」後精確比對。
2. 沒有共同發票號碼時，比對同日期、同金額、正規化後完全相同的商家。
3. 載具與 OCR 命中時，以載具的發票與品項取代 OCR 草稿。
4. 商家只有模糊相似時保留兩筆，避免誤刪；可在紀錄頁人工確認。
5. 每次載具同步完成後可按提示的「復原」。

## 使用限制與故障排除

- 財政部規格限制最早查詢到當日前六個月的第一天，且單次起訖日必須在同一月份。
- 商家需先上傳發票，載具通常不會在消費當下立刻出現；官方服務說明提示可能需等待約 48 小時。
- 小帳及 GAS 會限制相同載具月份兩分鐘內重複查詢，避免撞到官方流量限制。
- 第一次 OCR 會下載 Tesseract.js 引擎與繁中語言模型，因此會比之後慢；圖片仍留在裝置。
- 若顯示「載具驗證失敗」，先確認手機條碼大小寫及載具驗證碼，而不是財政部網站登入密碼。

官方參考：

- [財政部電子發票應用 API 規格](https://www.einvoice.nat.gov.tw/static/ptl/ein_upload/attachments/1510206773173_0.pdf)
- [財政部電子發票 API 流量限制](https://www.einvoice.nat.gov.tw/static/ptl/ein_upload/download/5540.pdf)
- [財政部手機條碼服務說明](https://www.einvoice.nat.gov.tw/portal/btc/)
- [Tesseract.js 本機安裝說明](https://github.com/naptha/tesseract.js/blob/master/docs/local-installation.md)
- [Gemini structured output](https://ai.google.dev/gemini-api/docs/structured-output)
