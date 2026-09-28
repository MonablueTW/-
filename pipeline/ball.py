"""球的偵測與 3D 軌跡。

單一攝影機看不出球有多遠，但球在空中的加速度幾乎固定（重力＋空氣阻力＋旋轉）：
一段飛行的未知數是起點、初速、加速度，每一格的 2D 位置提供 2 個方程式，
而且方程式對未知數是線性的 → 用最小平方法就能解出 3D 軌跡。
加速度給一個「接近重力」的先驗（垂直方向約 -9.8 m/s²），深度和尺度就定得下來；
落地反彈、擊球的手也當成參考點，短的飛行段會穩很多。

2D 偵測用「在動 + 顏色像球」：三格相減找出移動的小東西，再用球的顏色（預設黃綠色）過濾。
這是入門做法；想要更準可以換成 TrackNet 之類專門抓球的模型（見 README）。
"""
from __future__ import annotations

from collections import deque

import cv2
import numpy as np

from court import Camera, Sport

G = np.array([0.0, -9.81, 0.0])
# 球種的合理範圍：最高高度（公尺）、最大速度（m/s）、一格之內在畫面上最多移動畫面寬度的幾分之幾
LIMITS = {"pickleball": (7.0, 35.0, 0.06), "tennis": (14.0, 75.0, 0.1)}
# 加速度先驗（平均, 標準差）：水平方向主要是空氣阻力，垂直方向是重力（上旋會再往下拉一點）
ACCEL_PRIOR = {
    "pickleball": (np.array([0.0, -9.81, 0.0]), np.array([6.0, 3.0, 6.0])),
    "tennis": (np.array([0.0, -9.81, 0.0]), np.array([12.0, 4.0, 12.0])),
}


class BallDetector:
    def __init__(self, cam: Camera, hsv_lo=(20, 70, 110), hsv_hi=(50, 255, 255), diff_threshold=16):
        self.cam = cam
        self.lo, self.hi = np.array(hsv_lo, np.uint8), np.array(hsv_hi, np.uint8)
        self.diff = diff_threshold
        self.buf: deque = deque(maxlen=3)
        scale = cam.width / 1280
        self.min_area, self.max_area = max(2, int(3 * scale**2)), int(400 * scale**2)

    def push(self, f: int, frame: np.ndarray):
        """每一格都要推進來；回傳「上一格」的候選位置 (f-1, [(u, v, 面積), ...])。"""
        gray = cv2.GaussianBlur(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), (3, 3), 0)
        self.buf.append((f, frame, gray))
        if len(self.buf) < 3:
            return None
        (_, _, g0), (fm, fr, g1), (_, _, g2) = self.buf
        motion = (cv2.absdiff(g1, g0) > self.diff) & (cv2.absdiff(g1, g2) > self.diff)
        color = cv2.inRange(cv2.cvtColor(fr, cv2.COLOR_BGR2HSV), self.lo, self.hi) > 0
        mask = cv2.dilate((motion & color).astype(np.uint8), np.ones((3, 3), np.uint8))
        n, _, stats, cents = cv2.connectedComponentsWithStats(mask, connectivity=8)
        cands = []
        for i in range(1, n):
            _, _, w, h, area = stats[i]
            # 球是小點；動態模糊會拉長，但不會變成大片
            if self.min_area <= area <= self.max_area and max(w, h) <= 5 * max(1, min(w, h)):
                cands.append((float(cents[i][0]), float(cents[i][1]), float(area)))
        return fm, cands


def remove_people(cands: dict[int, list], person_boxes: dict[int, list], pad: float = 0.06) -> dict[int, list]:
    """去掉落在球員框裡的候選點（黃色衣服、球拍的晃動最容易誤判成球）。擊球瞬間的球會一起被去掉，沒關係。"""
    keys = np.array(sorted(person_boxes))
    out = {}
    for f, cs in cands.items():
        boxes = []
        if len(keys):
            k = keys[np.clip(np.searchsorted(keys, f), 0, len(keys) - 1)]
            boxes = person_boxes[int(k)]
        kept = []
        for u, v, a in cs:
            inside = False
            for x0, y0, x1, y1 in boxes:
                px, py = pad * (x1 - x0), pad * (y1 - y0)
                if x0 - px < u < x1 + px and y0 - py < v < y1 + py:
                    inside = True
                    break
            if not inside:
                kept.append((u, v, a))
        if kept:
            out[f] = kept
    return out


def link_tracks(cands: dict[int, list], max_jump: float, max_gap: int = 3, min_len: int = 6):
    """把每一格的候選點串成平滑的軌跡：已經有方向的軌跡，下一點必須落在等速預測附近。"""
    active, done = [], []
    for f in sorted(cands):
        pts = cands[f]
        used = set()
        for tr in sorted(active, key=len, reverse=True):  # 長的軌跡優先配對
            f1, u1, v1 = tr[-1]
            gap = f - f1
            if len(tr) >= 2:
                f0, u0, v0 = tr[-2]
                du, dv = (u1 - u0) / (f1 - f0), (v1 - v0) / (f1 - f0)
                pu, pv = u1 + du * gap, v1 + dv * gap
                gate = 6 + 2 * gap + 0.35 * np.hypot(du, dv) * gap
            else:
                pu, pv, gate = u1, v1, max_jump * gap
            best, bd = None, gate
            for k, (u, v, _) in enumerate(pts):
                d = np.hypot(u - pu, v - pv)
                if k not in used and d < bd:
                    best, bd = k, d
            if best is not None:
                used.add(best)
                tr.append((f, pts[best][0], pts[best][1]))
        for k, (u, v, _) in enumerate(pts):
            if k not in used:
                active.append([(f, u, v)])
        still = []
        for tr in active:
            (done if f - tr[-1][0] > max_gap else still).append(tr)
        active = still
    done += active
    tracks = [tr for tr in done
              if len(tr) >= min_len and np.hypot(tr[-1][1] - tr[0][1], tr[-1][2] - tr[0][2]) > 0.5 * max_jump]
    tracks.sort(key=len, reverse=True)
    taken, out = set(), []
    for tr in tracks:  # 同一格只留最長那條軌跡的點
        tr = [p for p in tr if p[0] not in taken]
        if len(tr) >= min_len:
            taken.update(p[0] for p in tr)
            out.append(tr)
    return out


def fit_arc(cam: Camera, obs: list, fps: float, t0: int, bounce_at: list[int] = (), anchors: list = (),
            accel_prior=None, ball_radius: float = 0.037, px_sigma: float = 1.5):
    """一段飛行：X(t) = p0 + v0·dt + ½·a·dt²。
    accel_prior=None → a 固定為重力；(平均, 標準差) → a 也一起解（有空氣阻力、旋轉的球）。
    bounce_at：落地前最後一格（球離地約 5 公分，容許 10 公分）；anchors：[(影格, 位置, 容許誤差)]。
    回傳 (p0, v0, a, rms 像素誤差)。"""
    P = cam.P
    uv = cam.undistort(np.array([[u, v] for _, u, v in obs]))
    ts = np.array([(f - t0) / fps for f, _, _ in obs])
    free = accel_prior is not None
    rows, rhs = [], []
    for dt, (u, v) in zip(ts, uv):
        for coord, Prow in ((u, P[0]), (v, P[1])):
            a = coord * P[2, :3] - Prow[:3]
            c = coord * P[2, 3] - Prow[3]
            if free:
                rows.append(np.concatenate([a, a * dt, a * 0.5 * dt * dt]))
                rhs.append(-c)
            else:
                rows.append(np.concatenate([a, a * dt]))
                rhs.append(-(c + a @ (0.5 * G * dt * dt)))
    A, b = np.array(rows), np.array(rhs)
    n = A.shape[1]

    def extra(dt, axis):
        r = np.zeros(n)
        r[axis], r[3 + axis] = 1, dt
        if free:
            r[6 + axis] = 0.5 * dt * dt
        return r, (0.0 if free else 0.5 * G[axis] * dt * dt)

    prior_rows, prior_rhs = [], []
    for fb in bounce_at:
        r, g = extra((fb - t0) / fps, 1)
        prior_rows.append(r / 0.1)
        prior_rhs.append((ball_radius + 0.05 - g) / 0.1)
    for fa, target, sigma in anchors:
        for k in range(3):
            r, g = extra((fa - t0) / fps, k)
            prior_rows.append(r / sigma)
            prior_rhs.append((target[k] - g) / sigma)
    if free:
        mean, sd = accel_prior
        for k in range(3):
            r = np.zeros(n)
            r[6 + k] = 1 / sd[k]
            prior_rows.append(r)
            prior_rhs.append(mean[k] / sd[k])

    def solve(weights):
        Aw = np.vstack([A * weights[:, None]] + ([np.array(prior_rows)] if prior_rows else []))
        bw = np.concatenate([b * weights] + ([np.array(prior_rhs)] if prior_rhs else []))
        sol, *_ = np.linalg.lstsq(Aw, bw, rcond=None)
        return sol[:3], sol[3:6], (sol[6:9] if free else G.copy())

    def positions(p0, v0, acc):
        return p0 + np.outer(ts, v0) + 0.5 * np.outer(ts * ts, acc)

    # 先用「到場地中心的距離」當深度粗解一次，再用算出的深度重新加權：每一列都變成「幾個標準差」
    guess = float(np.linalg.norm(cam.center))
    p0, v0, acc = solve(np.full(len(A), 1.0 / (guess * px_sigma)))
    depth = np.clip((positions(p0, v0, acc) @ cam.R.T + cam.t)[:, 2], 0.5, 300)
    p0, v0, acc = solve(np.repeat(1.0 / (depth * px_sigma), 2))
    err = cam.project(positions(p0, v0, acc)) - np.array([[u, v] for _, u, v in obs])
    return p0, v0, acc, float(np.sqrt(np.mean(np.sum(err**2, axis=1))))


def plausible(p0, v0, acc, ts, sport: Sport) -> bool:
    max_h, max_v, _ = LIMITS[sport.id]
    X = p0 + np.outer(ts, v0) + 0.5 * np.outer(ts * ts, acc)
    return (
        np.all(X[:, 1] > -0.3) and np.all(X[:, 1] < max_h)
        and np.all(np.abs(X[:, 0]) < sport.half_width + 6) and np.all(np.abs(X[:, 2]) < sport.half_length + 8)
        and np.linalg.norm(v0) < max_v
    )


def _hand_anchors(seg: list, wrist_anchor: dict | None, sigma: float = 0.3) -> list:
    """這段軌跡的頭尾如果貼近某位球員的手（2D），就把那隻手的 3D 位置當參考點（容許 sigma 公尺）。"""
    if not wrist_anchor:
        return []
    out = []
    for f, u, v in (seg[0], seg[-1]):
        best = None
        for ff in (f, f - 1, f + 1):
            for uv, X, h in wrist_anchor.get(ff, []):
                for k in range(2):
                    d = np.hypot(*(uv[k] - (u, v)))
                    if d < 0.45 * h and np.all(np.isfinite(X[k])) and (best is None or d < best[0]):
                        best = (d, X[k])
        if best is not None:
            out.append((f, best[1], sigma))
    return out


def reconstruct_ball(cam: Camera, cands: dict[int, list], fps: float, first: int, last: int, sport: Sport,
                     wrist_anchor: dict | None = None, max_rms: float = 3.0, min_seg: int = 10) -> dict[int, np.ndarray]:
    """回傳 {影格: 3D 位置}。wrist_anchor：{影格: [(兩手腕 2D, 兩手腕 3D, 框高)]}。"""
    max_rms *= max(1.0, cam.width / 1280)
    max_jump = LIMITS[sport.id][2] * cam.width
    prior = ACCEL_PRIOR[sport.id]
    positions: dict[int, np.ndarray] = {}
    for tr in link_tracks(cands, max_jump):
        i = 0
        while i + min_seg <= len(tr):
            # 1) 先只看 2D：加速度可自由調整的模型能貼合有空氣阻力的彎曲，用來決定一段飛行到哪裡結束
            seg = tr[i:i + min_seg]
            if fit_arc(cam, seg, fps, seg[0][0], accel_prior=prior)[3] > max_rms:
                i += 1
                continue
            j = i + min_seg
            while j < len(tr) and fit_arc(cam, tr[i:j + 1], fps, tr[i][0], accel_prior=prior)[3] <= max_rms:
                j += 1
            seg = tr[i:j]
            t0, end_f = seg[0][0], seg[-1][0]
            # 2) 再解 3D。單一攝影機看不出深度，要靠兩端的參考點定住：
            #    軌跡在畫面上「往下走再往上」→ 這裡落地；頭尾貼近球員的手 → 擊球點
            bounce = [end_f] if j < len(tr) and seg[-1][2] > seg[-2][2] and tr[j][2] < seg[-1][2] else []
            hands = _hand_anchors(seg, wrist_anchor)
            p0, v0, acc, rms = fit_arc(cam, seg, fps, t0, ball_radius=sport.ball_radius)  # 沒有參考點：只用重力
            if bounce or hands:
                p, v, a, r = fit_arc(cam, seg, fps, t0, accel_prior=prior, ball_radius=sport.ball_radius,
                                     bounce_at=bounce, anchors=hands)
                if r < max_rms * 1.5:
                    p0, v0, acc = p, v, a
            ts = np.arange(t0, end_f + 1)
            dts = (ts - t0) / fps
            if plausible(p0, v0, acc, dts, sport):
                X = p0 + np.outer(dts, v0) + 0.5 * np.outer(dts * dts, acc)
                X[:, 1] = np.maximum(X[:, 1], sport.ball_radius)
                for f, x in zip(ts, X):
                    if first <= f <= last:
                        positions[int(f)] = x
            i = j
    return positions
