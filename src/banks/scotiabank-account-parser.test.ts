import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  isScotiabankFullAccountPage,
  parseScotiabankAccountMovements,
  readScotiabankAccountPageState,
} from "./scotiabank-account-parser.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../../..");
const FIXTURES_DIR = path.join(
  REPO_ROOT,
  "docs",
  "feature-17-integracion-bancaria-local-chile",
);

function readFixture(name: string): string {
  return readFileSync(path.join(FIXTURES_DIR, name), "utf8");
}

function parseFixture(name: string) {
  const dom = new JSDOM(readFixture(name));
  return readScotiabankAccountPageState(dom.window.document);
}

describe("readScotiabankAccountPageState", () => {
  it("does not treat the dashboard widget as the full cuenta corriente page", () => {
    const state = parseFixture("scotiabank-dashboard.html");

    expect(state.hasDetailTitle).toBe(false);
    expect(state.hasHistoricalButton).toBe(false);
    expect(isScotiabankFullAccountPage(state)).toBe(false);
    expect(state.rawMovements).toHaveLength(0);
  });

  it("extracts the full cuenta corriente table from the validated account page", () => {
    const state = parseFixture("scotiabank-cuenta-corriente.html");

    expect(state.hasDetailTitle).toBe(true);
    expect(state.hasLastMovementsLabel).toBe(true);
    expect(state.hasHistoricalButton).toBe(true);
    expect(state.hasSaldosTab).toBe(true);
    expect(state.fullTableHeaders).toEqual(
      expect.arrayContaining(["Fecha", "Descripción", "Monto", "Saldo"]),
    );
    expect(isScotiabankFullAccountPage(state)).toBe(true);
    expect(state.rawMovements.length).toBeGreaterThan(50);
  });

  it("normalizes extracted account rows into account-sourced movements", () => {
    const state = parseFixture("scotiabank-cuenta-corriente.html");
    const movements = parseScotiabankAccountMovements(state.rawMovements);

    expect(movements.length).toBeGreaterThan(10);
    expect(movements.every((movement) => movement.source === "account")).toBe(true);
    expect(movements.every((movement) => Number.isFinite(movement.amount))).toBe(true);
    expect(movements.some((movement) => movement.balance !== 0)).toBe(true);
  });
});
