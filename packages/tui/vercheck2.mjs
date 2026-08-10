import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const inkPath = require.resolve("ink");
const recPath = require.resolve("react-reconciler", { paths: [inkPath] });
const schedPath = require.resolve("scheduler", { paths: [inkPath] });
const reactPath = require.resolve("react");
console.log("react          :", reactPath);
console.log("react-reconciler:", recPath);
console.log("scheduler      :", schedPath);

// Critical: does react-reconciler's bundled react match ours?
// react-reconciler internally does `require('react')` — check it resolves to the SAME file.
const reactFromRec = require.resolve("react", { paths: [recPath] });
console.log("react from reconciler:", reactFromRec);
console.log("SAME react instance?", reactPath === reactFromRec);

// Also check what 'use-client' / dispatcher ink uses
const inkInternals = require("ink");
console.log("ink keys:", Object.keys(inkInternals).slice(0,10));
