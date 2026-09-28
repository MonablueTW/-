"""球員偵測（YOLO pose）、四位球員的固定身分追蹤、衣服顏色命名。"""
from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np
from scipy.optimize import linear_sum_assignment

from court import HALF_L, HALF_W, Camera

L_ANKLE, R_ANKLE, L_SH, R_SH, L_HIP, R_HIP = 15, 16, 5, 6, 11, 12


@dataclass
class Detection:
    box: np.ndarray  # x0, y0, x1, y1（像素）
    kpts: np.ndarray  # (17, 3)：x, y, 信心
    conf: float
    ground: np.ndarray = field(default=None)  # 站位 (x, z)，世界座標
    color: np.ndarray = field(default=None)  # 軀幹各顏色類別的比例（命名用）


def overlap(a: np.ndarray, b: np.ndarray) -> float:
    """兩個框的重疊程度：取 IoU 和「小框被包住的比例」較大者（同一人被框成全身和半身時也算重複）。"""
    x0, y0 = max(a[0], b[0]), max(a[1], b[1])
    x1, y1 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0, x1 - x0) * max(0, y1 - y0)
    area_a = (a[2] - a[0]) * (a[3] - a[1])
    area_b = (b[2] - b[0]) * (b[3] - b[1])
    union = area_a + area_b - inter
    if union <= 0:
        return 0.0
    return max(inter / union, 0.8 * inter / max(1e-6, min(area_a, area_b)))


class PoseDetector:
    """整張畫面跑一次 YOLO pose；遠場的人很小，再把遠半場放大跑第二次。"""

    def __init__(self, cam: Camera, model: str = "yolo11m-pose.pt", imgsz: int = 960, conf: float = 0.25,
                 device: str | None = None, far_zoom: bool = True):
        from ultralytics import YOLO

        self.model = YOLO(model)
        self.cam = cam
        self.imgsz = imgsz
        self.conf = conf
        self.device = device
        self.far_roi = self._far_roi() if far_zoom else None
        self.roi_imgsz = self._roi_imgsz() if self.far_roi else imgsz

    def _far_roi(self):
        xs, zs, ys = (-HALF_W - 1.5, HALF_W + 1.5), (-HALF_L - 3.0, 0.3), (0.0, 2.1)
        pts = np.array([[x, y, z] for x in xs for y in ys for z in zs])
        depth = (pts @ self.cam.R.T + self.cam.t)[:, 2]
        if np.any(depth <= 0):
            return None
        uv = self.cam.project(pts)
        x0, y0 = np.floor(uv.min(0)).astype(int)
        x1, y1 = np.ceil(uv.max(0)).astype(int)
        W, H = self.cam.width, self.cam.height
        x0, y0, x1, y1 = max(0, x0), max(0, y0), min(W, x1), min(H, y1)
        if (x1 - x0) * (y1 - y0) > 0.6 * W * H or x1 - x0 < 32 or y1 - y0 < 32:
            return None  # 遠場已經佔了大半個畫面，放大沒有意義
        return x0, y0, x1, y1

    def _roi_imgsz(self, target_px: float = 200) -> int:
        """放大倍率：讓站在遠端底線後方的人，在模型輸入裡大約 target_px 像素高（太小 YOLO 會抓不到）。"""
        z = -HALF_L - 1.5
        top, bottom = self.cam.project(np.array([[0, 1.75, z], [0, 0.0, z]]))
        person_px = max(8.0, abs(bottom[1] - top[1]))
        x0, y0, x1, y1 = self.far_roi
        size = target_px / person_px * max(x1 - x0, y1 - y0)
        return int(np.clip(np.ceil(size / 32) * 32, 640, 1920))

    def _predict(self, img, offset=(0, 0), crop_edges=(), conf=None, imgsz=None) -> list[Detection]:
        r = self.model.predict(img, imgsz=imgsz or self.imgsz, conf=conf or self.conf, classes=[0], verbose=False,
                               device=self.device)[0]
        if r.boxes is None or len(r.boxes) == 0:
            return []
        raw = r.boxes.xyxy.cpu().numpy()
        confs = r.boxes.conf.cpu().numpy()
        kp = r.keypoints.data.cpu().numpy().copy()
        kp[..., 0] += offset[0]
        kp[..., 1] += offset[1]
        h, w = img.shape[:2]
        out = []
        for b, k, c in zip(raw, kp, confs):
            # 放大區域的邊緣會切到近場的人 → 被切掉的框不可信（整張畫面那次會抓到完整的人）
            cut = (("left" in crop_edges and b[0] < 3) or ("top" in crop_edges and b[1] < 3)
                   or ("right" in crop_edges and b[2] > w - 3) or ("bottom" in crop_edges and b[3] > h - 3))
            if not cut:
                out.append(Detection(b + np.array([offset[0], offset[1]] * 2), k, float(c)))
        return out

    def __call__(self, frame: np.ndarray) -> list[Detection]:
        dets = self._predict(frame)
        if self.far_roi:
            x0, y0, x1, y1 = self.far_roi
            H, W = frame.shape[:2]
            edges = [e for e, inner in (("left", x0 > 0), ("top", y0 > 0), ("right", x1 < W), ("bottom", y1 < H)) if inner]
            dets += self._predict(frame[y0:y1, x0:x1], (x0, y0), edges, conf=0.5 * self.conf, imgsz=self.roi_imgsz)
        dets.sort(key=lambda d: -d.conf)
        kept: list[Detection] = []
        area = lambda b: (b[2] - b[0]) * (b[3] - b[1])
        for d in dets:  # 重疊的框只留一個；半身框和全身框重疊時留全身
            dup = next((i for i, k in enumerate(kept) if overlap(d.box, k.box) >= 0.5), None)
            if dup is None:
                kept.append(d)
            elif area(d.box) > 1.5 * area(kept[dup].box) and d.conf > 0.4:
                kept[dup] = d
        out = []
        for d in kept:
            if self._locate(d):
                d.color = appearance(frame, d)
                out.append(d)
        return out

    def _locate(self, d: Detection) -> bool:
        """算站位，並排除場外的人（觀眾、旁邊場地的人）。"""
        k = d.kpts
        ankles = [k[i, :2] for i in (L_ANKLE, R_ANKLE) if k[i, 2] > 0.4]
        hips = [k[i, :2] for i in (L_HIP, R_HIP) if k[i, 2] > 0.4]
        if ankles:
            g = self.cam.ground_points(np.mean(ankles, 0)[None], height=0.08)[0]
        elif hips and d.box[3] > self.cam.height - 4:
            g = self.cam.ground_points(np.mean(hips, 0)[None], height=0.85)[0]  # 腳被畫面切掉 → 用髖部估
        else:
            g = self.cam.ground_points(np.array([[(d.box[0] + d.box[2]) / 2, d.box[3]]]))[0]
        if not np.all(np.isfinite(g)):
            return False
        if abs(g[0]) > HALF_W + 2.5 or abs(g[2]) > HALF_L + 3.5:
            return False
        # 框的高度要像一個站在那裡的人（排除太小或太大的誤判）
        top, bottom = self.cam.project(np.array([[g[0], 1.75, g[2]], [g[0], 0.0, g[2]]]))
        expected = abs(bottom[1] - top[1])
        ratio = (d.box[3] - d.box[1]) / max(expected, 1)
        if not 0.35 < ratio < 1.8:
            return False
        d.ground = np.array([g[0], g[2]])
        return True


COLOR_NAMES = ["黑", "白", "灰", "紅", "橘", "黃", "綠", "青", "藍", "紫", "粉"]


def pixel_colors(hsv: np.ndarray) -> np.ndarray:
    """每個像素分到一個顏色類別（COLOR_NAMES 的索引）。室內燈光常偏藍，白色的飽和度會偏高，所以門檻放寬。"""
    h, s, v = hsv[:, 0].astype(int), hsv[:, 1].astype(int), hsv[:, 2].astype(int)
    hue = np.select([(h < 8) | (h >= 170), h < 20, h < 34, h < 85, h < 100, h < 130, h < 150], [3, 4, 5, 6, 7, 8, 9], 10)
    white = (s < 50) | ((v > 195) & (s < 110))
    return np.select([v < 75, white & (v > 150), white], [0, 1, 2], hue)


def appearance(frame: np.ndarray, d: Detection):
    """軀幹中央各顏色類別的像素比例（比對身分與命名用）。"""
    k = d.kpts
    x0, y0, x1, y1 = d.box
    if all(k[i, 2] > 0.4 for i in (L_SH, R_SH, L_HIP, R_HIP)):
        xs, ys = k[[L_SH, R_SH, L_HIP, R_HIP], 0], k[[L_SH, R_SH, L_HIP, R_HIP], 1]
        cx, w = xs.mean(), max(6.0, xs.max() - xs.min())
        top, bottom = ys[:2].mean(), ys[2:].mean()
        tx0, tx1 = cx - 0.3 * w, cx + 0.3 * w
        ty0, ty1 = top + 0.15 * (bottom - top), bottom - 0.2 * (bottom - top)
    else:
        w, h = x1 - x0, y1 - y0
        tx0, tx1, ty0, ty1 = x0 + 0.33 * w, x1 - 0.33 * w, y0 + 0.24 * h, y0 + 0.46 * h
    H, W = frame.shape[:2]
    tx0, tx1 = int(max(0, tx0)), int(min(W, tx1))
    ty0, ty1 = int(max(0, ty0)), int(min(H, ty1))
    if tx1 - tx0 < 2 or ty1 - ty0 < 2:
        return None
    hsv = cv2.cvtColor(frame[ty0:ty1, tx0:tx1], cv2.COLOR_BGR2HSV)
    votes = np.bincount(pixel_colors(hsv.reshape(-1, 3)), minlength=len(COLOR_NAMES)).astype(float)
    return votes / votes.sum()


def color_name(votes: np.ndarray) -> str:
    return COLOR_NAMES[int(np.argmax(votes))]


@dataclass
class Slot:
    side: str  # near / far
    pos: np.ndarray | None = None
    vel: np.ndarray = field(default_factory=lambda: np.zeros(2))
    last: int = -1
    votes: np.ndarray | None = None  # 衣服顏色分布（持續更新）
    seen: int = 0
    colors: list = field(default_factory=list)
    xs: list = field(default_factory=list)


class PlayerTracker:
    """把每一格的偵測分配給固定的 4 個位置：近場 ×2、遠場 ×2（左右依攝影機看過去）。"""

    def __init__(self, fps: float):
        self.fps = fps
        self.slots = [Slot("near"), Slot("near"), Slot("far"), Slot("far")]

    def assign(self, f: int, dets: list[Detection]) -> list[Detection | None]:
        """位置（離上次多遠）＋ 外觀（衣服顏色分布）一起比對。消失越久，位置越不重要、顏色越重要。"""
        out: list[Detection | None] = [None] * 4
        for side, idx in (("near", (0, 1)), ("far", (2, 3))):
            cands = [d for d in dets if (d.ground[1] > 0) == (side == "near")][:4]
            if not cands:
                continue
            cost = np.full((2, len(cands)), 1e6)
            for a, si in enumerate(idx):
                s = self.slots[si]
                for b, d in enumerate(cands):
                    if s.pos is None:
                        if d.conf >= 0.4:  # 第一次出現要夠確定（避免把場邊觀眾當成球員）
                            order = d.ground[0] if a == 0 else -d.ground[0]  # 左邊的給第一格
                            cost[a, b] = 5.0 + 0.1 * order
                        continue
                    gap = (f - s.last) / self.fps
                    if gap > 1.0 and d.conf < 0.4:
                        continue  # 消失很久之後重新找回，也要夠確定
                    pred = s.pos + s.vel * min(gap, 0.3)
                    dist = np.linalg.norm(pred - d.ground)
                    if dist > 1.5 + 5.0 * gap:
                        continue  # 跑不了這麼遠
                    app = 0.0
                    if s.votes is not None and d.color is not None:
                        app = 0.5 * np.abs(s.votes - d.color).sum()  # 0 = 顏色分布一樣，1 = 完全不同
                        if app > 0.65 and s.seen >= 5:
                            continue  # 衣服顏色明顯不同 → 不是同一人
                    cost[a, b] = dist / (1 + 2 * gap) + 3.0 * app
            rows, cols = linear_sum_assignment(cost)
            for a, b in zip(rows, cols):
                if cost[a, b] >= 1e6:
                    continue
                si = idx[a]
                s, d = self.slots[si], cands[b]
                if s.pos is not None:
                    dt = max(1, f - s.last) / self.fps
                    v = (d.ground - s.pos) / dt
                    s.vel = 0.6 * s.vel + 0.4 * v if dt < 0.5 else np.zeros(2)
                s.pos, s.last = d.ground.copy(), f
                s.seen += 1
                if d.color is not None:
                    s.votes = d.color.copy() if s.votes is None else 0.92 * s.votes + 0.08 * d.color
                    s.colors.append(d.color)
                s.xs.append(d.ground[0])
                out[si] = d
        return out

    def display_colors(self, palette: list[str]) -> list[str]:
        """人偶顏色盡量和衣服同色系（黃衣 → 黃色人偶），黑衣等沒有對應的就用剩下的顏色。"""
        prefer = {"黃": 0, "橘": 1, "紅": 1, "粉": 1, "白": 2, "灰": 2, "青": 2, "藍": 2, "紫": 3}
        out: list[str | None] = [None] * len(self.slots)
        used = set()
        order = sorted(range(len(self.slots)), key=lambda i: -(np.max(np.sum(self.slots[i].colors, 0)) if self.slots[i].colors else 0))
        for i in order:
            s = self.slots[i]
            want = prefer.get(color_name(np.sum(s.colors, 0))) if s.colors else None
            if want is not None and want not in used:
                out[i] = palette[want]
                used.add(want)
        rest = [k for k in (1, 3, 2, 0) if k not in used]
        for i in range(len(out)):
            if out[i] is None:
                out[i] = palette[rest.pop(0)]
        return out

    def names(self) -> list[str]:
        names = []
        for s in self.slots:
            c = color_name(np.sum(s.colors, 0)) if s.colors else "?"
            names.append(f"{'近場' if s.side == 'near' else '遠場'}·{c}衣")
        for i, j in ((0, 1), (2, 3)):  # 同一邊兩人同色 → 加左右
            if names[i] == names[j]:
                left_first = np.mean(self.slots[i].xs or [0]) <= np.mean(self.slots[j].xs or [0])
                names[i] += "（左）" if left_first else "（右）"
                names[j] += "（右）" if left_first else "（左）"
        return names
