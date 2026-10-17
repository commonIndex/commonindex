#!/usr/bin/env node
/**
 * Render a video composition to MP4 or WebM.
 *
 *   node render.mjs --input index.html --output video.mp4 --format mp4 [--chrome PATH] [--fps 30] [--no-sandbox]
 *
 * A composition is HTML: a root `[data-composition-id]` with data-width,
 * data-height and data-duration (seconds), and clips with data-start and
 * data-duration whose CSS animations are timed from the clip's start. This
 * steps it exactly the way the editor's preview does
 * (web/src/components/VideoPreview.tsx): each clip is visible only inside its
 * window, and every animation is paused and set to the time since its clip
 * began. One screenshot per frame, piped to ffmpeg.
 *
 * Nothing reaches the network: the browser context is offline, every request
 * is refused, and the page carries the preview's Content-Security-Policy.
 */
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright-core'

const POLICY = "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'"

function args(argv) {
  const out = { fps: 30, format: 'mp4', sandbox: true }
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    if (k === '--no-sandbox') out.sandbox = false
    else if (k.startsWith('--')) out[k.slice(2)] = argv[++i]
  }
  out.fps = Number(out.fps) || 30
  return out
}

function fail(message) {
  process.stderr.write(`render: ${message}\n`)
  process.exit(1)
}

/** The composition with the preview's policy and frame, ready to load. */
function documentFor(html, width, height) {
  const head = `<meta http-equiv="Content-Security-Policy" content="${POLICY}">`
    + `<style>html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:#fff}</style>`
  return /<head[^>]*>/i.test(html)
    ? html.replace(/<head[^>]*>/i, m => m + head)
    : `<!doctype html><html><head>${head}</head><body>${html}</body></html>`
}

/** The preview's seek, in the page. Kept to the same rules line for line. */
function seek(t) {
  const root = document.querySelector('[data-composition-id]')
  const total = Number(root.getAttribute('data-duration')) || 0
  const sample = t >= total ? Math.max(0, total - 0.001) : Math.max(0, t)
  for (const c of root.querySelectorAll('[data-start][data-duration]')) {
    const s = Number(c.getAttribute('data-start')) || 0, d = Number(c.getAttribute('data-duration')) || 0
    c.style.visibility = sample >= s && sample < s + d && !c.hasAttribute('data-hidden') ? '' : 'hidden'
  }
  for (const a of document.getAnimations()) {
    const target = a.effect && a.effect.target
    const clip = target && target.closest && target.closest('[data-start][data-duration]')
    const start = clip ? Number(clip.getAttribute('data-start')) || 0 : 0
    a.pause(); a.currentTime = Math.max(0, (sample - start) * 1000)
  }
}

function encoder(output, format, fps) {
  const codec = format === 'webm'
    ? ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '32', '-row-mt', '1', '-deadline', 'good']
    : ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-movflags', '+faststart']
  // JPEG frames are full-range; players expect video in the standard (TV)
  // range, so convert rather than tag the file yuvj420p.
  return spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(fps), '-i', '-',
    ...codec, '-vf', 'scale=in_range=pc:out_range=tv,format=yuv420p', '-color_range', 'tv', '-an', output],
  { stdio: ['pipe', 'inherit', 'inherit'] })
}

const write = (stream, chunk) => new Promise((resolve, reject) => {
  stream.write(chunk, err => (err ? reject(err) : resolve()))
})

async function main() {
  const a = args(process.argv.slice(2))
  if (!a.input || !a.output) throw new Error('give --input and --output')
  if (!['mp4', 'webm'].includes(a.format)) throw new Error('--format is mp4 or webm')
  const html = await readFile(a.input, 'utf8')

  const width = Number(/data-width=["']?(\d+)/i.exec(html)?.[1]) || 1920
  const height = Number(/data-height=["']?(\d+)/i.exec(html)?.[1]) || 1080
  const browser = await chromium.launch({ executablePath: a.chrome || undefined, chromiumSandbox: a.sandbox })
  let ffmpeg
  try {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, offline: true,
      javaScriptEnabled: true, serviceWorkers: 'block' })
    await context.route('**/*', route => route.abort())
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', e => errors.push(e.message))
    await page.setContent(documentFor(html, width, height), { waitUntil: 'load' })
    await page.evaluate(() => document.fonts.ready)

    const total = await page.evaluate(() => {
      const root = document.querySelector('[data-composition-id]')
      return root ? Number(root.getAttribute('data-duration')) || 0 : -1
    })
    if (total < 0) throw new Error('no composition root: add data-composition-id to the root element')
    if (!(total > 0)) throw new Error('set a positive data-duration on the composition root')
    if (errors.length) throw new Error(`the composition's script failed: ${errors[0]}`)

    const frames = Math.max(1, Math.round(total * a.fps))
    ffmpeg = encoder(a.output, a.format, a.fps)
    const done = new Promise((resolve, reject) => {
      ffmpeg.on('error', reject)
      ffmpeg.on('close', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`))))
    })
    for (let i = 0; i < frames; i++) {
      await page.evaluate(seek, i / a.fps)
      await write(ffmpeg.stdin, await page.screenshot({ type: 'jpeg', quality: 95, caret: 'hide' }))
    }
    ffmpeg.stdin.end()
    await done
    if (errors.length) throw new Error(`the composition's script failed while rendering: ${errors[0]}`)
  } catch (e) {
    if (ffmpeg && !ffmpeg.killed) ffmpeg.kill('SIGKILL')
    throw e
  } finally {
    await browser.close()
  }
}

main().catch(e => fail(e.message || String(e)))
