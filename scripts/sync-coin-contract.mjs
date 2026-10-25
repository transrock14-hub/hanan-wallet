// Copies the compiled StudyToken ABI and bytecode from ../anvil-lab into the app.
// Run `forge build` in anvil-lab first.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const artifact = path.join(
  here,
  "../../anvil-lab/out/StudyToken.sol/StudyToken.json",
);
const out = path.join(here, "../src/coin-artifact.json");

const json = JSON.parse(readFileSync(artifact, "utf8"));
writeFileSync(
  out,
  JSON.stringify({ abi: json.abi, bytecode: json.bytecode.object }, null, 2) +
    "\n",
);
console.log(
  `Wrote ${path.relative(process.cwd(), out)} (${json.bytecode.object.length / 2 - 1} bytes of bytecode)`,
);
