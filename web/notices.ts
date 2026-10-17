// Every build ships the licences of the code it bundles.
//
// The bundle carries code from the packages below (React, TipTap and their
// dependencies), and their licences — MIT, Apache-2.0, BSD — ask that their
// copyright and permission notices travel with it. This writes them, from the
// packages actually installed, to THIRD_PARTY_NOTICES.txt beside index.html.
// Only what ships: dev and build tools are left out (package-lock's `dev`).
import fs from 'node:fs'
import path from 'node:path'
import type { Plugin } from 'vite'

const LICENCE_FILE = /^(licen[cs]e|copying|notice)(\.(md|txt|markdown))?$/i

export function notices(): Plugin {
  return {
    name: 'third-party-notices',
    apply: 'build',
    generateBundle() {
      const root = process.cwd()
      const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
      const parts: string[] = [
        'Third-party notices for the CommonIndex web app.',
        'The web app bundles the following packages. Each is listed with its licence text.',
        '',
      ]
      const shipped = Object.entries<Record<string, unknown>>(lock.packages)
        .filter(([at, p]) => at.startsWith('node_modules/') && !p.dev && !p.devOptional)
        .sort(([a], [b]) => a.localeCompare(b))
      const missing: string[] = []
      for (const [at] of shipped) {
        const dir = path.join(root, at)
        if (!fs.existsSync(path.join(dir, 'package.json'))) { missing.push(at); continue }
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
        const files = fs.readdirSync(dir).filter(f => LICENCE_FILE.test(f)).sort()
        const licence = typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license ?? pkg.licenses ?? 'UNKNOWN')
        parts.push('='.repeat(78), `${pkg.name} ${pkg.version}  —  ${licence}`, pkg.repository?.url ?? pkg.homepage ?? '', '')
        if (!files.length) parts.push(`(The package includes no licence file; its declared licence is ${licence}.)`, '')
        for (const f of files) parts.push(fs.readFileSync(path.join(dir, f), 'utf8').trim(), '')
      }
      // A build without its dependencies installed cannot say what it bundles.
      if (missing.length) this.error(`third-party notices: not installed: ${missing.slice(0, 5).join(', ')} — run npm ci`)
      this.emitFile({ type: 'asset', fileName: 'THIRD_PARTY_NOTICES.txt', source: parts.join('\n') })
    },
  }
}
