# 小帳｜個人記帳

從原本的共用記帳 app 延伸出來的獨立個人版。保留手機優先、PWA 與離線可用的特性，但不共用原 app 的 GAS、Google 試算表、儲存 key 或 Service Worker scope。

## 已完成

- 支出、收入、帳戶轉帳的新增與編輯；刪除前會再次確認並同步移除 Sheet 資料
- 客製帳戶：現金、LINE、永豐、台銀、郵局；新增、轉帳與 OCR 都直接用按鈕選擇
- 本月收入、支出、結餘、分類流向與帳戶餘額
- 歷史紀錄關鍵字、類型、帳戶篩選
- 分類每月預算與超支提示；儲存後會自動同步到 Sheet
- 六個月收支趨勢
- 支出／收入大分類與詳細小分類（飲食可細分火鍋、燒烤、炸物、甜品等）
- 收入方案包含薪資、獎金、家教／接案、投資、租賃、退款理賠、補助、零用錢、禮金、銷售與發票中獎等詳細小分類
- 新增時由 AI 在背景自動分類，不展開分類欄位；只在事後編輯紀錄時顯示並允許修正
- 口語記帳：可說或輸入「昨天搭高鐵 1490 元刷卡」，自動填入日期、金額、帳戶與背景分類
- 口語帳戶支援 LINE、永豐、台銀、郵局與現金，也可說「從永豐轉到郵局，手續費 15 元」
- 轉帳可記錄手續費：轉出帳戶與總資產會扣除手續費，轉入帳戶只增加轉帳金額
- 截圖在裝置內 OCR，辨識金額、日期、商家與發票號碼後產生可確認草稿
- 本機規則＋Gemini AI 自動分類；口語條目會把名稱、金額、日期、帳戶與精簡備註交由後台審查
- OCR 自動去重：先比發票號碼，再比日期、金額與商家
- JSON 完整備份／還原與 CSV 明細匯出
- 深淺色主題、響應式介面與 PWA 離線殼層

## 開發

```bash
npm install
npm start
```

`npm start` 會啟動本機伺服器並開啟正確的 `/hukeep-personal/` 網址。請不要在 Finder 雙擊專案內的 `index.html`；`file://` 無法載入 Vite 模組、OCR worker 與 PWA 功能。如果只需開發而不自動開瀏覽器，可改用 `npm run dev`。

預設 Vite base 是 `/hukeep-personal/`，可用在 GitHub Pages 同名專案。

## 驗證

```bash
npm test
npm run test:coverage
npm run lint
npm run build
npm run test:e2e
```

`npm run verify` 會依序執行全部驗證。

## 開啟 Google Sheet 與 AI

即使不設定外部服務，手動記帳、本機細分類與截圖 OCR 都可使用。Google Sheet 同步及 Gemini AI 分類需要部署自己的 Google Apps Script 安全代理，完整步驟見 [Google Sheet 與 AI 代理設定](./docs/sheet-ai-setup.md)。

## 資料與隱私

帳本資料只存在瀏覽器 `localStorage` 的 `hukeep_personal_state_v1`，不會送往原 app。截圖 OCR 在裝置內完成；只有主動使用 Sheet 同步或 AI 複判時才會連到你部署的私人代理。代理通行碼不會儲存在一般帳本資料中。口語記帳在瀏覽器支援時優先嘗試裝置內辨識；不支援時可直接輸入文字，部分瀏覽器的語音辨識可能使用其線上服務。請定期用「備份與資料」匯出 JSON。
