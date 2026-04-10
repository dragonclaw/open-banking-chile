import { readFileSync } from "fs";
import { falabella } from "../dist/index.js";

const env = Object.fromEntries(
  readFileSync(".env", "utf8").split("\n")
    .filter(l => l && !l.startsWith("#") && l.includes("="))
    .map(l => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);

const result = await falabella.scrape({
  rut: env.FALABELLA_RUT,
  password: env.FALABELLA_PASS,
  owner: env.FALABELLA_OWNER || "B",
  headful: process.argv.includes("--headful"),
  saveScreenshots: process.argv.includes("--screenshots"),
});

if (result.success) {
  const { screenshot, ...output } = result;
  console.log(JSON.stringify(output, null, 2));
} else {
  console.error("Error:", result.error);
  console.error("Debug:", result.debug);
}
