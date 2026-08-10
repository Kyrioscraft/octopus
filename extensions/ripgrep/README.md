# @octopus/extension-ripgrep

Bundled-ripgrep `grep_search` tool for the Octopus agent. A high-priority
content-search tool that returns matching lines WITH line numbers and optional
context in a single call, so the model usually does NOT need a follow-up
`read_file`.

## Why

Octopus's SDK `grep` only returns a single bare matching line (ripgrep `-F`
literal mode), with no regex and no context. This forces a
`grep → read_file → grep → read_file` chain when exploring a codebase,
inflating tool-call counts.

This extension ships a real ripgrep binary and exposes its full power:
regex, `-A`/`-B`/`-C` context, `-n` line numbers, `--glob` filtering — all in
one tool call.

## Usage (from the server)

```ts
import { createRipgrepTool } from "@octopus/extension-ripgrep";

const compiled = await makeGraph(config, {
  cwd: agentCwd,
  // ... other options
  externalTools: [createRipgrepTool(agentCwd)],
});
```

The server injects the tool via core's `externalTools` option (see
`packages/core/src/agent.ts`).

## Build

```bash
pnpm --filter @octopus/extension-ripgrep build
```

The build fetches the ripgrep binary for the current platform into
`dist/binaries/<platform>-<arch>/rg[.exe]`, then compiles TypeScript.

- **Windows** copies from `D:\software\ripgrep-15.1.0\rg.exe` if present
  (overridable by editing `scripts/fetch-ripgrep.cjs`), else downloads.
- **Linux / macOS** download from GitHub releases.

For cross-platform packaging, set `OCTOPUS_RIPGREP_PLATFORMS`:

```bash
OCTOPUS_RIPGREP_PLATFORMS=linux-x64,darwin-arm64 pnpm --filter @octopus/extension-ripgrep build
```

## Layout

```
extensions/ripgrep/
├── src/
│   ├── index.ts        ← createRipgrepTool(cwd) — the grep_search tool
│   └── ripgrep.ts      ← binary resolver + spawnSync wrapper
├── scripts/
│   └── fetch-ripgrep.cjs  ← build-time binary fetcher
└── dist/               ← (built) tsc output + bundled binaries/
```
