#!/usr/bin/env node
// Adds a ready-to-click "YNAB Clone" launcher to the user's Desktop, so the
// app can be started (and pinned to the Dock / taskbar / app menu) without a
// terminal. Called automatically by `npm run setup` / first `npm start`, and
// on demand via `npm run icon` (also use it to refresh after moving the repo).
//
//   node scripts/desktop-icon.mjs             # create on the Desktop
//   node scripts/desktop-icon.mjs --out DIR   # create elsewhere (tests)
//
// Zero dependencies: the icon is generated with a small built-in PNG encoder
// (zlib + manual chunks), then converted per platform —
//   macOS:  "YNAB Clone.app" bundle (icns via sips + iconutil, png fallback);
//           double-click runs start.command in Terminal (backup + servers +
//           browser), and the .app can be dragged into the Dock or /Applications.
//   Windows: "YNAB Clone.lnk" (via PowerShell) → start-windows.cmd,
//           iconified with assets/icon.ico (PNG-embedded; pin to taskbar).
//   Linux:  "ynab-clone.desktop" on the Desktop + in ~/.local/share/applications.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, chmodSync, rmSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import zlib from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const argv = process.argv.slice(2)
const outIdx = argv.indexOf('--out')
const outDir = outIdx >= 0 ? argv[outIdx + 1] : null

// ---------------------------------------------------------------- PNG writer

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length)
  return out
}

function encodePNG(size, rgba) {
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ------------------------------------------------------------- icon painting

// Coverage via signed distance + 1.5px feather, supersampled 2×2.
const SS = 2

function sdRoundRect(px, py, x0, y0, x1, y1, r) {
  const cx = Math.max(x0 + r, Math.min(px, x1 - r))
  const cy = Math.max(y0 + r, Math.min(py, y1 - r))
  return Math.hypot(px - cx, py - cy) - r
}

const sdCircle = (px, py, cx, cy, r) => Math.hypot(px - cx, py - cy) - r

function paint(rgba, size, shape, color, alpha = 1) {
  const feather = 1.5
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let cov = 0
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS
          const py = y + (sy + 0.5) / SS
          const d = shape(px, py)
          cov += Math.max(0, Math.min(1, 0.5 - d / feather)) / (SS * SS)
        }
      if (cov === 0) continue
      const i = (y * size + x) * 4
      const [r, g, b] = color
      const a = cov * alpha
      rgba[i] = Math.round(r * a + rgba[i] * (1 - a))
      rgba[i + 1] = Math.round(g * a + rgba[i + 1] * (1 - a))
      rgba[i + 2] = Math.round(b * a + rgba[i + 2] * (1 - a))
      rgba[i + 3] = Math.min(255, rgba[i + 3] + Math.round(255 * a))
    }
  }
}

function lerp(a, b, t) {
  return a + (b - a) * t
}

// The design: emerald rounded square, white ledger card, three bars (a
// budget), and a coin at the top-right corner.
function renderIcon(size) {
  const s = size / 1024
  const rgba = Buffer.alloc(size * size * 4)
  // background gradient (top → bottom) masked to a rounded square
  const top = [52, 211, 153]
  const bot = [5, 150, 105]
  const feather = 1.5
  for (let y = 0; y < size; y++) {
    const t = y / size
    const r = lerp(top[0], bot[0], t)
    const g = lerp(top[1], bot[1], t)
    const b = lerp(top[2], bot[2], t)
    for (let x = 0; x < size; x++) {
      const d = sdRoundRect(x + 0.5, y + 0.5, 64 * s, 64 * s, 960 * s, 960 * s, 224 * s)
      const c = Math.max(0, Math.min(1, 0.5 - d / feather))
      const i = (y * size + x) * 4
      rgba[i] = Math.round(r * c)
      rgba[i + 1] = Math.round(g * c)
      rgba[i + 2] = Math.round(b * c)
      rgba[i + 3] = Math.round(255 * c)
    }
  }
  const R = (x0, y0, x1, y1, r) => (px, py) => sdRoundRect(px, py, x0 * s, y0 * s, x1 * s, y1 * s, r * s)
  const C = (cx, cy, rr) => (px, py) => sdCircle(px, py, cx * s, cy * s, rr * s)
  // white ledger card
  paint(rgba, size, R(212, 252, 812, 772, 56), [255, 255, 255], 0.96)
  // three budget bars (decreasing width)
  paint(rgba, size, R(296, 356, 728, 424, 34), [16, 185, 129])
  paint(rgba, size, R(296, 488, 640, 556, 34), [16, 185, 129])
  paint(rgba, size, R(296, 620, 552, 688, 34), [16, 185, 129])
  // coin at the card's top-right corner
  paint(rgba, size, C(792, 300, 108), [4, 120, 87])
  paint(rgba, size, C(792, 300, 82), [110, 231, 183])
  return rgba
}

function png(size) {
  return encodePNG(size, renderIcon(size))
}

function writeIco(buf256, file) {
  const head = Buffer.alloc(6 + 16)
  head.writeUInt16LE(0, 0)
  head.writeUInt16LE(1, 2) // icon
  head.writeUInt16LE(1, 4) // 1 image
  head[6] = 0 // 256 → 0
  head[7] = 0
  head[10] = 1 // planes
  head.writeUInt16LE(32, 12) // bpp
  head.writeUInt32LE(buf256.length, 14)
  head.writeUInt32LE(22, 18) // data offset
  writeFileSync(file, Buffer.concat([head, buf256]))
}

// ------------------------------------------------------------- per-platform

// Icons live in assets/ (committed — the piggy-bank art, matching the
// Budget.app launcher). The built-in painter is only a fallback for the
// unlikely case a fresh checkout lost them: png/ico are regenerated then,
// and macOS falls back to building the icns from the png via sips/iconutil.
let assets = null
function ensureAssets() {
  if (assets) return assets
  const dir = join(root, 'assets')
  const pngFile = join(dir, 'icon.png')
  const icoFile = join(dir, 'icon.ico')
  if (!existsSync(pngFile) || !existsSync(icoFile)) {
    mkdirSync(dir, { recursive: true })
    if (!existsSync(pngFile)) writeFileSync(pngFile, png(1024))
    if (!existsSync(icoFile)) writeIco(png(256), icoFile)
  }
  assets = dir
  return dir
}

const APP_NAME = 'YNAB Clone'

function desktopPath() {
  if (outDir) {
    mkdirSync(outDir, { recursive: true })
    return outDir
  }
  if (process.platform === 'win32') {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', '[Environment]::GetFolderPath(\'Desktop\')'], { encoding: 'utf8' })
    const p = r.stdout?.trim()
    if (p) return p
  }
  if (process.platform === 'linux') {
    const r = spawnSync('xdg-user-dir', ['DESKTOP'], { encoding: 'utf8' })
    const p = r.stdout?.trim()
    if (p && existsSync(p)) return p
  }
  return join(homedir(), 'Desktop')
}

function sh(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf8' })
}

function createMacApp(dest) {
  const assetsDir = ensureAssets()
  const app = join(dest, `${APP_NAME}.app`)
  const contents = join(app, 'Contents')
  rmSync(app, { recursive: true, force: true })
  mkdirSync(join(contents, 'MacOS'), { recursive: true })
  mkdirSync(join(contents, 'Resources'), { recursive: true })

  // Preferred: the committed icns (same art as the Budget.app launcher).
  // Fallback: build one from assets/icon.png with the stock sips + iconutil,
  // and as a last resort ship the plain PNG.
  let iconFile = 'app.png'
  const icnsSrc = join(assetsDir, 'icon.icns')
  if (existsSync(icnsSrc)) {
    copyFileSync(icnsSrc, join(contents, 'Resources', 'app.icns'))
    iconFile = 'app.icns'
  } else {
    const set = join(contents, 'icon.iconset')
    mkdirSync(set, { recursive: true })
    const entries = [
      [16, 'icon_16x16.png'],
      [32, 'icon_16x16@2x.png'],
      [32, 'icon_32x32.png'],
      [64, 'icon_32x32@2x.png'],
      [128, 'icon_128x128.png'],
      [256, 'icon_128x128@2x.png'],
      [256, 'icon_256x256.png'],
      [512, 'icon_256x256@2x.png'],
      [512, 'icon_512x512.png'],
      [1024, 'icon_512x512@2x.png'],
    ]
    let ok = true
    for (const [n, name] of entries) {
      const r = sh('sips', ['-s', 'format', 'png', '-z', String(n), String(n), join(assetsDir, 'icon.png'), '--out', join(set, name)])
      if (r.status !== 0) ok = false
    }
    if (ok && sh('iconutil', ['-c', 'icns', set, '-o', join(contents, 'Resources', 'app.icns')]).status === 0) {
      iconFile = 'app.icns'
    }
    rmSync(set, { recursive: true, force: true })
  }

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key><string>${APP_NAME}</string>
  <key>CFBundleExecutable</key><string>launch</string>
  <key>CFBundleIconFile</key><string>${iconFile.replace('.png', '').replace('.icns', '')}</string>
  <key>CFBundleIdentifier</key><string>local.ynabclone.launcher</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
</dict>
</plist>
`
  writeFileSync(join(contents, 'Info.plist'), plist)
  // Reuse start.command: daily backup + servers + browser open, visible in Terminal.
  const launch = `#!/bin/sh
exec open -a Terminal "${join(root, 'start.command')}"
`
  const bin = join(contents, 'MacOS', 'launch')
  writeFileSync(bin, launch)
  chmodSync(bin, 0o755)
  copyFileSync(join(assetsDir, 'icon.png'), join(contents, 'Resources', 'app.png'))
  return app
}

function createWindowsShortcut(dest) {
  const assetsDir = ensureAssets()
  // start-windows.cmd lives at the repo root (committed).
  const target = join(root, 'start-windows.cmd')
  const ps = `
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut("${join(dest, APP_NAME + '.lnk').replace(/'/g, "''")}")
$lnk.TargetPath = "${target.replace(/'/g, "''")}"
$lnk.WorkingDirectory = "${root.replace(/'/g, "''")}"
$lnk.IconLocation = "${join(assetsDir, 'icon.ico').replace(/'/g, "''")},0"
$lnk.Description = "Start the YNAB Clone budget app"
$lnk.Save()
`
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(r.stderr?.trim() || 'PowerShell shortcut creation failed')
  return join(dest, `${APP_NAME}.lnk`)
}

function createLinuxDesktop(dest) {
  const assetsDir = ensureAssets()
  const entry = `[Desktop Entry]
Type=Application
Name=${APP_NAME}
Comment=Local budget app (YNAB-style)
Exec=/usr/bin/env bash -c 'cd "${root}" && node scripts/start-all.mjs'
Path=${root}
Icon=${join(assetsDir, 'icon.png')}
Terminal=true
Categories=Finance;Office;
`
  const files = [join(dest, 'ynab-clone.desktop')]
  writeFileSync(files[0], entry)
  const apps = join(homedir(), '.local/share/applications')
  try {
    mkdirSync(apps, { recursive: true })
    writeFileSync(join(apps, 'ynab-clone.desktop'), entry)
    files.push(join(apps, 'ynab-clone.desktop'))
  } catch {}
  return files.join(' + ')
}

// ------------------------------------------------------------------- main

export function createDesktopIcon() {
  const dest = desktopPath()
  let where
  if (process.platform === 'darwin') where = createMacApp(dest)
  else if (process.platform === 'win32') where = createWindowsShortcut(dest)
  else where = createLinuxDesktop(dest)
  return { where, dest }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) {
  try {
    const { where } = createDesktopIcon()
    console.log(`\x1b[32m✓\x1b[0m Desktop icon created: ${where}`)
    console.log('  Double-click it to start the app — drag it to your Dock / taskbar to pin it.')
    console.log('  (Recreate anytime with `npm run icon`, e.g. after moving this folder.)')
  } catch (err) {
    console.warn(`⚠ Could not create the desktop icon (${err.message}) — you can still start the app with \`npm start\`.`)
  }
}
