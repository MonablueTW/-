# 網球／匹克球 3D 重建

把**一支固定機位拍的網球或匹克球比賽影片**，變成可以在瀏覽器裡 360° 轉著看的 3D 重播：
球員的骨架人偶（網球單打 2 人、雙打與匹克球 4 人）、球的軌跡，並且和原始影片逐格同步對照。

這個專案分成兩部分：

| 部分 | 在哪裡跑 | 做什麼 |
| --- | --- | --- |
| `web/` 網頁 | 任何瀏覽器（手機也可以） | 讀取 3D 資料（JSON）＋影片，播放、切換視角 |
| `pipeline/` 影片處理 | 你的電腦（Python） | 用 AI 把影片變成 3D 資料 |

網站本身是純靜態檔案（HTML/JS），不需要伺服器程式，可以免費放在 GitHub Pages。

---

## 網頁功能

- **5 種視角**：環繞（拖曳旋轉、滾輪縮放）、原機位疊合（把 3D 疊在原始影片上，檢查準不準）、俯視、近場底線後方、側面（網子正側）
- **播放控制**：播放／暫停、上一格／下一格、時間軸、¼× ½× 1× 速度
- **軌跡**：球員移動路線、球的飛行軌跡（可關閉）
- **對照影片**：右邊同步播放原始影片（可關閉，3D 會佔滿畫面）
- 手機直向會自動改成上下排列
- 直接把 `.json`（和影片）拖進視窗，或按「開啟」就能看，不用改程式
- 快捷鍵：空白鍵 播放／暫停、← → 逐格、1–5 切換視角、T 軌跡、V 對照影片

沒有放入任何資料時，網站會顯示**示範資料**（右下角選單可切換），都是用程式合成的，不是真人影片：
- **網球單打**：拋球發球 → 回發 → 斜線對抽 → 直線 → 反手上網 → 穿越球 → 截擊得分（轉播機位）
- **匹克球雙打**：發球 → 回發 → 第三拍放小球 → 網前輕吊 → 快攻截擊 → 殺球（三腳架機位）

網址加上 `#pickleball`（或 `#tennis`）可以直接開那個示範；用選單切換時網址也會跟著變，方便分享。

## 運作原理

```
比賽影片
  │
  ├─①─ 相機校正：在畫面上點出球場角點 → 算出攝影機的位置、角度、焦距
  │      （球場尺寸是固定的：網球 23.77 × 10.97 公尺、匹克球 20 × 44 英尺，知道角點在畫面上哪裡就能反推）
  │      轉播畫面切到重播、特寫時，那幾格會自動跳過
  │
  ├─②─ 偵測球員：YOLO pose 找出每個人和 17 個關節（遠半場人很小，會放大再找一次）
  │      只保留球場範圍內的球員（單打 2 人、雙打 4 人），並用位置＋衣服顏色維持固定身分（近場·黃衣……）
  │
  ├─③─ 推算 3D：MediaPipe 給出以公尺為單位的 3D 骨架，
  │      再用相機校正把人「放」到球場上（關節要對上畫面、腳要踩在地上）
  │      人太小時改用「骨長法」：沿著相機射線、依標準骨長推回 3D
  │
  ├─④─ 球：找「在動且是球的顏色」的小點，連成軌跡，再用物理解出 3D 位置：
  │      加速度接近重力（網球的空氣阻力、上旋也考慮進去），並用落地點、擊球的手當參考點定住深度
  │
  └─⑤─ 平滑、補小空洞 → 輸出 JSON ＋ 網頁用的 MP4 → 網頁播放
```

## 快速開始

### 1. 先看示範

需要 Python 3（只用內建模組）：

```bash
python serve.py
```

瀏覽器打開 <http://localhost:8000>。

> 為什麼不直接雙擊 `index.html`？瀏覽器不允許 `file://` 載入模組程式，一定要透過網頁伺服器。
> 用 `python -m http.server` 也可以，但它不支援 HTTP Range，網頁只好把整支影片先下載完才能拖曳時間軸；
> 影片大時建議用 `serve.py`。

### 2. 拍攝建議

- **攝影機要固定**（三腳架；AI 跟拍、自動變焦要關掉）。校正是對「一個固定畫面」做的。
- 架高一點、在底線後方或角落，**畫面裡至少看得到 4 個球場的角點**（網球轉播的主機位很理想）。
- 1080p 以上；網球球速快，**60 fps 比 30 fps 好很多**。解析度越高，遠場球員和球越準。
- 用電視轉播畫面時：一次處理一分（`--start`／`--end`），重播、特寫會自動跳過；
  轉播畫面有版權，只適合自己研究，不要把影片放上公開網站。

### 3. 安裝 pipeline

```bash
cd pipeline
python -m venv .venv && source .venv/bin/activate   # Windows：.venv\Scripts\activate
pip install -r requirements.txt
python -m unittest discover tests                    # 確認安裝沒問題（不需要下載模型）
```

第一次執行會自動下載 AI 模型（YOLO 約 20–40 MB、MediaPipe 約 10–30 MB）。
Linux 伺服器如果出現 `libEGL.so.1` 錯誤，先 `sudo apt install libegl1`（沒裝的話會自動改用較粗略的骨長法）。

### 4. 相機校正

1. `python serve.py` 後打開 <http://localhost:8000/calibrate.html>，左上角選**球種**（網球／匹克球）
2. 選擇你的影片，拖時間軸選一個清楚的畫面（有人擋住角點的話按「去除球員」）
3. 在右邊清單選一個點、再到畫面上點它的位置；看不到的點跳過。至少 4 個**地面**點
4. 黃線（推算的球場線）和畫面上的線重疊，就按「下載 points.json」
5. 算出相機：

```bash
python calibrate.py --points points.json --video 比賽.mp4 --out calib.json
```

會印出誤差（RMS < 3 像素算好），並輸出 `calib_preview.jpg` 讓你確認黃線有沒有對齊（包含球網）。

### 5. 重建

```bash
python reconstruct.py 比賽.mp4 --calib calib.json --out ../web/data/rally1.json --start 12 --end 40
```

- 球種會沿用 `calib.json` 裡的設定；網球預設單打（每邊 1 人），雙打加 `--players-per-side 2`
- `--start` / `--end`：只處理這段時間（秒），建議一次一個回合
- 產生 `web/data/rally1.json`（3D 資料）和 `web/data/rally1.mp4`（網頁用影片），並自動加進 `web/data/index.json`
- 重新整理網頁，右下角的下拉選單就會出現這段

常用選項：

| 選項 | 說明 |
| --- | --- |
| `--model yolo11s-pose.pt` | 沒有顯卡時用小一點的模型（預設 `yolo11m-pose.pt`） |
| `--device cuda:0` | 用 NVIDIA 顯卡（Mac 可試 `mps`） |
| `--mediapipe heavy` | 最準但最慢的 3D 姿勢模型（`lite` / `full` / `heavy` / `off`） |
| `--stride 2` | 每 2 格處理一次，速度加倍（3D 變 15fps，影片仍是原本的） |
| `--ball-hsv 20,70,110,50,255,255` | 球的顏色範圍（HSV），球不是黃綠色時要改 |
| `--no-ball` / `--no-video` | 不做球／不輸出網頁影片 |
| `--reuse` | 沿用上次的偵測結果，只重跑平滑、球、輸出（調參數時省很多時間） |

速度參考（4 核心 CPU、`yolo11s-pose`、1264×712 影片）：約 0.8 秒／格，也就是 1 分鐘影片約 20–25 分鐘。有顯卡會快很多。

## 放到網路上（GitHub Pages）

1. GitHub 上的專案 → **Settings → Pages → Build and deployment → Source** 選 **GitHub Actions**
2. **Actions** 分頁 → 「Deploy website to GitHub Pages」→ **Run workflow**
3. 完成後網址是 `https://<你的帳號>.github.io/<專案名稱>/`

之後只要推送 `web/` 裡的修改（例如新的回合資料），網站就會自動更新。
也可以把 `web/` 整個資料夾拖到 Netlify、Cloudflare Pages 等免費靜態網站服務。

注意：影片檔放進 git 會讓專案變大（GitHub 單檔上限 100 MB）。回合短、`--max-width 1280` 的影片通常只有幾 MB。

## 資料格式

`reconstruct.py` 輸出、網頁讀取的 JSON：

```jsonc
{
  "format": "pickleball-3d",
  "version": 1,
  "sport": "tennis",                               // tennis 或 pickleball（沒寫 = pickleball）
  "title": "第一局 3:2",
  "fps": 30,
  "frameCount": 840,
  "joints": ["nose", "left_eye", …, "right_toe"],   // 21 個關節名稱（COCO-17 + 腳跟、腳尖）
  "players": [
    {
      "id": "p1",
      "name": "近場·黃衣",
      "color": "#f2cc0f",
      "side": "near",
      "frames": [[x, y, z, x, y, z, …], null, …],   // 每格 21×3 個數字；null = 這格沒抓到
      "conf": [0.91, 0, …]                          // 選填：信心值，低於 0.5 會畫成半透明
    }
  ],
  "ball": { "frames": [[x, y, z], null, …] },
  "camera": { "width": 1920, "height": 1080, "K": [[fx,0,cx],[0,fy,cy],[0,0,1]], "R": [[…],[…],[…]], "t": [tx,ty,tz] },
  "video": { "src": "rally1.mp4", "offset": 0 }     // 路徑相對於 JSON；offset = 第 0 格在影片的第幾秒
}
```

`video.src` 也可以是 `[{ "src": "a.mp4", "type": "video/mp4" }, { "src": "a.webm", "type": "video/webm" }]`，網頁會挑瀏覽器能播的那個。

座標單位是公尺，原點在球網正下方的場地中心，+Y 朝上，+Z 朝近場（攝影機那一側）底線，+X 是從近場看過去的右邊。
`camera` 採 OpenCV 慣例（`X_cam = R·X_world + t`），有它才能用「原機位疊合」。
任何能輸出這個格式的程式（例如換成更好的 AI 模型）都可以直接用這個網頁播放。

## 準確度與限制

- **單一攝影機看不出深度**：球員的前後位置是靠「腳踩在地上」＋人體模型推算出來的，
  比不上多台攝影機；手臂往前或往後伸，單眼看不出來，只能靠模型猜。
- **遠場球員**：人在畫面上太小（或被球網擋住）時，MediaPipe 會抓不到，改用骨長法，姿勢比較粗略。
- **球**：需要球在畫面上清楚可見。低解析度、動態模糊、被擋住時軌跡會斷斷續續；
  短的飛行段（不到約 0.3 秒）在深度上很不穩定，會被捨棄。
- **網球的球更難**：球速快、空氣阻力和旋轉大，單一攝影機只看軌跡的形狀幾乎定不出深度
  （模擬測試：轉播機位下誤差可達好幾公尺）；軌跡兩端要有「擊球的手」和「落地點」當參考，
  誤差才會降到 0.1–0.5 公尺（高吊球約 1 公尺）。所以擊球和落地那幾格要拍得到球。
- **攝影機必須固定**，而且只支援從底線後方／角落拍攝（左右、近遠的定義依攝影機位置而定）。
- 開發時用 FB 影片螢幕錄影裡的比賽畫面測試（原本只有約 630×355，放大成 1264×712）：
  相機校正誤差 2 像素；30 秒內四位球員的身分全程沒有認錯，85–98% 的影格有抓到人；
  近場球員的 3D 疊合貼得很準，遠場球員較粗略；球只重建出 3 段飛行（約 60 格），其餘時間球太小抓不到。
  **用原始的 1080p／4K 影片效果會好很多。**

## 想做得更準

| 想改善 | 做法 |
| --- | --- |
| 3D 人體姿勢 | 換成影片型、世界座標的人體重建模型，例如 GVHMR、WHAM、TRAM、PromptHMR、SAM 3D Body（需要 NVIDIA 顯卡），只要輸出成上面的 JSON 格式即可 |
| 球的偵測 | 用 TrackNet（專門追小球的模型），或自己標一些畫面訓練 YOLO 偵測球 |
| 整體精度 | **兩台以上攝影機**同時拍，用三角測量直接算 3D，球和人都會準很多 |
| 移動的攝影機 | 每一格偵測球場線、重新校正 |

## 檔案結構

```
serve.py                 本機預覽伺服器（支援影片 Range）
web/                     網站（部署這個資料夾）
  index.html             3D 播放器
  calibrate.html         校正點標記工具
  js/main.js             播放、同步、按鈕
  js/scene.js            three.js 場景、人偶、視角
  js/demo.js             示範資料產生器
  js/format.js           資料格式讀取
  js/court.js            球場規格（網球、匹克球）、關節定義、校正點
  js/demo-scripts.js     示範回合的劇本
  data/index.json        回合清單（reconstruct.py 會自動更新）
  demo/                  示範用的合成影片（tennis、pickleball）
  vendor/                three.js r186（MIT）
pipeline/
  calibrate.py           相機校正
  reconstruct.py         影片 → 3D JSON（主程式）
  players.py             球員偵測、身分追蹤、衣服顏色
  lifting.py             2D → 3D
  ball.py                球的偵測與 3D 軌跡
  court.py               球場模型、相機工具
  tests/                 單元測試（幾何、球的軌跡、追蹤）
tools/render-demo-video.mjs   改了示範劇本之後重新產生示範影片
tools/demo-footage/           合成示範影片用的 3D 場景（人物、球拍、場館）
.github/workflows/pages.yml   自動部署到 GitHub Pages
```

## 授權與注意事項

- 網頁用的 three.js 是 MIT 授權（`web/vendor/THREE-LICENSE.txt`）。
- pipeline 用到的 **Ultralytics YOLO 是 AGPL-3.0**：自己處理影片沒問題；
  如果要把「上傳影片 → 自動產生 3D」做成對外服務，需要開放你的原始碼或購買 Ultralytics 商業授權。
  MediaPipe 是 Apache-2.0。
- 這是依照 FB 影片中網站的**功能**重新寫的實作，沒有使用原作者的程式碼；
  拍攝和公開別人的比賽影片前，請先取得當事人同意。
