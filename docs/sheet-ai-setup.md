# Google Sheet 與 AI 代理設定

小帳不把 Google Sheet ID、Gemini API key 或代理通行碼放進公開網頁。需要同步或 AI 分類時，請透過自己部署的 Google Apps Script（GAS）代理。

```text
小帳 PWA ──私人通行碼──> 你的 GAS 代理 ──> Google Sheet
                              └──> Gemini AI
```

截圖 OCR 完全在裝置內執行；只有按下 AI 分類或使用口語記帳後台審查時，才會連到你的 GAS。

## 1. 建立 GAS 代理

1. 建立新的 Google Apps Script 專案。
2. 將 [`gas/invoice-proxy.gs`](../gas/invoice-proxy.gs) 的內容貼入專案。
3. 在「專案設定 → 指令碼屬性」加入：

   - `PROXY_TOKEN`：自行產生至少 32 字元的隨機字串。
   - `SPREADSHEET_ID`：你的帳本 Google Sheet ID。
   - `GEMINI_API_KEY`：Google AI Studio key（選填；未設定時仍可使用本機分類）。
   - `GEMINI_MODEL`：選填；未填時預設為 `gemini-3.7-flash`。

4. 選「部署 → 新增部署作業 → 網頁應用程式」。執行身分選自己，存取權限選「任何人」。
5. 複製以 `/exec` 結尾的部署網址，從小帳「備份與設定」完成裝置綁定。
6. 第一次使用口語後台審查時，從 GAS 執行 `installBackgroundProcessing` 並授權，以建立語音佇列的背景處理程序。

`PROXY_TOKEN`、Gemini key 都不能放進網頁程式碼、網址、Git 或截圖。若懷疑外洩，請立刻在指令碼屬性更換。

## 從舊版升級

載具同步已完全移除，新的 GAS 不再需要 `EINVOICE_APP_ID` 或 `EINVOICE_UUID`。若你先前開過載具兩小時排程，請到 GAS 左側「觸發條件」刪除舊的 `scheduledCarrierSync`；舊的載具帳密指令碼屬性也可一併手動移除。

## 資料與同步規則

- Google Sheet 是跨裝置的帳本來源；手動同步可上傳或讀回資料。
- App 每五分鐘會安靜讀取一次 Sheet，資料以 Sheet 為準；未同步的本機修改會先保留。
- 手動編輯的記錄會標記為使用者鎖定，口語 AI 後台不會覆寫。
- OCR 可用發票號碼，或日期、金額、商家，避免同一張截圖重複記帳。
