// 重新產生網站的示範影片（web/demo/<球種>.mp4、.webm）。只有修改示範劇本（web/js/demo*.js）之後才需要跑。
// 需要：Node 18+、playwright（npm i -g playwright && npx playwright install chromium）、ffmpeg
//   node tools/render-demo-video.mjs            （網球和匹克球都重畫）
//   node tools/render-demo-video.mjs tennis     （只畫一種）
// 可用環境變數 FFMPEG 指定 ffmpeg 路徑。
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile, mkdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
let playwright;
for (const name of ['playwright', 'playwright-core']) {
  try { playwright = require(name); break; } catch { /* 試下一個 */ }
}
if (!playwright) {
  try {
    const globalRoot = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' }).stdout.trim();
    playwright = require(join(globalRoot, 'playwright'));
  } catch {
    console.error('找不到 playwright：請先 npm i -g playwright && npx playwright install chromium');
    process.exit(1);
  }
}

const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
const server = createServer(async (req, res) => {
  try {
    const path = join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!path.startsWith(root)) throw new Error('outside root');
    const body = await readFile(path);
    res.writeHead(200, { 'Content-Type': types[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const port = server.address().port;

const sports = process.argv[2] ? [process.argv[2]] : ['tennis', 'pickleball'];
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
const browser = await playwright.chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
await mkdir(join(root, 'web/demo'), { recursive: true });
for (const sport of sports) {
  const frames = join(tmpdir(), `pk3d-demo-frames-${sport}`);
  await rm(frames, { recursive: true, force: true });
  await mkdir(frames, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => console.error('[page]', e.message));
  await page.goto(`http://127.0.0.1:${port}/tools/demo-footage/index.html?sport=${sport}`);
  await page.waitForFunction(() => window.ready === true, null, { timeout: 60000 });
  const n = await page.evaluate(() => window.frameCount);
  for (let f = 0; f < n; f++) {
    await page.evaluate((i) => window.renderFrame(i), f);
    await page.screenshot({ path: join(frames, `f${String(f).padStart(5, '0')}.png`), clip: { x: 0, y: 0, width: 1280, height: 720 } });
    if (f % 50 === 0) console.log(`${sport} 畫面 ${f}/${n}`);
  }
  await page.close();
  const input = ['-y', '-loglevel', 'error', '-framerate', '30', '-i', join(frames, 'f%05d.png')];
  for (const [ext, codec] of [
    ['mp4', ['-c:v', 'libx264', '-preset', 'slow', '-crf', '27', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']],
    ['webm', ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '38', '-row-mt', '1', '-pix_fmt', 'yuv420p']],
  ]) {
    const out = join(root, 'web/demo', `${sport}.${ext}`);
    const r = spawnSync(ffmpeg, [...input, ...codec, out], { stdio: 'inherit' });
    if (r.status !== 0) {
      console.error(`ffmpeg 失敗（${sport}.${ext}）`);
      process.exit(1);
    }
    console.log(`已輸出 web/demo/${sport}.${ext}`);
  }
  await rm(frames, { recursive: true, force: true });
}
await browser.close();
server.close();
