import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const reactPath = require.resolve("react");
const inkPath = require.resolve("ink");
console.log("react:", reactPath);
console.log("ink:", inkPath);
console.log("react resolved from ink's location:", require.resolve("react", { paths: [inkPath] }));
// Does ink depend on react-reconciler / scheduler separately?
const inkPkg = JSON.parse(require("node:fs").readFileSync(
  require.resolve("ink/package.json"), "utf8"));
console.log("ink deps:", JSON.stringify(inkPkg.dependencies));
console.log("ink peerDeps:", JSON.stringify(inkPkg.peerDependencies));
