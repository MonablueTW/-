"""幾何與後處理的單元測試（不需要 AI 模型）。執行：cd pipeline && python -m unittest discover tests"""
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ball import ACCEL_PRIOR, G, fit_arc, link_tracks  # noqa: E402
from calibrate import solve  # noqa: E402
from court import SPORTS, Camera  # noqa: E402
from lifting import J, JOINTS, place_body  # noqa: E402
from players import COLOR_NAMES, Detection, PlayerTracker  # noqa: E402

KEYPOINTS = SPORTS["pickleball"].keypoints
from reconstruct import smooth_track  # noqa: E402


def make_camera(C=(-3.8, 1.8, 8.5), target=(0.5, 0.0, -0.5), f=700.0, w=1280, h=720) -> Camera:
    C, target = np.array(C, float), np.array(target, float)
    fwd = (target - C) / np.linalg.norm(target - C)
    right = np.cross(fwd, [0, 1, 0])
    right /= np.linalg.norm(right)
    down = np.cross(fwd, right)
    R = np.stack([right, down, fwd])
    K = np.array([[f, 0, w / 2], [0, f, h / 2], [0, 0, 1]])
    return Camera(K, np.zeros(5), R, -R @ C, w, h)


class CameraTest(unittest.TestCase):
    def test_ground_backprojection_round_trip(self):
        cam = make_camera()
        pts = np.array([[1.0, 0.0, 2.0], [-2.5, 0.0, -5.0], [0.3, 0.0, 6.0]])
        back = cam.ground_points(cam.project(pts))
        np.testing.assert_allclose(back, pts, atol=1e-6)

    def test_calibration_recovers_camera(self):
        cam = make_camera()
        names = ["near_kitchen_left", "near_kitchen_center", "near_kitchen_right",
                 "near_baseline_right", "near_baseline_center", "far_kitchen_left", "net_center_top"]
        uv = cam.project(np.array([KEYPOINTS[n] for n in names]))
        rng = np.random.default_rng(0)
        points = {n: (p + rng.normal(0, 0.5, 2)).tolist() for n, p in zip(names, uv)}
        solved, rms, _ = solve(points, cam.width, cam.height, fit_k1=False, sport=SPORTS["pickleball"])
        self.assertLess(rms, 1.5)
        self.assertLess(np.linalg.norm(solved.center - cam.center), 0.1)
        self.assertAlmostEqual(solved.K[0, 0] / cam.K[0, 0], 1.0, delta=0.02)


class BallTest(unittest.TestCase):
    def test_ballistic_fit_is_exact_without_noise(self):
        cam = make_camera()
        p0, v0 = np.array([-1.0, 0.6, -6.0]), np.array([0.8, 4.2, 9.5])
        ts = np.arange(20) / 30
        X = p0 + np.outer(ts, v0) + 0.5 * np.outer(ts**2, G)
        obs = [(i, u, v) for i, (u, v) in enumerate(cam.project(X))]
        p, v, _, rms = fit_arc(cam, obs, 30, 0)
        np.testing.assert_allclose(p, p0, atol=1e-5)
        np.testing.assert_allclose(v, v0, atol=1e-5)
        self.assertLess(rms, 1e-3)

    def test_bounce_prior_stabilises_short_far_arc(self):
        # 往遠場飛、只看到落地前 10 格：單純拋物線在深度上很不穩，加上「落地」條件後誤差小很多
        cam = make_camera()
        p0, v0 = np.array([0.5, 1.2, 1.0]), np.array([0.3, 1.0, -9.0])
        t_land = (v0[1] + np.sqrt(v0[1] ** 2 + 2 * 9.81 * (p0[1] - 0.037))) / 9.81
        n = int(t_land * 30)
        first = n - 9
        free, bounce = [], []
        for seed in range(15):
            rng = np.random.default_rng(seed)
            ts = np.arange(first, n + 1) / 30
            X = p0 + np.outer(ts, v0) + 0.5 * np.outer(ts**2, G)
            obs = [(first + i, u + rng.normal(0, 1), v + rng.normal(0, 1)) for i, (u, v) in enumerate(cam.project(X))]
            truth = X[0]
            free.append(np.linalg.norm(fit_arc(cam, obs, 30, first)[0] - truth))
            bounce.append(np.linalg.norm(fit_arc(cam, obs, 30, first, bounce_at=[n])[0] - truth))
        self.assertLess(np.median(bounce), 1.0)
        self.assertLess(np.median(bounce), 0.5 * np.median(free))

    def test_linking_rejects_zigzag_noise(self):
        rng = np.random.default_rng(1)
        cands = {f: [(100 + 20 * f, 300 - 8 * f + 0.2 * f * f, 10.0)] for f in range(15)}  # 平滑的球
        for f in range(15):  # 到處亂跳的雜訊
            cands[f].append((600 + rng.uniform(-60, 60), 400 + rng.uniform(-60, 60), 10.0))
        tracks = link_tracks(cands, max_jump=80)
        self.assertEqual(len(tracks[0]), 15)
        self.assertTrue(all(abs(u - (100 + 20 * f)) < 1e-6 for f, u, _ in tracks[0]))


def simulate_tennis(p0, v0, spin_rpm, fps=30, r=0.0335):
    """有空氣阻力與上旋的網球，飛到落地為止（每格一個位置）。"""
    rho, m, cd = 1.2, 0.057, 0.55
    area = np.pi * r * r
    k, w = 0.5 * rho * cd * area / m, spin_rpm * 2 * np.pi / 60
    x, v, out, i = np.array(p0, float), np.array(v0, float), [], 0
    while x[1] > r or i == 0:
        if i % (3000 // fps) == 0:
            out.append(x.copy())
        speed = np.linalg.norm(v)
        horiz = np.array([v[0], 0, v[2]])
        axis = np.cross(horiz / np.linalg.norm(horiz), [0, 1, 0])
        lift = 0.3 * min(1, r * w / speed)
        a = G - k * speed * v + 0.5 * rho * lift * area * speed * speed / m * np.cross(axis, v / speed)
        v, x, i = v + a / 3000, x + v / 3000, i + 1
    return np.array(out)


class TennisTest(unittest.TestCase):
    def test_tennis_calibration_from_broadcast_view(self):
        sport = SPORTS["tennis"]
        cam = make_camera(C=(0.0, 9.0, 25.0), target=(0.0, 0.0, -1.0), f=1500)
        names = [n for n in sport.keypoints if n.startswith(("near_", "far_"))]
        uv = cam.project(np.array([sport.keypoints[n] for n in names]))
        rng = np.random.default_rng(5)
        points = {n: (p + rng.normal(0, 0.7, 2)).tolist() for n, p in zip(names, uv)}
        solved, rms, _ = solve(points, cam.width, cam.height, fit_k1=False)  # 球種由點名推斷
        self.assertLess(rms, 1.5)
        self.assertLess(np.linalg.norm(solved.center - cam.center), 0.3)

    def test_anchored_drive_with_drag_and_topspin(self):
        # 轉播機位看一球 30 m/s 的上旋抽球：兩端有參考點（擊球的手、落地）才定得住深度
        cam = make_camera(C=(0.0, 9.0, 25.0), target=(0.0, 0.0, -1.0), f=1500)
        X = simulate_tennis((1.0, 1.0, 11.5), (-0.8, 3.0, -30.0), 2500)
        n, errs = len(X), []
        for seed in range(10):
            rng = np.random.default_rng(seed)
            obs = [(i, u + rng.normal(0, 1.5), v + rng.normal(0, 1.5)) for i, (u, v) in enumerate(cam.project(X))]
            hand = [(0, X[0] + rng.normal(0, 0.2, 3), 0.3)]
            p, v, a, _ = fit_arc(cam, obs, 30, 0, accel_prior=ACCEL_PRIOR["tennis"], ball_radius=0.0335,
                                 bounce_at=[n - 1], anchors=hand)
            ts = np.arange(n) / 30
            errs.append(np.median(np.linalg.norm(p + np.outer(ts, v) + 0.5 * np.outer(ts**2, a) - X, axis=1)))
        self.assertLess(np.median(errs), 0.8)

    def test_singles_tracker_keeps_one_player_per_side(self):
        white, blue = np.zeros(len(COLOR_NAMES)), np.zeros(len(COLOR_NAMES))
        white[COLOR_NAMES.index("白")] = 1
        blue[COLOR_NAMES.index("藍")] = 1
        tr = PlayerTracker(fps=10, per_side=1)
        for f in range(30):
            dets = [Detection(np.zeros(4), np.zeros((17, 3)), 0.9, np.array([np.sin(f / 5) * 3, 12.0]), white),
                    Detection(np.zeros(4), np.zeros((17, 3)), 0.9, np.array([-np.sin(f / 5) * 3, -12.0]), blue)]
            out = tr.assign(f, dets)
            self.assertIs(out[0].color, white)
            self.assertIs(out[1].color, blue)
        self.assertEqual(tr.names(), ["近場·白衣", "遠場·藍衣"])


class LiftingTest(unittest.TestCase):
    def test_place_body_recovers_position_and_scale(self):
        cam = make_camera()
        rng = np.random.default_rng(2)
        rel = rng.normal(0, 0.25, (len(JOINTS), 3))
        rel[:, 1] = np.linspace(0.75, -0.9, len(JOINTS))  # 髖部原點：頭在上、腳在下
        for j in (J["left_heel"], J["right_heel"], J["left_toe"], J["right_toe"]):
            rel[j, 1] = -0.93
        T = np.array([1.2, 0.96, 3.0])  # 最低的腳 = 0.96 - 0.93 = 0.03（地面＋鞋底）
        uv = cam.project(T + rel)
        joints, s = place_body(cam, rel, uv, np.ones(len(JOINTS)), depth_hint=8.0)
        self.assertAlmostEqual(s, 1.0, delta=0.02)
        np.testing.assert_allclose(joints, T + rel, atol=0.03)


class SmoothingTest(unittest.TestCase):
    def test_short_gaps_filled_long_gaps_kept(self):
        rng = np.random.default_rng(4)
        arr = rng.normal(size=(100, len(JOINTS), 3))
        arr[20:23] = np.nan
        arr[50:80] = np.nan
        arr[:, J["left_eye"]] = np.nan
        out = smooth_track(arr, max_gap=6, root_window=11, pose_window=7)
        hips = np.all(np.isfinite(out[:, [J["left_hip"], J["right_hip"]]]), axis=(1, 2))
        self.assertTrue(hips[20:23].all())
        self.assertFalse(hips[50:80].any())
        self.assertTrue(np.isnan(out[:, J["left_eye"]]).all())


class TrackerTest(unittest.TestCase):
    def test_identity_survives_players_crossing(self):
        yellow, black = np.zeros(len(COLOR_NAMES)), np.zeros(len(COLOR_NAMES))
        yellow[COLOR_NAMES.index("黃")] = 1
        black[COLOR_NAMES.index("黑")] = 1
        tr = PlayerTracker(fps=10)
        for f in range(40):
            x = -2 + 4 * f / 39  # 黃衣從左走到右，黑衣從右走到左，中間交錯
            dets = [Detection(np.zeros(4), np.zeros((17, 3)), 0.9, np.array([x, 6.5]), yellow),
                    Detection(np.zeros(4), np.zeros((17, 3)), 0.9, np.array([-x, 6.8]), black)]
            out = tr.assign(f, dets[::-1] if f % 2 else dets)
            self.assertIs(out[0].color, yellow)
            self.assertIs(out[1].color, black)
        self.assertEqual(tr.names()[:2], ["近場·黃衣", "近場·黑衣"])


if __name__ == "__main__":
    unittest.main()
