"""匹克球場模型與相機工具。

世界座標（與網頁 viewer 相同）：
  原點 = 球網正下方的場地中心（地面）
  +Y   = 朝上
  +Z   = 朝「近場」底線（靠攝影機那一半）
  +X   = 從攝影機看過去的右手邊
單位：公尺。
"""
from __future__ import annotations

import json
from dataclasses import dataclass

import cv2
import numpy as np

HALF_W = 3.048  # 場寬 20 ft
HALF_L = 6.7056  # 場長 44 ft
KITCHEN = 2.1336  # 廚房線距球網 7 ft
POST_X = 3.3528  # 網柱：網長 22 ft
NET_POST = 0.9144  # 網柱處 36 in
NET_CENTER = 0.8636  # 中央 34 in

# 校正點（名稱 → 世界座標）。left/right = 從攝影機看過去的左右；near = 靠攝影機的半場。
# 地面上的點取「線的外緣交點」。
KEYPOINTS: dict[str, tuple[float, float, float]] = {
    "near_baseline_left": (-HALF_W, 0.0, HALF_L),
    "near_baseline_center": (0.0, 0.0, HALF_L),
    "near_baseline_right": (HALF_W, 0.0, HALF_L),
    "near_kitchen_left": (-HALF_W, 0.0, KITCHEN),
    "near_kitchen_center": (0.0, 0.0, KITCHEN),
    "near_kitchen_right": (HALF_W, 0.0, KITCHEN),
    "far_kitchen_left": (-HALF_W, 0.0, -KITCHEN),
    "far_kitchen_center": (0.0, 0.0, -KITCHEN),
    "far_kitchen_right": (HALF_W, 0.0, -KITCHEN),
    "far_baseline_left": (-HALF_W, 0.0, -HALF_L),
    "far_baseline_center": (0.0, 0.0, -HALF_L),
    "far_baseline_right": (HALF_W, 0.0, -HALF_L),
    "net_left_bottom": (-POST_X, 0.0, 0.0),
    "net_right_bottom": (POST_X, 0.0, 0.0),
    "net_left_top": (-POST_X, NET_POST, 0.0),
    "net_center_top": (0.0, NET_CENTER, 0.0),
    "net_right_top": (POST_X, NET_POST, 0.0),
}

KEYPOINT_LABELS = {
    "near_baseline_left": "近端底線·左角",
    "near_baseline_center": "近端底線·中點",
    "near_baseline_right": "近端底線·右角",
    "near_kitchen_left": "近端廚房線·左",
    "near_kitchen_center": "近端廚房線·中",
    "near_kitchen_right": "近端廚房線·右",
    "far_kitchen_left": "遠端廚房線·左",
    "far_kitchen_center": "遠端廚房線·中",
    "far_kitchen_right": "遠端廚房線·右",
    "far_baseline_left": "遠端底線·左角",
    "far_baseline_center": "遠端底線·中點",
    "far_baseline_right": "遠端底線·右角",
    "net_left_bottom": "左網柱·底",
    "net_right_bottom": "右網柱·底",
    "net_left_top": "左網柱·頂",
    "net_center_top": "球網中央·頂",
    "net_right_top": "右網柱·頂",
}


def court_lines() -> list[tuple[np.ndarray, np.ndarray]]:
    """畫預覽用的線段（世界座標）。"""
    segs = []
    for s in (1, -1):
        segs.append(((-HALF_W, 0, s * HALF_L), (HALF_W, 0, s * HALF_L)))  # 底線
        segs.append(((s * HALF_W, 0, -HALF_L), (s * HALF_W, 0, HALF_L)))  # 邊線
        segs.append(((-HALF_W, 0, s * KITCHEN), (HALF_W, 0, s * KITCHEN)))  # 廚房線
        segs.append(((0, 0, s * KITCHEN), (0, 0, s * HALF_L)))  # 中線
    # 球網上緣（中間較低）
    xs = np.linspace(-POST_X, POST_X, 9)
    top = [(x, NET_CENTER + (NET_POST - NET_CENTER) * (x / POST_X) ** 2, 0) for x in xs]
    segs += list(zip(top[:-1], top[1:]))
    segs += [((-POST_X, 0, 0), (-POST_X, NET_POST, 0)), ((POST_X, 0, 0), (POST_X, NET_POST, 0))]
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


def draw_court(img: np.ndarray, cam: Camera, color=(0, 255, 255), thickness=2) -> np.ndarray:
    out = img.copy()
    for a, b in court_lines():
        pts = cam.project(np.linspace(a, b, 24))
        in_front = (np.stack([a, b]) @ cam.R.T + cam.t)[:, 2] > 0
        if not in_front.all():
            continue
        cv2.polylines(out, [np.round(pts).astype(np.int32)], False, color, thickness, cv2.LINE_AA)
    return out
