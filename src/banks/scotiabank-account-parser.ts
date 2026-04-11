import type { BankMovement } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { deduplicateMovements, normalizeDate, parseChileanAmount } from "../utils.js";

export interface RawScotiabankAccountMovement {
  date: string;
  description: string;
  amount: string;
  balance: string;
  city?: string;
}

export interface ScotiabankAccountPageState {
  hasDetailTitle: boolean;
  hasLastMovementsLabel: boolean;
  hasHistoricalButton: boolean;
  hasSaldosTab: boolean;
  hasFullAccountTable: boolean;
  fullTableHeaders: string[];
  rawMovements: RawScotiabankAccountMovement[];
}

export function readScotiabankAccountPageState(
  root: Document | ShadowRoot = document,
): ScotiabankAccountPageState {
  const normalizeText = (value: string): string =>
    value
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim();

  const getNodeText = (node: Element | ShadowRoot | null): string => {
    if (!node) return "";
    const maybeInnerText = "innerText" in node ? String(node.innerText ?? "") : "";
    return (maybeInnerText || node.textContent || "").replace(/\s+/g, " ").trim();
  };

  const allDeep = (currentRoot: Document | ShadowRoot, selector: string): Element[] => {
    const matches = Array.from(currentRoot.querySelectorAll(selector));
    for (const element of Array.from(currentRoot.querySelectorAll("*"))) {
      const shadowRoot = (element as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
      if (shadowRoot) {
        matches.push(...allDeep(shadowRoot, selector));
      }
    }
    return matches;
  };

  const rootNode =
    "documentElement" in root && root.documentElement ? root.documentElement : root;
  const pageText = normalizeText(getNodeText(rootNode));
  const interactiveNodes = allDeep(
    root,
    "[data-testid], a, button, [role='tab'], [role='button'], li, span, h1, h2, h3, p",
  );

  const hasDetailTitle = pageText.includes("detalle de tu cuenta");
  const hasLastMovementsLabel = pageText.includes("ultimos movimientos al:");
  const hasHistoricalButton =
    allDeep(root, '[data-testid="cartolas-historicas"]').length > 0 ||
    interactiveNodes.some((node) =>
      normalizeText(getNodeText(node)).includes("ver movimientos anteriores"),
    );
  const hasSaldosTab = interactiveNodes.some(
    (node) => normalizeText(getNodeText(node)) === "saldos y ultimos movimientos",
  );

  let bestHeaders: string[] = [];
  let bestRawMovements: RawScotiabankAccountMovement[] = [];

  for (const table of allDeep(root, "table")) {
    const rows = Array.from(table.querySelectorAll("tr"));
    if (rows.length < 2) continue;

    const headerRow = rows.find((row) => row.querySelectorAll("th").length >= 4);
    if (!headerRow) continue;

    const headers = Array.from(headerRow.querySelectorAll("th")).map((header) =>
      getNodeText(header),
    );
    const normalizedHeaders = headers.map((header) => normalizeText(header));

    const dateIndex = normalizedHeaders.findIndex((header) => header.includes("fecha"));
    const descriptionIndex = normalizedHeaders.findIndex(
      (header) =>
        header.includes("descripcion") ||
        header.includes("detalle") ||
        header.includes("glosa"),
    );
    const cityIndex = normalizedHeaders.findIndex((header) => header.includes("ciudad"));
    const amountIndex = normalizedHeaders.findIndex(
      (header) => header === "monto" || header.includes("importe"),
    );
    const balanceIndex = normalizedHeaders.findIndex((header) => header.includes("saldo"));

    if (dateIndex < 0 || descriptionIndex < 0 || amountIndex < 0 || balanceIndex < 0) {
      continue;
    }

    const bodyRows = Array.from(table.querySelectorAll("tbody tr"));
    const candidateRows = bodyRows.length > 0 ? bodyRows : rows;
    const rawMovements: RawScotiabankAccountMovement[] = [];
    let lastDate = "";

    for (const row of candidateRows) {
      const cells = Array.from(row.querySelectorAll("td"));
      if (cells.length === 0) continue;

      const values = cells.map((cell) => getNodeText(cell));
      const highestRequiredIndex = Math.max(
        dateIndex,
        descriptionIndex,
        cityIndex,
        amountIndex,
        balanceIndex,
      );
      if (values.length <= highestRequiredIndex) continue;

      const rawDate = values[dateIndex] || "";
      const hasDate = /^\d{1,2}[\/.\-]\d{1,2}([\/.\-]\d{2,4})?$/.test(rawDate);
      const date = hasDate ? rawDate : lastDate;
      if (!date) continue;
      if (hasDate) lastDate = rawDate;

      const description = values[descriptionIndex] || "";
      const amount = values[amountIndex] || "";
      const balance = values[balanceIndex] || "";
      if (!description || !amount || !balance) continue;

      rawMovements.push({
        date,
        description,
        amount,
        balance,
        city: cityIndex >= 0 ? values[cityIndex] || "" : "",
      });
    }

    if (rawMovements.length > bestRawMovements.length) {
      bestHeaders = headers;
      bestRawMovements = rawMovements;
    }
  }

  return {
    hasDetailTitle,
    hasLastMovementsLabel,
    hasHistoricalButton,
    hasSaldosTab,
    hasFullAccountTable: bestHeaders.length > 0,
    fullTableHeaders: bestHeaders,
    rawMovements: bestRawMovements,
  };
}

export function isScotiabankFullAccountPage(
  state: ScotiabankAccountPageState,
): boolean {
  return (
    state.hasDetailTitle &&
    state.hasLastMovementsLabel &&
    state.hasHistoricalButton &&
    state.hasFullAccountTable &&
    state.rawMovements.length > 0
  );
}

export function parseScotiabankAccountMovements(
  rawMovements: RawScotiabankAccountMovement[],
): BankMovement[] {
  const parsed = rawMovements
    .map((movement) => {
      const amount = parseChileanAmount(movement.amount);
      if (amount === 0) return null;

      return {
        date: normalizeDate(movement.date),
        description: movement.description.trim(),
        amount,
        balance: parseChileanAmount(movement.balance),
        source: MOVEMENT_SOURCE.account,
      } satisfies BankMovement;
    })
    .filter((movement): movement is BankMovement => movement !== null);

  return deduplicateMovements(parsed);
}
