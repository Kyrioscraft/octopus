import { render, Text, useApp } from "ink";
import { createElement } from "react";

function Probe() {
  const { exit } = useApp();
  setTimeout(exit, 50);
  return createElement(Text, { color: "green" }, "ok");
}

try {
  const inst = render(createElement(Probe));
  await inst.waitUntilExit();
  console.log("REPRO_OK");
} catch (e) {
  console.error("REPRO_FAIL:", e.message);
  console.error(e.stack);
}
