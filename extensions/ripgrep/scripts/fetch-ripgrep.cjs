/**
 * Build-time ripgrep binary fetcher.
 *
 * Run before tsc (see package.json "build" script). Ensures the bundled
 * ripgrep binary exists at dist/binaries/<platform>-<arch>/rg[.exe].
 *
 * Source priority per platform:
 *   win32-x64 → copy from local D:\software\ripgrep-15.1.0\rg.exe if present,
 *               otherwise download from GitHub releases.
 *   linux/darwin → download from GitHub releases.
 *
 * Multi-platform builds: set OCTOPUS_RIPGREP_PLATFORMS=linux-x64,darwin-arm64
 * to fetch additional platforms in one run (for packaging).
 *
 * Windows zip extraction uses the built-in `tar -xf` (Windows 10+ ships tar
 * with zip support), so no npm dependency is needed. tar.gz uses `tar -xzf`.
 * Download uses `curl` (available on all target platforms).
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

const RG_VERSION = "15.1.0";
const LOCAL_WIN_RG = "D:\\software\\ripgrep-15.1.0\\rg.exe";
const DIST_BINARIES = path.join(__dirname, "..", "dist", "binaries");

const PLATFORM_ASSETS = {
  "win32-x64": {
    url: `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/ripgrep-${RG_VERSION}-x86_64-pc-windows-msvc.zip`,
    exe: "rg.exe",
    local: LOCAL_WIN_RG,
  },
  "linux-x64": {
    url: `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/ripgrep-${RG_VERSION}-x86_64-unknown-linux-musl.tar.gz`,
    exe: "rg",
  },
  "linux-arm64": {
    url: `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/ripgrep-${RG_VERSION}-aarch64-unknown-linux-gnu.tar.gz`,
    exe: "rg",
  },
  "darwin-arm64": {
    url: `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/ripgrep-${RG_VERSION}-aarch64-apple-darwin.tar.gz`,
    exe: "rg",
  },
  "darwin-x64": {
    url: `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/ripgrep-${RG_VERSION}-x86_64-apple-darwin.tar.gz`,
    exe: "rg",
  },
};

/**
 * Ensure the ripgrep binary for one platform is present under dist/binaries/.
 * Idempotent: skips if already present.
 */
function ensurePlatform(platKey) {
  const cfg = PLATFORM_ASSETS[platKey];
  if (!cfg) {
    console.log(`[ripgrep] no asset config for ${platKey}, skipping`);
    return;
  }
  const destDir = path.join(DIST_BINARIES, platKey);
  const destExe = path.join(destDir, cfg.exe);
  if (fs.existsSync(destExe)) {
    console.log(`[ripgrep] ${platKey} already present at ${destExe}`);
    return;
  }

  fs.mkdirSync(destDir, { recursive: true });

  // Windows: prefer local copy (faster, offline-friendly).
  if (cfg.local && fs.existsSync(cfg.local)) {
    fs.copyFileSync(cfg.local, destExe);
    console.log(`[ripgrep] copied local ${platKey} from ${cfg.local}`);
    return;
  }

  // Download + extract from GitHub releases.
  const tmp = path.join(os.tmpdir(), `rg-${platKey}-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  try {
    console.log(`[ripgrep] downloading ${platKey} from ${cfg.url}`);
    if (cfg.url.endsWith(".tar.gz")) {
      // curl + tar with --strip-components=1 (the archive has a top-level dir).
      execSync(`curl -sL "${cfg.url}" | tar -xzf - -C "${tmp}" --strip-components=1`, {
        stdio: "inherit",
      });
      const extracted = path.join(tmp, cfg.exe);
      if (fs.existsSync(extracted)) {
        fs.copyFileSync(extracted, destExe);
      } else {
        throw new Error(`expected ${cfg.exe} not found after extract in ${tmp}`);
      }
    } else {
      // zip (Windows). Windows 10+ tar supports zip extraction.
      const zipPath = path.join(tmp, "rg.zip");
      execSync(`curl -sL "${cfg.url}" -o "${zipPath}"`, { stdio: "inherit" });
      execSync(`tar -xf "${zipPath}" -C "${tmp}"`, { stdio: "inherit" });
      // Find the exe recursively (archive layout: ripgrep-xxx/rg.exe).
      const found = execSync(`find "${tmp}" -name "${cfg.exe}"`, {
        encoding: "utf-8",
      })
        .trim()
        .split("\n")[0];
      if (!found || !fs.existsSync(found)) {
        throw new Error(`${cfg.exe} not found after extracting zip in ${tmp}`);
      }
      fs.copyFileSync(found, destExe);
    }
    console.log(`[ripgrep] fetched ${platKey} → ${destExe}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Always ensure the current build host platform.
const currentPlatform = `${process.platform}-${process.arch}`;
ensurePlatform(currentPlatform);

// Allow fetching additional platforms for cross-platform packaging.
const extra = process.env.OCTOPUS_RIPGREP_PLATFORMS;
if (extra) {
  for (const p of extra.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (p !== currentPlatform) ensurePlatform(p);
  }
}
