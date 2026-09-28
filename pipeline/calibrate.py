"""相機校正：用球場上已知位置的點，算出攝影機的焦距、位置與角度。

步驟：
  1. 打開網頁的校正點工具（web/calibrate.html），載入影片，在畫面上點出看得到的球場角點，
     按「下載 points.json」。
  2. python calibrate.py --points points.json --video 你的影片.mp4 --out calib.json
     會印出誤差，並輸出一張 calib_preview.jpg（黃線 = 用算出來的相機畫回去的球場線，應該和真實的線重疊）。

至少要 4 個「地面上」的點（例如近端底線兩角＋近端發球線／廚房線兩端）；點越多、分布越開越準。
攝影機必須是固定的（不能跟拍轉動或變焦）。支援網球和匹克球（points.json 裡的 sport 欄位）。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np
from scipy.optimize import least_squares

from court import SPORTS, Camera, Sport, draw_court, get_sport


def focal_from_homography(obj_xz: np.ndarray, img_uv: np.ndarray, cx: float, cy: float) -> float | None:
    """由地面點的 homography 估計焦距（假設主點在畫面中心、像素是正方形）。"""
    H, _ = cv2.findHomography(obj_xz, img_uv - [cx, cy], 0)
    if H is None:
        return None
    (h11, h12, _), (h21, h22, _), (h31, h32, _) = H
    cands = []
    if abs(h31 * h32) > 1e-12:
        cands.append(-(h11 * h12 + h21 * h22) / (h31 * h32))
    if abs(h31**2 - h32**2) > 1e-12:
        cands.append(((h11**2 + h21**2) - (h12**2 + h22**2)) / (h31**2 - h32**2))
    cands = [c for c in cands if c > 0]
    return float(np.sqrt(np.median(cands))) if cands else None


def infer_sport(points: dict) -> str:
    """沒寫球種時，從點的名稱猜（發球線 → 網球，廚房線 → 匹克球）。"""
    scores = {k: sum(n in sp.keypoints for n in points) - sum(n not in sp.keypoints for n in points)
              for k, sp in SPORTS.items()}
    return max(scores, key=scores.get)


def solve(points: dict[str, list[float]], width: int, height: int, fit_k1: bool | None = None,
          sport: Sport | None = None):
    sport = sport or get_sport(infer_sport(points))
    KEYPOINTS = sport.keypoints
    names = [n for n in points if n in KEYPOINTS and points[n] is not None]
    unknown = [n for n in points if n not in KEYPOINTS]
    if unknown:
        print(f"忽略不認得的點：{unknown}", file=sys.stderr)
    obj = np.array([KEYPOINTS[n] for n in names], np.float64)
    img = np.array([points[n] for n in names], np.float64)
    ground = obj[:, 1] == 0
    if ground.sum() < 4:
        raise SystemExit(f"至少需要 4 個地面上的點，目前只有 {int(ground.sum())} 個。")
    if fit_k1 is None:
        fit_k1 = len(names) >= 7  # 點夠多才順便估鏡頭桶狀變形
    cx, cy = width / 2, height / 2

    guesses = [0.5, 0.7, 0.9, 1.2, 1.6, 2.2, 3.0]
    f_h = focal_from_homography(obj[ground][:, [0, 2]], img[ground], cx, cy)
    guesses = ([f_h / width] if f_h else []) + guesses

    def unpack(p):
        f = np.exp(p[0])
        K = np.array([[f, 0, cx], [0, f, cy], [0, 0, 1]])
        dist = np.array([p[1] if fit_k1 else 0.0, 0, 0, 0, 0])
        return K, dist, p[2:5], p[5:8]

    def residuals(p):
        K, dist, rvec, tvec = unpack(p)
        uv, _ = cv2.projectPoints(obj, rvec, tvec, K, dist)
        r = (uv.reshape(-1, 2) - img).ravel()
        return np.concatenate([r, [p[1] * 20.0]])  # k1 的小先驗，避免亂跑

    best = None
    for g in guesses:
        f = g * width
        K0 = np.array([[f, 0, cx], [0, f, cy], [0, 0, 1]])
        ok, rvec, tvec = cv2.solvePnP(obj, img, K0, None, flags=cv2.SOLVEPNP_SQPNP)
        if not ok:
            continue
        p0 = np.concatenate([[np.log(f), 0.0], rvec.ravel(), tvec.ravel()])
        res = least_squares(residuals, p0, method="lm" if len(names) * 2 + 1 >= len(p0) else "trf")
        K, dist, rvec, tvec = unpack(res.x)
        R, _ = cv2.Rodrigues(rvec)
        C = -R.T @ tvec
        depth = (obj @ R.T + tvec)[:, 2]
        if C[1] <= 0.2 or np.any(depth <= 0):
            continue  # 相機跑到地面下或點在相機後面 → 不合理的解
        rms = float(np.sqrt(np.mean(res.fun[:-1] ** 2) * 2))
        if best is None or rms < best[0]:
            best = (rms, Camera(K, dist, R, tvec, width, height))
    if best is None:
        raise SystemExit("找不到合理的相機解，請檢查點有沒有標錯（左右、近遠是否顛倒）。")
    rms, cam = best
    errors = {n: float(np.linalg.norm(e)) for n, e in zip(names, cam.project(obj) - img)}
    return cam, rms, errors


def read_frame(video: str | None, image: str | None, time: float) -> np.ndarray | None:
    if image:
        return cv2.imread(image)
    if video:
        cap = cv2.VideoCapture(video)
        cap.set(cv2.CAP_PROP_POS_MSEC, time * 1000)
        ok, frame = cap.read()
        cap.release()
        return frame if ok else None
    return None


def main():
    ap = argparse.ArgumentParser(description="用球場角點校正攝影機")
    ap.add_argument("--points", required=True, help="校正點工具下載的 points.json")
    ap.add_argument("--video", help="原始影片（用來輸出預覽圖）")
    ap.add_argument("--image", help="或直接給一張畫面截圖")
    ap.add_argument("--out", default="calib.json")
    ap.add_argument("--preview", default=None, help="預覽圖路徑（預設：和 --out 同名 _preview.jpg）")
    ap.add_argument("--k1", choices=["auto", "on", "off"], default="auto", help="是否估計鏡頭變形")
    ap.add_argument("--sport", choices=list(SPORTS), default=None, help="球種（預設讀 points.json）")
    args = ap.parse_args()

    with open(args.points, encoding="utf-8") as f:
        data = json.load(f)
    points = data["points"]
    width, height = int(data["width"]), int(data["height"])
    fit_k1 = {"auto": None, "on": True, "off": False}[args.k1]
    sport = get_sport(args.sport or data.get("sport") or infer_sport(points))
    print(f"球種：{sport.name}")

    cam, rms, errors = solve(points, width, height, fit_k1, sport)
    C = cam.center
    fov = np.degrees(2 * np.arctan(width / (2 * cam.K[0, 0])))
    print(f"重投影誤差 RMS = {rms:.2f} px（< 3 px 算好，> 8 px 請檢查點）")
    for n, e in sorted(errors.items(), key=lambda kv: -kv[1]):
        flag = "  ← 偏大" if e > max(6, 2.5 * rms) else ""
        print(f"  {sport.labels[n]:<12s} {e:6.2f} px{flag}")
    print(f"相機位置 x={C[0]:.2f} y(高度)={C[1]:.2f} z={C[2]:.2f} m，水平視角 {fov:.1f}°，k1={cam.dist[0]:.3f}")
    if C[2] < 0:
        print("⚠ 相機在遠端那一側：near / far 可能標反了。", file=sys.stderr)

    out = {
        "sport": sport.id,
        "camera": cam.to_json(),
        "rms": round(rms, 3),
        "errors": {k: round(v, 2) for k, v in errors.items()},
        "cameraPosition": np.round(C, 3).tolist(),
        "horizontalFovDeg": round(float(fov), 2),
        "points": points,
    }
    Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"已輸出 {args.out}")

    frame = read_frame(args.video or data.get("video"), args.image, float(data.get("time", 0)))
    if frame is not None:
        if frame.shape[1] != width or frame.shape[0] != height:
            frame = cv2.resize(frame, (width, height))
        prev = draw_court(frame, cam, sport, (0, 230, 255), 2)
        proj = dict(zip(errors, cam.project(np.array([sport.keypoints[n] for n in errors]))))
        for n, uv in proj.items():
            p = tuple(int(round(x)) for x in points[n])
            q = tuple(int(round(x)) for x in uv)
            cv2.circle(prev, p, 6, (0, 0, 255), 2, cv2.LINE_AA)
            cv2.circle(prev, q, 2, (0, 255, 0), -1, cv2.LINE_AA)
        path = args.preview or str(Path(args.out).with_name(Path(args.out).stem + "_preview.jpg"))
        cv2.imwrite(path, prev)
        print(f"預覽圖：{path}（紅圈 = 你點的位置，綠點 = 模型算回去的位置，黃線 = 球場線）")


if __name__ == "__main__":
    main()
