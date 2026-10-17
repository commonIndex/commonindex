// What new artifacts start as. Kept apart from the editor so a page that only
// creates one (the Docs list's New page) does not load the editor to do it.

/** What a new artifact starts as: small, and showing what an artifact can do —
 *  style, a drawing and a script — so editing it teaches the shape. */
export const ARTIFACT_STARTER = `<div class="card">
  <h3>Counter</h3>
  <button id="add">Add one</button> <b id="n">0</b>
</div>
<style>
  .card { padding: 20px; font-family: system-ui, sans-serif; }
  button { font: inherit; padding: 6px 12px; border-radius: 8px; border: 1px solid #ccc; background: #fff; }
</style>
<script>
  let n = 0
  document.getElementById('add').onclick = () => { document.getElementById('n').textContent = ++n }
</script>`

/** What a new full page starts as: a real page's bones — a header, a hero,
 *  sections, a footer — responsive and self-contained, to edit or ask AI to
 *  rewrite. */
export const PAGE_STARTER = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>New page</title>
<style>
  * { box-sizing: border-box }
  body { margin: 0; font-family: system-ui, -apple-system, sans-serif; color: #18181b; background: #fff; line-height: 1.5 }
  header { position: sticky; top: 0; display: flex; justify-content: space-between; align-items: center;
           padding: 14px 32px; background: rgba(255,255,255,.92); border-bottom: 1px solid #e4e4e7 }
  header b { color: #4f46e5 } header a { margin-left: 20px; color: #3f3f46; text-decoration: none; font-size: 14px }
  .hero { padding: 96px 32px 72px; text-align: center; background: linear-gradient(180deg, #eef2ff, #fff) }
  .hero h1 { font-size: clamp(32px, 5vw, 52px); line-height: 1.1; margin: 0 0 14px; letter-spacing: -.02em }
  .hero p { font-size: 18px; color: #52525b; max-width: 620px; margin: 0 auto 28px }
  .cta { display: inline-block; padding: 12px 22px; border-radius: 10px; background: #4f46e5; color: #fff; font-weight: 600; border: 0; font-size: 15px; cursor: pointer }
  section { max-width: 1080px; margin: 0 auto; padding: 64px 32px }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 18px }
  .card { border: 1px solid #e4e4e7; border-radius: 14px; padding: 22px } .card h3 { margin: 0 0 6px }
  .card p { margin: 0; color: #52525b; font-size: 14px }
  footer { padding: 28px 32px; text-align: center; color: #71717a; font-size: 13px; border-top: 1px solid #e4e4e7 }
  @media (max-width: 640px) { header { padding: 12px 18px } header a { margin-left: 12px } .hero { padding: 64px 18px 48px } section { padding: 40px 18px } }
</style>
</head>
<body>
  <header><b>Your product</b><nav><a href="#features">Features</a><a href="#about">About</a></nav></header>
  <div class="hero">
    <h1>Say what it does in one line</h1>
    <p>A sentence or two on who it is for and why it matters. Edit this page, or ask AI to write it for you.</p>
    <button class="cta" id="cta">Get started</button>
  </div>
  <section id="features"><div class="grid">
    <div class="card"><h3>First feature</h3><p>What it does, in a sentence.</p></div>
    <div class="card"><h3>Second feature</h3><p>What it does, in a sentence.</p></div>
    <div class="card"><h3>Third feature</h3><p>What it does, in a sentence.</p></div>
  </div></section>
  <section id="about"><h2>About</h2><p>A short paragraph about the team or the product.</p></section>
  <footer>Made in CommonIndex</footer>
  <script>document.getElementById('cta').onclick = e => { e.target.textContent = 'Thanks!' }</script>
</body>
</html>`
