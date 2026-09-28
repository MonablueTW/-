// 球場規格（單位：公尺）與共用常數。網球、匹克球共用同一套世界座標：
//   原點 = 球網正下方的場地中心（地面）
//   +Y   = 朝上
//   +Z   = 朝「近場」底線（攝影機那一側）
//   +X   = 從近場面向球網時的右手邊
// 線的位置一律以「線的外緣」為準（和規則的量法一樣），線本身畫在場內。

const rect = (x0, z0, x1, z1) => [Math.min(x0, x1), Math.min(z0, z1), Math.max(x0, x1), Math.max(z0, z1)];

function pickleball() {
  const W = 3.048; // 場寬 20 ft
  const L = 6.7056; // 場長 44 ft
  const K = 2.1336; // 廚房線距球網 7 ft
  const lw = 0.0508; // 線寬 2 in
  const PX = 3.3528; // 網柱：網長 22 ft
  const NP = 0.9144; // 網柱處 36 in
  const NC = 0.8636; // 中央 34 in
  return {
    id: 'pickleball',
    name: '匹克球',
    halfWidth: W,
    halfLength: L,
    postX: PX,
    netPost: NP,
    netCenter: NC,
    ground: [14, 24],
    // 藍色的發球區（廚房維持地面顏色）
    surfaces: [rect(-W, K, W, L), rect(-W, -L, W, -K)],
    lines: [
      rect(-W, L - lw, W, L), rect(-W, -L, W, -L + lw), // 底線
      rect(-W, -L, -W + lw, L), rect(W - lw, -L, W, L), // 邊線
      rect(-W, K - lw, W, K), rect(-W, -K, W, -K + lw), // 廚房線
      rect(-lw / 2, K, lw / 2, L), rect(-lw / 2, -L, lw / 2, -K), // 中線
    ],
    keypoints: [
      ['near_baseline_left', '近端底線·左角', -W, 0, L],
      ['near_baseline_center', '近端底線·中點', 0, 0, L],
      ['near_baseline_right', '近端底線·右角', W, 0, L],
      ['near_kitchen_left', '近端廚房線·左', -W, 0, K],
      ['near_kitchen_center', '近端廚房線·中', 0, 0, K],
      ['near_kitchen_right', '近端廚房線·右', W, 0, K],
      ['far_kitchen_left', '遠端廚房線·左', -W, 0, -K],
      ['far_kitchen_center', '遠端廚房線·中', 0, 0, -K],
      ['far_kitchen_right', '遠端廚房線·右', W, 0, -K],
      ['far_baseline_left', '遠端底線·左角', -W, 0, -L],
      ['far_baseline_center', '遠端底線·中點', 0, 0, -L],
      ['far_baseline_right', '遠端底線·右角', W, 0, -L],
      ['net_left_bottom', '左網柱·底', -PX, 0, 0],
      ['net_right_bottom', '右網柱·底', PX, 0, 0],
      ['net_left_top', '左網柱·頂', -PX, NP, 0],
      ['net_center_top', '球網中央·頂', 0, NC, 0],
      ['net_right_top', '右網柱·頂', PX, NP, 0],
    ],
    ballRadius: 0.037,
    playersPerSide: 2,
  };
}

function tennis() {
  const W = 5.485; // 雙打邊線（場寬 10.97 m）
  const S = 4.115; // 單打邊線（8.23 m）
  const L = 11.885; // 場長 23.77 m
  const SV = 6.4; // 發球線距球網 6.40 m
  const lw = 0.05; // 線寬 5 cm
  const bw = 0.1; // 底線可到 10 cm
  const PX = W + 0.914; // 網柱在雙打邊線外 0.914 m
  const NP = 1.07; // 網柱處 1.07 m
  const NC = 0.914; // 中央 0.914 m
  const side = (s) => [
    [`${s}_baseline_left`, '底線·左角（雙打）', -W, 0],
    [`${s}_baseline_left_singles`, '底線·左（單打）', -S, 0],
    [`${s}_baseline_center`, '底線·中點', 0, 0],
    [`${s}_baseline_right_singles`, '底線·右（單打）', S, 0],
    [`${s}_baseline_right`, '底線·右角（雙打）', W, 0],
    [`${s}_service_left`, '發球線·左', -S, 1],
    [`${s}_service_center`, '發球線·中（T 點）', 0, 1],
    [`${s}_service_right`, '發球線·右', S, 1],
  ].map(([name, label, x, isService]) => {
    const z = (isService ? SV : L) * (s === 'near' ? 1 : -1);
    return [name, `${s === 'near' ? '近端' : '遠端'}${label}`, x, 0, z];
  });
  return {
    id: 'tennis',
    name: '網球',
    halfWidth: W,
    halfLength: L,
    postX: PX,
    netPost: NP,
    netCenter: NC,
    ground: [22, 40],
    surfaces: [rect(-W, -L, W, L)],
    lines: [
      rect(-W, L - bw, W, L), rect(-W, -L, W, -L + bw), // 底線
      rect(-W, -L, -W + lw, L), rect(W - lw, -L, W, L), // 雙打邊線
      rect(-S, -L, -S + lw, L), rect(S - lw, -L, S, L), // 單打邊線
      rect(-S, SV - lw, S, SV), rect(-S, -SV, S, -SV + lw), // 發球線
      rect(-lw / 2, -SV, lw / 2, SV), // 中央發球線
      rect(-lw / 2, L - bw - 0.1, lw / 2, L - bw), rect(-lw / 2, -L + bw, lw / 2, -L + bw + 0.1), // 中點標記
    ],
    keypoints: [
      ...side('near'),
      ...side('far'),
      ['net_left_bottom', '左網柱·底', -PX, 0, 0],
      ['net_right_bottom', '右網柱·底', PX, 0, 0],
      ['net_left_top', '左網柱·頂', -PX, NP, 0],
      ['net_center_top', '球網中央·頂', 0, NC, 0],
      ['net_right_top', '右網柱·頂', PX, NP, 0],
    ],
    ballRadius: 0.0335,
    playersPerSide: 1,
  };
}

export const SPORTS = { tennis: tennis(), pickleball: pickleball() };
export const getSport = (id) => SPORTS[id] ?? SPORTS.pickleball;

// COCO-17 關鍵點 + 腳跟／腳尖（MediaPipe 有提供，其他模型可省略）
export const JOINTS = [
  'nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear',
  'left_shoulder', 'right_shoulder', 'left_elbow', 'right_elbow',
  'left_wrist', 'right_wrist', 'left_hip', 'right_hip',
  'left_knee', 'right_knee', 'left_ankle', 'right_ankle',
  'left_heel', 'right_heel', 'left_toe', 'right_toe',
];

// 人偶的骨架連線（用關節名稱表示；資料裡缺少的關節會自動略過）
export const BONES = [
  ['left_shoulder', 'right_shoulder'],
  ['left_hip', 'right_hip'],
  ['left_shoulder', 'left_hip'],
  ['right_shoulder', 'right_hip'],
  ['left_shoulder', 'left_elbow'],
  ['left_elbow', 'left_wrist'],
  ['right_shoulder', 'right_elbow'],
  ['right_elbow', 'right_wrist'],
  ['left_hip', 'left_knee'],
  ['left_knee', 'left_ankle'],
  ['right_hip', 'right_knee'],
  ['right_knee', 'right_ankle'],
  ['left_ankle', 'left_toe'],
  ['right_ankle', 'right_toe'],
  ['left_heel', 'left_toe'],
  ['right_heel', 'right_toe'],
];

// 圖例／人偶的預設顏色（近場 2 人、遠場 2 人）
export const PLAYER_COLORS = ['#f2cc0f', '#fc8445', '#43ccf2', '#a288fc'];
export const BALL_COLOR = '#d8f23c';
