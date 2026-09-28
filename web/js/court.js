// 匹克球場標準尺寸（單位：公尺）與共用常數。
//
// 世界座標（viewer 與 pipeline 共用）：
//   原點 = 球網正下方的場地中心（地面）
//   +Y   = 朝上
//   +Z   = 朝「近場」底線（攝影機那一側）
//   +X   = 從近場面向球網時的右手邊
export const COURT = {
  halfWidth: 3.048, // 場寬 20 ft
  halfLength: 6.7056, // 場長 44 ft
  kitchen: 2.1336, // 非截擊區（廚房）線距球網 7 ft
  line: 0.0508, // 線寬 2 in
  postX: 3.3528, // 網柱位置：網長 22 ft
  netPost: 0.9144, // 網柱處網高 36 in
  netCenter: 0.8636, // 中央網高 34 in
};

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

// 校正點（和 pipeline/court.py 的 KEYPOINTS 一致）：[名稱, 中文說明, x, y, z]
// left/right = 從攝影機看過去的左右；near = 靠攝影機的半場。地面點取「線的外緣交點」。
const { halfWidth: W, halfLength: L, kitchen: K, postX: PX, netPost: NP, netCenter: NC } = COURT;
export const KEYPOINTS = [
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
];

// 圖例／人偶的預設顏色（近場 2 人、遠場 2 人）
export const PLAYER_COLORS = ['#f2cc0f', '#fc8445', '#43ccf2', '#a288fc'];
export const BALL_COLOR = '#d8f23c';
