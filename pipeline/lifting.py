"""把 2D 偵測結果變成球場上的 3D 骨架。

兩種方法：
  1. MediaPipe Pose（預設，人夠大時）：模型直接給以髖部為中心、以公尺為單位的 3D 關節，
     再用相機校正把整個人「放」到球場上：關節投影要對上畫面、腳要踩在地上。
  2. 骨長法（人太小、MediaPipe 抓不到時的備案）：用 YOLO 的 2D 關節 + 標準骨長，
     沿著相機射線推回 3D（手、膝往身體前方）。
"""
from __future__ import annotations

import os
import urllib.request
from pathlib import Path

import cv2
import numpy as np

from court import Camera

# viewer 用的 21 個關節：COCO-17 + 腳跟/腳尖
JOINTS = [
    "nose", "left_eye", "right_eye", "left_ear", "right_ear",
    "left_shoulder", "right_shoulder", "left_elbow", "right_elbow",
    "left_wrist", "right_wrist", "left_hip", "right_hip",
    "left_knee", "right_knee", "left_ankle", "right_ankle",
    "left_heel", "right_heel", "left_toe", "right_toe",
]
J = {n: i for i, n in enumerate(JOINTS)}
MP_INDEX = [0, 2, 5, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32]
FOOT = [J[n] for n in ("left_ankle", "right_ankle", "left_heel", "right_heel", "left_toe", "right_toe")]

MP_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_{0}/float16/latest/pose_landmarker_{0}.task"


def ensure_mediapipe_model(variant: str, cache_dir: str | None = None) -> str:
    cache = Path(cache_dir or os.environ.get("PK3D_CACHE", Path.home() / ".cache" / "pk3d"))
    cache.mkdir(parents=True, exist_ok=True)
    path = cache / f"pose_landmarker_{variant}.task"
    if not path.exists():
        print(f"下載 MediaPipe 模型 {variant} …")
        urllib.request.urlretrieve(MP_URL.format(variant), path)
    return str(path)


def rotation_to_ray(d: np.ndarray) -> np.ndarray:
    """把相機光軸 (0,0,1) 轉到方向 d 的最小旋轉。"""
    z = np.array([0.0, 0.0, 1.0])
    v = np.cross(z, d)
    c = float(z @ d)
    if np.linalg.norm(v) < 1e-9:
        return np.eye(3)
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx / (1 + c)


class MediaPipeLifter:
    def __init__(self, variant: str = "full", min_crop_height: int = 384):
        import mediapipe as mp
        from mediapipe.tasks.python import BaseOptions, vision

        self.mp = mp
        options = vision.PoseLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=ensure_mediapipe_model(variant)),
            running_mode=vision.RunningMode.IMAGE,
            num_poses=1,
            min_pose_detection_confidence=0.3,
            min_pose_presence_confidence=0.3,
        )
        self.landmarker = vision.PoseLandmarker.create_from_options(options)
        self.min_crop_height = min_crop_height

    def close(self):
        self.landmarker.close()

    def detect(self, frame: np.ndarray, box: np.ndarray, kpts: np.ndarray | None = None) -> dict | None:
        """對一個人的框跑 MediaPipe。回傳 33 個世界座標關節（髖部中心、公尺）與全畫面 2D 位置。"""
        H, W = frame.shape[:2]
        x0, y0, x1, y1 = box
        w, h = x1 - x0, y1 - y0
        X0, Y0 = int(max(0, x0 - 0.3 * w)), int(max(0, y0 - 0.12 * h))
        X1, Y1 = int(min(W, x1 + 0.3 * w)), int(min(H, y1 + 0.12 * h))
        if X1 - X0 < 8 or Y1 - Y0 < 16:
            return None
        crop = frame[Y0:Y1, X0:X1]
        s = max(1.0, self.min_crop_height / crop.shape[0])
        if s > 1:
            crop = cv2.resize(crop, None, fx=s, fy=s, interpolation=cv2.INTER_CUBIC)
        rgb = np.ascontiguousarray(cv2.cvtColor(crop, cv2.COLOR_BGR2RGB))
        res = self.landmarker.detect(self.mp.Image(image_format=self.mp.ImageFormat.SRGB, data=rgb))
        if not res.pose_world_landmarks:
            return None
        world = np.array([[p.x, p.y, p.z] for p in res.pose_world_landmarks[0]])
        lms = res.pose_landmarks[0]
        uv = np.array([[X0 + p.x * crop.shape[1] / s, Y0 + p.y * crop.shape[0] / s] for p in lms])
        vis = np.array([min(p.visibility, p.presence) for p in lms])

        # 驗證：MediaPipe 可能抓到旁邊的人，和 YOLO 的關節差太多就不用
        if kpts is not None:
            coco_mp = [0, 2, 5, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]
            ok = kpts[:, 2] > 0.5
            if ok.sum() >= 5:
                err = np.linalg.norm(uv[coco_mp][ok] - kpts[ok, :2], axis=1)
                if np.median(err) > 0.12 * h:
                    return None
        span = world[:, 1].max() - world[:, 1].min()
        if span < 0.9:  # 太矮 → 多半是錯的
            return None
        return {"world": world, "uv": uv, "vis": vis, "center": ((X0 + X1) / 2, (Y0 + Y1) / 2)}


def place_body(cam: Camera, rel: np.ndarray, uv: np.ndarray, w: np.ndarray, depth_hint: float,
               foot_clearance: float = 0.03) -> tuple[np.ndarray, float]:
    """已知身體形狀 rel（世界方向、以髖部為原點），求位置 T 與尺寸 s：
    關節投影對上 uv，且最低的腳落在地面。全部是線性方程式，一次最小平方解。"""
    P = cam.P
    f = cam.K[0, 0]
    uvu = cam.undistort(uv)
    rows, rhs = [], []
    norm = 1.0 / (depth_hint * f)
    for j in range(len(rel)):
        if not (w[j] > 0.05 and np.all(np.isfinite(rel[j])) and np.all(np.isfinite(uvu[j]))):
            continue
        for coord, Prow in ((uvu[j, 0], P[0]), (uvu[j, 1], P[1])):
            a = coord * P[2, :3] - Prow[:3]
            b = coord * P[2, 3] - Prow[3]
            rows.append(np.append(a, a @ rel[j]) * w[j] * norm)
            rhs.append(-b * w[j] * norm)
    feet = [j for j in FOOT if np.all(np.isfinite(rel[j]))]
    low = min(rel[j, 1] for j in feet) if feet else -0.9
    wg = 3.0 / depth_hint
    rows.append(np.array([0, wg, 0, wg * low]))
    rhs.append(wg * foot_clearance)
    ws = 30.0 / f
    rows.append(np.array([0, 0, 0, ws]))
    rhs.append(ws)
    sol, *_ = np.linalg.lstsq(np.array(rows), np.array(rhs), rcond=None)
    T, s = sol[:3], float(np.clip(sol[3], 0.75, 1.3))
    return T + s * rel, s


def lift_mediapipe(cam: Camera, mp_res: dict) -> np.ndarray:
    """MediaPipe 結果 → 21 個關節的世界座標。"""
    world = mp_res["world"][MP_INDEX]  # MediaPipe：x 右、y 下、z 遠離相機（與 OpenCV 相機座標同向）
    cu, cv_ = mp_res["center"]
    uvc = cam.undistort(np.array([[cu, cv_]]))[0]
    d = np.linalg.inv(cam.K) @ np.array([uvc[0], uvc[1], 1.0])
    d /= np.linalg.norm(d)
    body_cam = world @ rotation_to_ray(d).T
    rel = body_cam @ cam.R  # 相機方向 → 世界方向（= (Rᵀ · x)ᵀ）
    uv = mp_res["uv"][MP_INDEX]
    vis = mp_res["vis"][MP_INDEX]
    ground = cam.ground_points(uv[[J["left_ankle"], J["right_ankle"]]].mean(0, keepdims=True))[0]
    depth = float(np.linalg.norm(ground - cam.center)) if np.all(np.isfinite(ground)) else 10.0
    joints, _ = place_body(cam, rel, uv, vis, max(2.0, depth))
    return joints


# ---------- 備案：骨長法 ----------
BONE = {  # 1.75 m 成人的大約骨長（公尺）
    ("mid_hip", "left_hip"): 0.10, ("mid_hip", "right_hip"): 0.10,
    ("left_hip", "left_knee"): 0.45, ("right_hip", "right_knee"): 0.45,
    ("left_knee", "left_ankle"): 0.44, ("right_knee", "right_ankle"): 0.44,
    ("mid_hip", "neck"): 0.52,
    ("neck", "left_shoulder"): 0.19, ("neck", "right_shoulder"): 0.19,
    ("left_shoulder", "left_elbow"): 0.30, ("right_shoulder", "right_elbow"): 0.30,
    ("left_elbow", "left_wrist"): 0.27, ("right_elbow", "right_wrist"): 0.27,
    ("neck", "nose"): 0.22, ("nose", "left_eye"): 0.04, ("nose", "right_eye"): 0.04,
    ("nose", "left_ear"): 0.11, ("nose", "right_ear"): 0.11,
}
# 深度方向的偏好：+1 = 往身體前方（面向球網），-1 = 往後，0 = 盡量不偏
FRONT = {"left_knee": 1, "right_knee": 1, "left_elbow": 0.6, "right_elbow": 0.6,
         "left_wrist": 1, "right_wrist": 1, "left_ankle": -0.3, "right_ankle": -0.3, "nose": 1}


def lift_bone_lengths(cam: Camera, kpts: np.ndarray, box: np.ndarray, facing: np.ndarray) -> np.ndarray:
    """只有 YOLO 的 COCO-17 2D 關節時：沿射線、依骨長推回 3D。facing = 面向（水平單位向量）。"""
    ok = kpts[:, 2] > 0.3
    C = cam.center
    pts2d = {n: kpts[J[n], :2] for n in JOINTS[:17] if ok[J[n]]}

    # 站位：腳踝 → 地面；沒有腳踝就用框的底部中點
    ankles = [kpts[J[n], :2] for n in ("left_ankle", "right_ankle") if ok[J[n]]]
    foot_uv = np.mean(ankles, 0) if ankles else np.array([(box[0] + box[2]) / 2, box[3]])
    G = cam.ground_points(foot_uv[None], height=0.08 if ankles else 0.0)[0]
    if not np.all(np.isfinite(G)):
        return np.full((len(JOINTS), 3), np.nan)
    normal = C - G
    normal[1] = 0
    normal /= np.linalg.norm(normal) + 1e-9

    def on_plane(uv, point=G):
        d = cam.rays(uv[None])[0]
        s = ((point - C) @ normal) / (d @ normal)
        return C + s * d

    out: dict[str, np.ndarray] = {}
    hips = [pts2d[n] for n in ("left_hip", "right_hip") if n in pts2d]
    hip_uv = np.mean(hips, 0) if hips else np.array([(box[0] + box[2]) / 2, box[1] + 0.47 * (box[3] - box[1])])
    out["mid_hip"] = on_plane(hip_uv)
    out["mid_hip"][1] = np.clip(out["mid_hip"][1], 0.6, 1.1)

    def child(parent: str, name: str, uv: np.ndarray | None):
        P = out[parent]
        L = BONE[(parent, name)]
        if uv is None:
            return
        d = cam.rays(uv[None])[0]
        b = d @ (P - C)
        disc = b * b - (np.sum((P - C) ** 2) - L * L)
        if disc <= 0:
            out[name] = C + b * d  # 2D 長度已經超過骨長 → 取射線上最近點
            return
        cands = [C + (b + sgn * np.sqrt(disc)) * d for sgn in (-1, 1)]
        pref = FRONT.get(name, 0)
        score = [pref * ((X - P) @ facing) - (0 if pref else abs((X - P) @ normal)) for X in cands]
        out[name] = cands[int(np.argmax(score))]

    for side in ("left", "right"):
        child("mid_hip", f"{side}_hip", pts2d.get(f"{side}_hip"))
    shoulders = [pts2d[n] for n in ("left_shoulder", "right_shoulder") if n in pts2d]
    child("mid_hip", "neck", np.mean(shoulders, 0) if shoulders else None)
    for side in ("left", "right"):
        if f"{side}_hip" in out:
            child(f"{side}_hip", f"{side}_knee", pts2d.get(f"{side}_knee"))
        if f"{side}_knee" in out:
            child(f"{side}_knee", f"{side}_ankle", pts2d.get(f"{side}_ankle"))
        if "neck" in out:
            child("neck", f"{side}_shoulder", pts2d.get(f"{side}_shoulder"))
        if f"{side}_shoulder" in out:
            child(f"{side}_shoulder", f"{side}_elbow", pts2d.get(f"{side}_elbow"))
        if f"{side}_elbow" in out:
            child(f"{side}_elbow", f"{side}_wrist", pts2d.get(f"{side}_wrist"))
    if "neck" in out:
        child("neck", "nose", pts2d.get("nose"))
    if "nose" in out:
        for n in ("left_eye", "right_eye", "left_ear", "right_ear"):
            child("nose", n, pts2d.get(n))

    joints = np.full((len(JOINTS), 3), np.nan)
    for n, X in out.items():
        if n in J:
            joints[J[n]] = X
    # 腳掌：腳踝往下到地面，往面向方向延伸
    for side in ("left", "right"):
        a = joints[J[f"{side}_ankle"]]
        if np.all(np.isfinite(a)):
            a = a.copy()
            a[1] = max(a[1], 0.07)
            joints[J[f"{side}_ankle"]] = a
            joints[J[f"{side}_heel"]] = a + np.array([0, -0.05, 0]) - 0.05 * facing
            joints[J[f"{side}_toe"]] = a + np.array([0, -0.05, 0]) + 0.14 * facing
    return joints
