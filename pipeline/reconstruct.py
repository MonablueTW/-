"""影片 → 3D 重建資料（網頁 viewer 讀的 JSON）＋ 網頁用的影片檔。支援網球與匹克球。

用法：
  python reconstruct.py 你的影片.mp4 --calib calib.json --out ../web/data/rally1.json --start 12 --end 40

需要先用 calibrate.py 做相機校正。CPU 也能跑但比較慢（每秒影片約 20–60 秒），有 NVIDIA 顯卡會快很多。
"""
from __future__ import annotations

import argparse
import json
import pickle
import shutil
import subprocess
import sys
import time
import warnings
from pathlib import Path

import cv2
import numpy as np
from scipy.signal import savgol_filter

from ball import BallDetector, reconstruct_ball, remove_people
from court import SPORTS, Camera, CourtViewCheck, get_sport
from lifting import JOINTS, J, MediaPipeLifter, lift_bone_lengths, lift_mediapipe
from players import PlayerTracker, PoseDetector

PLAYER_COLORS = ["#f2cc0f", "#fc8445", "#43ccf2", "#a288fc"]
WRIST = [J["left_wrist"], J["right_wrist"]]


def find_ffmpeg() -> str | None:
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return shutil.which("ffmpeg")


class VideoWriter:
    """把處理過的每一格直接餵給 ffmpeg，輸出瀏覽器都能播的 H.264 MP4（和資料逐格對齊）。"""

    def __init__(self, path: str, width: int, height: int, fps: float, max_width: int = 1280):
        ffmpeg = find_ffmpeg()
        if not ffmpeg:
            raise SystemExit("找不到 ffmpeg：pip install imageio-ffmpeg，或用 --no-video 略過影片輸出")
        scale = []
        if width > max_width:
            scale = ["-vf", f"scale={max_width}:-2"]
        self.proc = subprocess.Popen(
            [ffmpeg, "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{width}x{height}",
             "-r", f"{fps:.6f}", "-i", "-", *scale, "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
             "-pix_fmt", "yuv420p", "-movflags", "+faststart", path],
            stdin=subprocess.PIPE,
        )

    def write(self, frame: np.ndarray):
        self.proc.stdin.write(frame.tobytes())

    def close(self):
        self.proc.stdin.close()
        self.proc.wait()


def smooth_track(arr: np.ndarray, max_gap: int, root_window: int, pose_window: int) -> np.ndarray:
    """arr: (F, J, 3)，缺資料的格是 NaN。補小空洞，再把位置（髖部中心）和姿勢分開平滑。"""
    F = len(arr)
    valid = np.all(np.isfinite(arr[:, [J["left_hip"], J["right_hip"]]]), axis=(1, 2))
    out = arr.copy()
    # 1) 短暫消失（≤ max_gap 格）用線性內插補起來
    idx = np.flatnonzero(valid)
    for a, b in zip(idx[:-1], idx[1:]):
        if 1 < b - a <= max_gap + 1:
            w = (np.arange(a + 1, b) - a) / (b - a)
            out[a + 1:b] = out[a] * (1 - w[:, None, None]) + out[b] * w[:, None, None]
            valid[a + 1:b] = True
    # 2) 分段平滑（每一段連續有資料的區間各自處理）
    runs, start = [], None
    for f in range(F + 1):
        if f < F and valid[f]:
            start = f if start is None else start
        elif start is not None:
            runs.append((start, f))
            start = None
    for a, b in runs:
        seg = out[a:b]
        root = np.nanmean(seg[:, [J["left_hip"], J["right_hip"]]], axis=1)  # (n, 3)
        rel = seg - root[:, None, :]
        n = b - a
        if n >= 5:
            w = min(root_window, n - (1 - n % 2))
            if w >= 5:
                root = savgol_filter(root, w, 2, axis=0)
            w = min(pose_window, n - (1 - n % 2))
            if w >= 5:
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore", RuntimeWarning)  # 整段都缺的關節
                    med = np.nanmedian(rel, axis=0, keepdims=True)
                filled = np.nan_to_num(np.where(np.isfinite(rel), rel, med))  # 整段都缺的關節先填 0，最後會再遮掉
                sm = savgol_filter(filled, w, 2, axis=0)
                rel = np.where(np.isfinite(rel), sm, np.nan)
        out[a:b] = root[:, None, :] + rel
    out[~valid] = np.nan
    return out


def detect_all(args, cap, cam: Camera, sport, per_side: int, fps: float, W: int, H: int, first: int, last: int,
               video_path: Path) -> dict:
    """逐格跑偵測與 3D 推算（最花時間的部分）。"""
    detector = PoseDetector(cam, sport, args.model, args.imgsz, device=args.device, far_zoom=not args.no_far_zoom)
    if detector.far_roi:
        x0, y0, x1, y1 = (int(v) for v in detector.far_roi)
        print(f"遠半場放大偵測：範圍 ({x0},{y0})–({x1},{y1})，輸入尺寸 {detector.roi_imgsz}")
    tracker = PlayerTracker(fps / args.stride, per_side)
    view_check = CourtViewCheck(cam, sport)
    lifter = None
    if args.mediapipe != "off":
        try:
            lifter = MediaPipeLifter(args.mediapipe)
        except Exception as e:  # 缺系統函式庫（例如 libEGL）時退回骨長法
            print(f"⚠ MediaPipe 無法啟動（{e}），改用骨長法", file=sys.stderr)
    hsv = [int(x) for x in args.ball_hsv.split(",")]
    ball = None if args.no_ball else BallDetector(cam, hsv[:3], hsv[3:])
    writer = None if args.no_video else VideoWriter(str(video_path), W, H, fps, args.max_width)

    n_players = 2 * per_side
    n_out = (last - first) // args.stride + 1
    poses = np.full((n_players, n_out, len(JOINTS), 3), np.nan)
    conf = np.zeros((n_players, n_out))
    methods = np.zeros((n_players, n_out), np.int8)  # 1 = MediaPipe, 2 = 骨長法
    other_view: set[int] = set()  # 不是校正機位的影格（重播、特寫…）
    ball_cands: dict[int, list] = {}
    anchors: dict[int, list] = {}  # 影格 → [(手腕 2D, 球員編號, 資料格, 框高)]，給球的軌跡當參考
    person_boxes: dict[int, list] = {}  # 影格 → 所有人的框（去除球的誤判用）
    t_start = time.time()

    for f in range(first, last + 1):
        ok, frame = cap.read()
        if not ok:
            last = f - 1
            break
        if writer:
            writer.write(frame)
        k = f - first
        on_court = view_check(frame) >= 0.18
        if not on_court:
            other_view.add(f)
        if k % args.stride == 0 and on_court:
            i = k // args.stride
            dets = detector(frame)
            person_boxes[f] = [d.box.tolist() for d in dets]
            assigned = tracker.assign(i, dets)
            for p, d in enumerate(assigned):
                if d is None:
                    continue
                facing = np.array([0.0, 0.0, -1.0 if p < per_side else 1.0])
                joints, method = None, 0
                if lifter:
                    res = lifter.detect(frame, d.box, d.kpts)
                    if res is not None:
                        joints, method = lift_mediapipe(cam, res), 1
                if joints is None:
                    joints, method = lift_bone_lengths(cam, d.kpts, d.box, facing), 2
                poses[p, i] = joints
                conf[p, i] = d.conf
                methods[p, i] = method
                anchors.setdefault(f, []).append((d.kpts[[9, 10], :2], p, i, d.box[3] - d.box[1]))
        if ball:
            r = ball.push(f, frame)
            if r and r[1] and r[0] not in other_view:
                ball_cands[r[0]] = r[1]
        if (k + 1) % 30 == 0:
            el = time.time() - t_start
            eta = el / (k + 1) * (last - f)
            print(f"  {k + 1}/{last - first + 1} 格，已用 {el:.0f}s，預估還要 {eta:.0f}s", flush=True)
    if writer:
        writer.close()
    if lifter:
        lifter.close()
    n_out = (last - first) // args.stride + 1
    if other_view:
        print(f"跳過 {len(other_view)} 格不是校正機位的畫面（重播、特寫或攝影機移動）")
    return {
        "first": first,
        "last": last,
        "sport": sport.id,
        "other_view": sorted(other_view),
        "poses": poses[:, :n_out],
        "conf": conf[:, :n_out],
        "methods": methods[:, :n_out],
        "ball_cands": ball_cands,
        "person_boxes": person_boxes,
        "anchors": anchors,
        "names": tracker.names(),
        "colors": tracker.display_colors(PLAYER_COLORS),
        "mediapipe": args.mediapipe if lifter else "off",
    }


def main():
    ap = argparse.ArgumentParser(description="網球／匹克球影片 → 3D 重建 JSON")
    ap.add_argument("video")
    ap.add_argument("--calib", required=True, help="calibrate.py 產生的 calib.json")
    ap.add_argument("--sport", choices=list(SPORTS), default=None, help="球種（預設讀 calib.json）")
    ap.add_argument("--players-per-side", type=int, choices=[1, 2], default=None,
                    help="每邊幾個人：網球單打 1、雙打 2（預設依球種）")
    ap.add_argument("--out", required=True, help="輸出的 JSON，例如 ../web/data/rally1.json")
    ap.add_argument("--start", type=float, default=0, help="從第幾秒開始")
    ap.add_argument("--end", type=float, default=None, help="到第幾秒結束（預設到影片結尾）")
    ap.add_argument("--stride", type=int, default=1, help="每幾格處理一次（2 = 速度加倍、資料變 15fps）")
    ap.add_argument("--model", default="yolo11m-pose.pt", help="YOLO pose 模型（CPU 可用 yolo11s-pose.pt）")
    ap.add_argument("--imgsz", type=int, default=960)
    ap.add_argument("--device", default=None, help="例如 cuda:0、mps、cpu")
    ap.add_argument("--mediapipe", default="full", choices=["lite", "full", "heavy", "off"],
                    help="3D 姿勢模型；off = 只用骨長法")
    ap.add_argument("--no-far-zoom", action="store_true", help="不要放大遠半場再偵測一次")
    ap.add_argument("--no-ball", action="store_true")
    ap.add_argument("--ball-hsv", default="20,70,110,50,255,255", help="球的顏色範圍 HSV（低 H,S,V,高 H,S,V）")
    ap.add_argument("--no-video", action="store_true", help="不要輸出網頁用的影片")
    ap.add_argument("--max-width", type=int, default=1280, help="網頁影片的最大寬度")
    ap.add_argument("--title", default=None)
    ap.add_argument("--reuse", action="store_true", help="沿用上次的偵測結果（只重跑平滑、球、輸出）")
    args = ap.parse_args()

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        raise SystemExit(f"打不開影片：{args.video}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    W, H = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    cam = Camera.load(args.calib)
    with open(args.calib, encoding="utf-8") as fh:
        sport = get_sport(args.sport or json.load(fh).get("sport", "pickleball"))
    per_side = args.players_per_side or sport.players_per_side
    if (cam.width, cam.height) != (W, H):
        if abs(cam.width / cam.height - W / H) > 0.01:
            raise SystemExit(f"校正時的畫面比例 {cam.width}x{cam.height} 和影片 {W}x{H} 不同")
        cam = cam.scaled(W, H)

    first = int(round(args.start * fps))
    last = min(total - 1, int(round(args.end * fps)) if args.end is not None else total - 1)
    if last <= first:
        raise SystemExit("時間範圍是空的")
    cap.set(cv2.CAP_PROP_POS_FRAMES, first)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    video_path = out_path.with_suffix(".mp4")

    print(f"{sport.name}（每邊 {per_side} 人）｜影片 {W}x{H} @ {fps:.2f}fps，處理第 {first}–{last} 格（{(last - first + 1) / fps:.1f} 秒）")
    # 偵測是最花時間的步驟，結果存成快取；只想調整後處理（例如球的參數）時加 --reuse 就不用重跑
    cache_path = Path(args.video).with_name(f"{Path(args.video).stem}.{first}-{last}.s{args.stride}.pk3d.pkl")
    if args.reuse and cache_path.exists():
        with open(cache_path, "rb") as fh:
            raw = pickle.load(fh)
        print(f"使用快取 {cache_path}")
    else:
        raw = detect_all(args, cap, cam, sport, per_side, fps, W, H, first, last, video_path)
        with open(cache_path, "wb") as fh:
            pickle.dump(raw, fh)
    cap.release()

    first, last = raw["first"], raw["last"]
    poses, conf, methods = raw["poses"], raw["conf"], raw["methods"]
    n_out = poses.shape[1]
    fps_out = fps / args.stride
    n_players = poses.shape[0]
    for p in range(n_players):
        poses[p] = smooth_track(poses[p], max_gap=int(0.4 * fps_out), root_window=int(fps_out * 0.5) | 1,
                                pose_window=max(5, int(fps_out * 0.2) | 1))

    ball_frames: list = [None] * n_out
    if not args.no_ball and raw["ball_cands"]:
        wrist_anchor = {}
        for f, items in raw["anchors"].items():
            wrist_anchor[f] = [(uv, poses[p, i][WRIST], h) for uv, p, i, h in items]
        cands = remove_people(raw["ball_cands"], raw.get("person_boxes", {}))
        pos = reconstruct_ball(cam, cands, fps, first, last, sport, wrist_anchor)
        for f, x in pos.items():
            k = f - first
            if k % args.stride == 0 and 0 <= k // args.stride < n_out:
                ball_frames[k // args.stride] = [round(float(v), 3) for v in x]
    if not args.no_ball:
        print(f"球：{sum(b is not None for b in ball_frames)}/{n_out} 格有 3D 位置")

    names, colors = raw["names"], raw["colors"]
    has_video = not args.no_video and video_path.exists()
    if not args.no_video and not has_video:
        print(f"⚠ 找不到 {video_path}（--reuse 不會重新輸出影片），這份資料先不附影片", file=sys.stderr)
    players = []
    for p in range(n_players):
        frames = [None if not np.all(np.isfinite(poses[p, i, [J['left_hip'], J['right_hip']]]))
                  else [None if not np.isfinite(v) else round(float(v), 3) for v in poses[p, i].ravel()]
                  for i in range(n_out)]
        players.append({
            "id": f"p{p + 1}",
            "name": names[p],
            "color": colors[p],
            "side": "near" if p < n_players // 2 else "far",
            "frames": frames,
            "conf": [round(float(c), 2) for c in conf[p]],
        })
        ok = sum(fr is not None for fr in frames)
        mp_share = (methods[p] == 1).sum() / max(1, (methods[p] > 0).sum())
        print(f"{names[p]}：{ok}/{n_out} 格（MediaPipe {mp_share:.0%}）")

    data = {
        "format": "pickleball-3d",
        "version": 1,
        "sport": sport.id,
        "title": args.title or Path(args.video).stem,
        "fps": fps_out,
        "frameCount": n_out,
        "joints": JOINTS,
        "players": players,
        "ball": {"frames": ball_frames},
        "camera": cam.to_json(),
        "video": {"src": video_path.name, "offset": 0} if has_video else None,
        "meta": {
            "source": Path(args.video).name,
            "range": [first / fps, last / fps],
            "model": args.model,
            "mediapipe": raw.get("mediapipe", "off"),
        },
    }
    out_path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"已輸出 {out_path}（{out_path.stat().st_size / 1e6:.1f} MB）" + (f" 與 {video_path}" if has_video else ""))

    # 如果輸出在網站的 data/ 資料夾，順便加進 index.json，網頁的下拉選單就會出現
    index = out_path.parent / "index.json"
    if index.exists():
        try:
            entries = json.loads(index.read_text(encoding="utf-8"))
            entries = [e for e in entries if e.get("src") != out_path.name]
            entries.insert(0, {"title": data["title"], "src": out_path.name})
            index.write_text(json.dumps(entries, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            print(f"已加入 {index}")
        except Exception as e:
            print(f"⚠ 無法更新 {index}：{e}", file=sys.stderr)


if __name__ == "__main__":
    main()
