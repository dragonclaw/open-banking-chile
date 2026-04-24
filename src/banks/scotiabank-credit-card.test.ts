import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  isScotiabankCreditCardPage,
  parseScotiabankCreditCardMovements,
  readScotiabankCreditCardPageState,
} from "./scotiabank.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../../..");
const FIXTURES_DIR = path.join(
  REPO_ROOT,
  "docs",
  "feature-17-integracion-bancaria-local-chile",
);
const MOCK_CARD_LABEL = "Mastercard Sandbox **** 4242";
const MOCK_CARD_LABEL_SPACED = "Mastercard Sandbox * * * * 4242";
const MOCK_BILLED_DESCRIPTIONS = [
  "COMPRA MOCK TELECOM",
  "PAGO MOCK EFECTIVO",
  "SUSCRIPCION MOCK APP",
  "CARGO MOCK MENSUAL",
  "INTERES MOCK NORMAL",
];
const MOCK_UNBILLED_DESCRIPTIONS = [
  "COMPRA MOCK LIBRERIA",
  "COMPRA MOCK FARMACIA",
  "COMPRA MOCK CAFETERIA",
  "COMPRA MOCK DIGITAL",
  "PAGO MOCK PROTECCION",
];
const MOCK_LOCATIONS = ["CIUDAD MOCK", "", "COMUNA MOCK", "", ""];

type MockMovementKind = "billed" | "unbilled";

function readFixture(name: string): string {
  return readFileSync(path.join(FIXTURES_DIR, name), "utf8");
}

function parseFixture(name: string) {
  const dom = new JSDOM(readFixture(name));
  mockCreditCardFixture(dom.window.document);
  return readScotiabankCreditCardPageState(dom.window.document);
}

function parseHtml(html: string) {
  const dom = new JSDOM(html);
  return readScotiabankCreditCardPageState(dom.window.document);
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function mockCreditCardFixture(document: Document): void {
  mockCardLabels(document);
  mockMovementTables(document);
}

function mockCardLabels(document: Document): void {
  const cardLabelPattern =
    /^(?:visa|mastercard|master card|american express|amex|diners)[^|]{0,80}(?:\*\s*){2,}\d{2,4}$/i;

  for (const node of Array.from(
    document.querySelectorAll("label, span, p, div"),
  )) {
    const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
    if (cardLabelPattern.test(text)) {
      node.textContent = MOCK_CARD_LABEL;
    }
  }
}

function mockMovementTables(document: Document): void {
  for (const table of Array.from(document.querySelectorAll("table"))) {
    const kind = getMovementKind(table);
    if (!kind) continue;

    const headers = Array.from(table.querySelectorAll("th")).map((header) =>
      normalizeText(header.textContent ?? ""),
    );
    const dateIndex = headers.findIndex((header) => header.includes("fecha"));
    const descriptionIndex = headers.findIndex((header) =>
      header.includes("descripcion"),
    );
    const locationIndex = headers.findIndex(
      (header) => header.includes("ciudad") || header.includes("pais"),
    );
    const amountIndex = headers.findIndex((header) => header === "monto");
    if (dateIndex < 0 || descriptionIndex < 0 || amountIndex < 0) continue;

    let movementIndex = 0;
    for (const row of Array.from(table.querySelectorAll("tbody tr"))) {
      const cells = Array.from(row.querySelectorAll("td"));
      if (cells.length <= Math.max(dateIndex, descriptionIndex, amountIndex))
        continue;

      const date = cells[dateIndex]?.textContent?.trim() ?? "";
      if (!/^\d{1,2}[\/.\-]\d{1,2}([\/.\-]\d{2,4})?$/.test(date)) continue;

      const descriptions =
        kind === "billed"
          ? MOCK_BILLED_DESCRIPTIONS
          : MOCK_UNBILLED_DESCRIPTIONS;
      cells[descriptionIndex].textContent =
        descriptions[movementIndex % descriptions.length];
      cells[amountIndex].textContent = "$ 12.345";
      if (locationIndex >= 0 && cells[locationIndex]) {
        cells[locationIndex].textContent =
          MOCK_LOCATIONS[movementIndex % MOCK_LOCATIONS.length];
      }
      movementIndex += 1;
    }
  }
}

function getMovementKind(table: Element): MockMovementKind | null {
  let current = table.parentElement;

  for (let depth = 0; current && depth < 8; depth += 1) {
    const text = normalizeText(current.textContent ?? "");
    if (text.includes("ver mas movimientos por facturar")) return "unbilled";
    if (text.includes("ver mas movimientos facturados")) return "billed";
    current = current.parentElement;
  }

  return null;
}

describe("readScotiabankCreditCardPageState", () => {
  it("detects the Scotiabank credit card detail page and card label", () => {
    const state = parseFixture("scotiabank-movimientos_facturados.html");

    expect(state.hasDetailTitle).toBe(true);
    expect(state.hasCreditCardLabel).toBe(true);
    expect(state.hasBilledTab).toBe(true);
    expect(state.hasUnbilledTab).toBe(true);
    expect(state.cardLabel).toBe(MOCK_CARD_LABEL);
    expect(isScotiabankCreditCardPage(state)).toBe(true);
  });

  it("extracts billed movements without duplicated print tables", () => {
    const state = parseFixture("scotiabank-movimientos_facturados.html");

    expect(state.billedMovements).toHaveLength(5);
    expect(state.unbilledMovements).toHaveLength(0);
    expect(
      state.billedMovements.map((movement) => movement.description),
    ).toEqual(
      expect.arrayContaining(["COMPRA MOCK TELECOM", "PAGO MOCK EFECTIVO"]),
    );
  });

  it("extracts unbilled movements from the active tab without mixing billed rows", () => {
    const state = parseFixture("scotiabank-movimientos_por_facturar.html");

    expect(state.billedMovements).toHaveLength(5);
    expect(state.unbilledMovements).toHaveLength(5);
    expect(
      state.unbilledMovements.map((movement) => movement.description),
    ).toEqual(
      expect.arrayContaining(["COMPRA MOCK LIBRERIA", "COMPRA MOCK FARMACIA"]),
    );
  });

  it("extracts billed movements from a plain Scotiabank movement table", () => {
    const state = parseHtml(`
      <span>${MOCK_CARD_LABEL_SPACED}</span>
      <div>
        <button class="button button--tab tab__action tab__action--active">Nacionales</button>
        <table class="table">
          <thead class="table__header">
            <tr class="table__row">
              <th class="table__header-item"><span>FECHA</span></th>
              <th class="table__header-item"><span>DESCRIPCIÓN</span></th>
              <th class="table__header-item"><span>CIUDAD</span></th>
              <th class="table__header-item"><span>MONTO</span></th>
              <th class="table__header-item"><span></span></th>
            </tr>
          </thead>
          <tbody>
            <tr class="table__row">
              <td class="table__data"><span>12/03/2026</span></td>
              <td class="table__data"><span>COMPRA MOCK TELECOM</span></td>
              <td class="table__data"><span>CIUDAD MOCK</span></td>
              <td class="table__data"><span>$16.980</span></td>
              <td class="table__data"><span></span></td>
            </tr>
            <tr class="table__row">
              <td class="table__data"><span>12/03/2026</span></td>
              <td class="table__data"><span>PAGO MOCK EFECTIVO</span></td>
              <td class="table__data"><span></span></td>
              <td class="table__data"><span>$-15.427</span></td>
              <td class="table__data"><span></span></td>
            </tr>
          </tbody>
        </table>
        <div class="TableStore_paging-store__1k76M">
          <button><span>Ver más Movimientos facturados</span></button>
        </div>
      </div>
    `);

    expect(state.cardLabel).toBe(MOCK_CARD_LABEL_SPACED);
    expect(state.billedMovements).toHaveLength(2);
    expect(state.billedMovements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          amount: "$16.980",
          date: "12/03/2026",
          description: "COMPRA MOCK TELECOM",
          location: "CIUDAD MOCK",
        }),
        expect.objectContaining({
          amount: "$-15.427",
          date: "12/03/2026",
          description: "PAGO MOCK EFECTIVO",
        }),
      ]),
    );
  });
});

describe("parseScotiabankCreditCardMovements", () => {
  it("normalizes billed movement source, date, card label, and amount sign", () => {
    const movements = parseScotiabankCreditCardMovements(
      parseFixture("scotiabank-movimientos_facturados.html"),
    );

    expect(movements).toHaveLength(5);
    expect(
      movements.every((movement) => movement.source === "credit_card_billed"),
    ).toBe(true);
    expect(movements.every((movement) => movement.date === "01-04-2026")).toBe(
      true,
    );
    expect(movements.every((movement) => movement.balance === 0)).toBe(true);
    expect(
      movements.every((movement) => movement.card === MOCK_CARD_LABEL),
    ).toBe(true);

    expect(
      movements.find(
        (movement) => movement.description === "PAGO MOCK EFECTIVO",
      )?.amount,
    ).toBeGreaterThan(0);
    expect(
      movements.find(
        (movement) => movement.description === "COMPRA MOCK TELECOM",
      )?.amount,
    ).toBeLessThan(0);
  });

  it("normalizes unbilled movement source and treats regular purchases as expenses", () => {
    const movements = parseScotiabankCreditCardMovements(
      parseFixture("scotiabank-movimientos_por_facturar.html"),
    );

    const unbilledMovements = movements.filter(
      (movement) => movement.source === "credit_card_unbilled",
    );

    expect(unbilledMovements).toHaveLength(5);
    expect(
      unbilledMovements.find(
        (movement) => movement.description === "COMPRA MOCK LIBRERIA",
      )?.amount,
    ).toBeLessThan(0);
    expect(
      unbilledMovements.find(
        (movement) => movement.description === "COMPRA MOCK FARMACIA",
      )?.amount,
    ).toBeLessThan(0);
  });
});
