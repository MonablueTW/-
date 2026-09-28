"""球場模型（網球、匹克球）與相機工具。

世界座標（與網頁 viewer 相同）：
  原點 = 球網正下方的場地中心（地面）
  +Y   = 朝上
  +Z   = 朝「近場」底線（靠攝影機那一半）
  +X   = 從攝影機看過去的右手邊
單位：公尺。線的位置以「線的外緣」為準（和規則的量法一樣）。
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field

import cv2
import numpy as np


@dataclass(frozen=True)
class Sport:
    id: str
    name: str
    half_width: float  # 最外側邊線（網球 = 雙打邊線）
    half_length: float
    post_x: float
    net_post: float
    net_center: float
    lines: list = field(default_factory=list)  # 線的矩形 (x0, z0, x1, z1)
    keypoints: dict = field(default_factory=dict)  # 校正點名稱 → (x, y, z)
    labels: dict = field(default_factory=dict)  # 校正點名稱 → 中文說明
    player_margin: tuple = (2.5, 3.5)  # 球員可能跑到場外多遠（左右、前後）
    ball_radius: float = 0.037
    players_per_side: int = 2


def _rect(x0, z0, x1, z1):
    return (min(x0, x1), min(z0, z1), max(x0, x1), max(z0, z1))


def _pickleball() -> Sport:
    W, L, K, lw = 3.048, 6.7056, 2.1336, 0.0508
    PX, NP, NC = 3.3528, 0.9144, 0.8636
    kp = [
        ("near_baseline_left", "近端底線·左角", -W, 0, L),
        ("near_baseline_center", "近端底線·中點", 0, 0, L),
        ("near_baseline_right", "近端底線·右角", W, 0, L),
        ("near_kitchen_left", "近端廚房線·左", -W, 0, K),
        ("near_kitchen_center", "近端廚房線·中", 0, 0, K),
        ("near_kitchen_right", "近端廚房線·右", W, 0, K),
        ("far_kitchen_left", "遠端廚房線·左", -W, 0, -K),
        ("far_kitchen_center", "遠端廚房線·中", 0, 0, -K),
        ("far_kitchen_right", "遠端廚房線·右", W, 0, -K),
        ("far_baseline_left", "遠端底線·左角", -W, 0, -L),
        ("far_baseline_center", "遠端底線·中點", 0, 0, -L),
        ("far_baseline_right", "遠端底線·右角", W, 0, -L),
        ("net_left_bottom", "左網柱·底", -PX, 0, 0),
        ("net_right_bottom", "右網柱·底", PX, 0, 0),
        ("net_left_top", "左網柱·頂", -PX, NP, 0),
        ("net_center_top", "球網中央·頂", 0, NC, 0),
        ("net_right_top", "右網柱·頂", PX, NP, 0),
    ]
    lines = [
        _rect(-W, L - lw, W, L), _rect(-W, -L, W, -L + lw),
        _rect(-W, -L, -W + lw, L), _rect(W - lw, -L, W, L),
        _rect(-W, K - lw, W, K), _rect(-W, -K, W, -K + lw),
        _rect(-lw / 2, K, lw / 2, L), _rect(-lw / 2, -L, lw / 2, -K),
    ]
    return Sport("pickleball", "匹克球", W, L, PX, NP, NC, lines,
                 {n: (float(x), float(y), float(z)) for n, _, x, y, z in kp}, {n: lab for n, lab, *_ in kp},
                 player_margin=(2.5, 3.5), ball_radius=0.037, players_per_side=2)


def _tennis() -> Sport:
    W, S, L, SV, lw, bw = 5.485, 4.115, 11.885, 6.4, 0.05, 0.1
    PX, NP, NC = W + 0.914, 1.07, 0.914
    kp = []
    for side, sign, word in (("near", 1, "近端"), ("far", -1, "遠端")):
        for name, label, x, z in (
            ("baseline_left", "底線·左角（雙打）", -W, L), ("baseline_left_singles", "底線·左（單打）", -S, L),
            ("baseline_center", "底線·中點", 0, L), ("baseline_right_singles", "底線·右（單打）", S, L),
            ("baseline_right", "底線·右角（雙打）", W, L), ("service_left", "發球線·左", -S, SV),
            ("service_center", "發球線·中（T 點）", 0, SV), ("service_right", "發球線·右", S, SV),
        ):
            kp.append((f"{side}_{name}", word + label, x, 0, sign * z))
    kp += [
        ("net_left_bottom", "左網柱·底", -PX, 0, 0),
        ("net_right_bottom", "右網柱·底", PX, 0, 0),
        ("net_left_top", "左網柱·頂", -PX, NP, 0),
        ("net_center_top", "球網中央·頂", 0, NC, 0),
        ("net_right_top", "右網柱·頂", PX, NP, 0),
    ]
    lines = [
        _rect(-W, L - bw, W, L), _rect(-W, -L, W, -L + bw),
        _rect(-W, -L, -W + lw, L), _rect(W - lw, -L, W, L),
        _rect(-S, -L, -S + lw, L), _rect(S - lw, -L, S, L),
        _rect(-S, SV - lw, S, SV), _rect(-S, -SV, S, -SV + lw),
        _rect(-lw / 2, -SV, lw / 2, SV),
        _rect(-lw / 2, L - bw - 0.1, lw / 2, L - bw), _rect(-lw / 2, -L + bw, lw / 2, -L + bw + 0.1),
    ]
    return Sport("tennis", "網球", W, L, PX, NP, NC, lines,
                 {n: (float(x), float(y), float(z)) for n, _, x, y, z in kp}, {n: lab for n, lab, *_ in kp},
                 player_margin=(4.0, 7.0), ball_radius=0.0335, players_per_side=1)


SPORTS = {"pickleball": _pickleball(), "tennis": _tennis()}


def get_sport(name: str | None) -> Sport:
    if name not in SPORTS:
        raise SystemExit(f"不支援的球種：{name}（可用：{', '.join(SPORTS)}）")
    return SPORTS[name]


def court_lines(sport: Sport) -> list[tuple[np.ndarray, np.ndarray]]:
    """畫預覽用的線段（世界座標）：每條線取長邊方向的中心線，加上球網。"""
    segs = []
    for x0, z0, x1, z1 in sport.lines:
        if x1 - x0 >= z1 - z0:
            z = (z0 + z1) / 2
            segs.append(((x0, 0, z), (x1, 0, z)))
        else:
            x = (x0 + x1) / 2
            segs.append(((x, 0, z0), (x, 0, z1)))
    P, top, mid = sport.post_x, sport.net_post, sport.net_center
    xs = np.linspace(-P, P, 9)
    net = [(x, mid + (top - mid) * (x / P) ** 2, 0) for x in xs]
    segs += list(zip(net[:-1], net[1:]))
    segs += [((-P, 0, 0), (-P, top, 0)), ((P, 0, 0), (P, top, 0))]
    return [(np.array(a, float), np.array(b, float)) for a, b in segs]


@dataclass
class Camera:
    """OpenCV 慣例：X_cam = R · X_world + t；影像座標 u = fx·X/Z + cx。"""

    K: np.ndarray
    dist: np.ndarray
    R: np.ndarray
    t: np.ndarray
    width: int
    height: int

    @property
    def center(self) -> np.ndarray:
        return -self.R.T @ self.t

    @property
    def P(self) -> np.ndarray:
        """3x4 投影矩陣（針對已去除鏡頭畸變的像素座標）。"""
        return self.K @ np.hstack([self.R, self.t.reshape(3, 1)])

    def scaled(self, width: int, height: int) -> "Camera":
        """影片解析度和校正時不同（但比例相同）時，縮放內參。"""
        sx, sy = width / self.width, height / self.height
        K = self.K.copy()
        K[0] *= sx
        K[1] *= sy
        return Camera(K, self.dist.copy(), self.R.copy(), self.t.copy(), width, height)

    def project(self, X: np.ndarray) -> np.ndarray:
        X = np.asarray(X, np.float64).reshape(-1, 3)
        rvec, _ = cv2.Rodrigues(self.R)
        uv, _ = cv2.projectPoints(X, rvec, self.t, self.K, self.dist)
        return uv.reshape(-1, 2)

    def undistort(self, uv: np.ndarray) -> np.ndarray:
        """把實際影像上的像素座標轉成「理想針孔相機」的像素座標。"""
        uv = np.asarray(uv, np.float64).reshape(-1, 1, 2)
        if not np.any(self.dist):
            return uv.reshape(-1, 2)
        return cv2.undistortPoints(uv, self.K, self.dist, P=self.K).reshape(-1, 2)

    def rays(self, uv: np.ndarray) -> np.ndarray:
        """像素 → 世界座標中的單位射線方向（起點是相機中心）。"""
        uv = self.undistort(uv)
        homog = np.hstack([uv, np.ones((len(uv), 1))])
        d_cam = (np.linalg.inv(self.K) @ homog.T).T
        d = d_cam @ self.R  # 等同 (R.T @ d_cam.T).T
        return d / np.linalg.norm(d, axis=1, keepdims=True)

    def ground_points(self, uv: np.ndarray, height: float = 0.0) -> np.ndarray:
        """像素射線和高度 = height 的水平面相交的位置（世界座標）。"""
        d = self.rays(uv)
        C = self.center
        with np.errstate(divide="ignore", invalid="ignore"):
            s = (height - C[1]) / d[:, 1]
        pts = C + d * s[:, None]
        pts[s <= 0] = np.nan  # 射線沒有往下打到地面（例如點在地平線以上）
        return pts

    def to_json(self) -> dict:
        return {
            "width": int(self.width),
            "height": int(self.height),
            "K": np.round(self.K, 4).tolist(),
            "dist": np.round(self.dist.ravel(), 6).tolist(),
            "R": np.round(self.R, 8).tolist(),
            "t": np.round(self.t.ravel(), 6).tolist(),
        }

    @staticmethod
    def from_json(d: dict) -> "Camera":
        return Camera(
            K=np.array(d["K"], float),
            dist=np.array(d.get("dist", [0, 0, 0, 0, 0]), float),
            R=np.array(d["R"], float),
            t=np.array(d["t"], float).ravel(),
            width=int(d["width"]),
            height=int(d["height"]),
        )

    @staticmethod
    def load(path: str) -> "Camera":
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        return Camera.from_json(d.get("camera", d))


def draw_court(img: np.ndarray, cam: Camera, sport: Sport, color=(0, 255, 255), thickness=2) -> np.ndarray:
    out = img.copy()
    for a, b in court_lines(sport):
        pts = cam.project(np.linspace(a, b, 24))
        in_front = (np.stack([a, b]) @ cam.R.T + cam.t)[:, 2] > 0
        if not in_front.all():
            continue
        cv2.polylines(out, [np.round(pts).astype(np.int32)], False, color, thickness, cv2.LINE_AA)
    return out


class CourtViewCheck:
    """判斷這一格是不是校正時的那個機位（轉播常切到重播、特寫、觀眾）：
    沿著推算出來的球場線取樣，看「線上」是不是比線的兩側亮。回傳 0–1，越高越像。"""

    def __init__(self, cam: Camera, sport: Sport, per_line: int = 24, offset_px: float = 6.0):
        pts, normals = [], []
        for x0, z0, x1, z1 in sport.lines:
            if x1 - x0 >= z1 - z0:
                a, b = np.array([x0, 0, (z0 + z1) / 2]), np.array([x1, 0, (z0 + z1) / 2])
            else:
                a, b = np.array([(x0 + x1) / 2, 0, z0]), np.array([(x0 + x1) / 2, 0, z1])
            ts = np.linspace(0.05, 0.95, per_line)
            world = a + np.outer(ts, b - a)
            if np.any((world @ cam.R.T + cam.t)[:, 2] <= 0):
                continue
            uv = cam.project(world)
            d = uv[-1] - uv[0]
            if np.linalg.norm(d) < 1:
                continue
            n = np.array([-d[1], d[0]]) / np.linalg.norm(d)
            pts.append(uv)
            normals.append(np.repeat(n[None], len(uv), 0))
        pts, normals = np.concatenate(pts), np.concatenate(normals)
        m = offset_px + 2
        ok = (pts[:, 0] > m) & (pts[:, 0] < cam.width - m) & (pts[:, 1] > m) & (pts[:, 1] < cam.height - m)
        self.on = np.round(pts[ok]).astype(int)
        self.side1 = np.round(pts[ok] + offset_px * normals[ok]).astype(int)
        self.side2 = np.round(pts[ok] - offset_px * normals[ok]).astype(int)

    def __call__(self, frame: np.ndarray) -> float:
        if len(self.on) == 0:
            return 1.0
        gray = cv2.GaussianBlur(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), (3, 3), 0).astype(np.int16)
        on = gray[self.on[:, 1], self.on[:, 0]]
        s1 = gray[self.side1[:, 1], self.side1[:, 0]]
        s2 = gray[self.side2[:, 1], self.side2[:, 0]]
        return float(np.mean(on > np.maximum(s1, s2) + 10))
