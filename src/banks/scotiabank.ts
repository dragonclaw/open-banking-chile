import type { Frame, Page } from "puppeteer-core";
import type { BankMovement, BankScraper, ScrapeResult, ScraperOptions } from "../types.js";
import { closePopups, delay, deduplicateMovements } from "../utils.js";
import { runScraper } from "../infrastructure/scraper-runner.js";
import type { BrowserSession } from "../infrastructure/browser.js";
import { fillRut, fillPassword, clickSubmit, detectLoginError } from "../actions/login.js";
import { dismissBanners } from "../actions/navigation.js";
import {
  isScotiabankFullAccountPage,
  parseScotiabankAccountMovements,
  readScotiabankAccountPageState,
  type ScotiabankAccountPageState,
} from "./scotiabank-account-parser.js";

// ─── Scotiabank-specific constants ───────────────────────────────

const BANK_URL = "https://www.scotiabank.cl";

const LOGIN_SELECTORS = {
  rutSelectors: ["#inputDni", 'input[name="inputDni"]', 'input[id*="Dni"]', 'input[name*="Dni"]'],
  passwordSelectors: ["#inputPassword", 'input[name="inputPassword"]', 'input[id*="Password"]', 'input[name*="Password"]'],
  rutFormat: "dash" as const,
};

// ─── Shadow DOM helper ───────────────────────────────────────────

function allDeepJs(): string {
  return `function allDeep(root, sel) {
    const out = Array.from(root.querySelectorAll(sel));
    for (const el of Array.from(root.querySelectorAll("*"))) {
      if (el.shadowRoot) out.push(...allDeep(el.shadowRoot, sel));
    }
    return out;
  }`;
}

// ─── Scotiabank-specific helpers ─────────────────────────────────

async function waitForDashboardContent(page: Page): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 15000) {
    const hasContent = await page.evaluate(new Function(`${allDeepJs()}
      return allDeep(document, "a, button, span").some(el => {
        const text = (el.innerText || el.textContent || "").trim().toLowerCase();
        return text === "ver saldos y últimos movimientos" || text === "ver saldos y ultimos movimientos" || text === "cuenta corriente";
      });`) as () => boolean);
    if (hasContent) break;
    await delay(1500);
  }
}

async function dismissScotiaTutorial(page: Page, debugLog: string[]): Promise<void> {
  for (let i = 0; i < 8; i++) {
    const dismissed = await page.evaluate(new Function(`${allDeepJs()}
      for (const el of allDeep(document, "button, a, span")) {
        const text = el.innerText?.trim().toLowerCase() || "";
        if (text === "continuar" || text === "terminar" || text === "cerrar" || text === "omitir" || text === "saltar") {
          el.click(); return text;
        }
      }
      return null;`) as () => string | null);
    if (!dismissed) break;
    debugLog.push(`  Tutorial dismissed: "${dismissed}"`);
    await delay(600);
  }
}

type BrowserContext = Page | Frame;

async function clickDeepText(
  ctx: BrowserContext,
  selectors: string,
  options: { exact?: string[]; includes?: string[] },
): Promise<string | null> {
  return await ctx
    .evaluate(
      ({ selectors: selectorsArg, exact, includes }) => {
        const normalizeText = (value: string): string =>
          value
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/\s+/g, " ")
            .trim();

        const getNodeText = (node: Element): string => {
          const maybeInnerText = "innerText" in node ? String(node.innerText ?? "") : "";
          return (maybeInnerText || node.textContent || "").replace(/\s+/g, " ").trim();
        };

        const allDeep = (root: Document | ShadowRoot, selector: string): Element[] => {
          const matches = Array.from(root.querySelectorAll(selector));
          for (const element of Array.from(root.querySelectorAll("*"))) {
            const shadowRoot = (element as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
            if (shadowRoot) {
              matches.push(...allDeep(shadowRoot, selector));
            }
          }
          return matches;
        };

        const exactTexts = exact.map((value) => normalizeText(value));
        const containsTexts = includes.map((value) => normalizeText(value));
        const clickSelector = "a, button, [role='tab'], [role='button'], [data-testid]";

        const getCandidateTexts = (node: Element): string[] => {
          const values = [
            getNodeText(node),
            node.getAttribute("title") || "",
            node.getAttribute("aria-label") || "",
          ]
            .map((value) => normalizeText(value))
            .filter(Boolean);

          return Array.from(new Set(values));
        };

        type Candidate = {
          clickable: Element;
          label: string;
          matchedText: string;
          isExact: boolean;
        };

        const candidates: Candidate[] = [];

        for (const node of allDeep(document, selectorsArg)) {
          const style = window.getComputedStyle(node as HTMLElement);
          if (style.display === "none" || style.visibility === "hidden") continue;

          const texts = getCandidateTexts(node);
          if (texts.length === 0) continue;

          const exactMatch = texts.find((text) => exactTexts.includes(text));
          const includesMatch = exactMatch
            ? null
            : texts.find((text) =>
                containsTexts.some(
                  (target) =>
                    text.includes(target) &&
                    text.length <= Math.max(target.length * 2, target.length + 24),
                ),
              );

          if (!exactMatch && !includesMatch) continue;

          const clickable = node.matches(clickSelector) ? node : node.closest(clickSelector) || node;
          const clickableStyle = window.getComputedStyle(clickable as HTMLElement);
          if (clickableStyle.display === "none" || clickableStyle.visibility === "hidden") continue;

          candidates.push({
            clickable,
            label: getNodeText(node) || getNodeText(clickable),
            matchedText: exactMatch || includesMatch || "",
            isExact: Boolean(exactMatch),
          });
        }

        candidates.sort((left, right) => {
          if (left.isExact !== right.isExact) return left.isExact ? -1 : 1;
          if (left.matchedText.length !== right.matchedText.length) {
            return left.matchedText.length - right.matchedText.length;
          }
          return left.label.length - right.label.length;
        });

        const selected = candidates[0];
        if (selected) {
          (selected.clickable as HTMLElement).click();
          return selected.label;
        }

        return null;
      },
      {
        selectors,
        exact: options.exact ?? [],
        includes: options.includes ?? [],
      },
    )
    .catch(() => null);
}

function getContexts(page: Page): BrowserContext[] {
  return [page, ...page.frames().filter((frame) => frame !== page.mainFrame())];
}

async function readAccountPageState(
  ctx: BrowserContext,
): Promise<ScotiabankAccountPageState | null> {
  return await ctx.evaluate(readScotiabankAccountPageState).catch(() => null);
}

async function findFullAccountContext(page: Page): Promise<{
  ctx: BrowserContext;
  state: ScotiabankAccountPageState;
  url: string;
} | null> {
  for (const ctx of getContexts(page)) {
    const state = await readAccountPageState(ctx);
    if (!state || !isScotiabankFullAccountPage(state)) continue;

    return {
      ctx,
      state,
      url: "url" in ctx ? ctx.url() : "",
    };
  }

  return null;
}

async function waitForFullAccountPage(
  page: Page,
  debugLog: string[],
  timeoutMs = 20000,
): Promise<{
  ctx: BrowserContext;
  state: ScotiabankAccountPageState;
  url: string;
}> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = await findFullAccountContext(page);
    if (found) {
      debugLog.push(
        `  Cuenta Corriente lista: ${found.state.rawMovements.length} filas (${found.url || "main"})`,
      );
      return found;
    }

    await delay(1000);
  }

  throw new Error("No se pudo abrir la página completa de Cuenta Corriente");
}

async function activateSaldosTab(page: Page, debugLog: string[]): Promise<void> {
  for (const ctx of getContexts(page)) {
    const clicked = await clickDeepText(ctx, "a, button, [role='tab'], li, span", {
      exact: ["Saldos y últimos movimientos"],
    });
    if (clicked) {
      debugLog.push(`  Tab: ${clicked}`);
      await delay(2000);
      return;
    }
  }
}

async function navigateToMovements(page: Page, debugLog: string[]): Promise<void> {
  if (await findFullAccountContext(page)) return;

  await waitForDashboardContent(page);

  const clickedCuentas = await clickDeepText(page, "a, button, li, span", {
    exact: ["Cuentas"],
  });
  if (clickedCuentas) {
    debugLog.push(`  Sidebar: ${clickedCuentas}`);
    await delay(2000);
  }

  const clickedCuentaCorriente = await clickDeepText(page, "a, button, li, span", {
    exact: ["Cuenta Corriente"],
  });
  if (clickedCuentaCorriente) {
    debugLog.push(`  Sidebar: ${clickedCuentaCorriente}`);
    await delay(2000);
  }

  const clickedSaldos = await clickDeepText(page, "a, button, li, span", {
    exact: ["Ver saldos y últimos movimientos", "Ver saldo y movimientos"],
  });
  if (clickedSaldos) {
    debugLog.push(`  Clicked: ${clickedSaldos}`);
    await delay(5000);
    await activateSaldosTab(page, debugLog);
    await waitForFullAccountPage(page, debugLog);
    return;
  }

  const clickedCartolas = await clickDeepText(page, "a, button, li, span", {
    exact: ["Ver cartolas", "Ver cartola"],
  });
  if (clickedCartolas) {
    debugLog.push(`  Fallback clicked: ${clickedCartolas}`);
    await delay(5000);
    await activateSaldosTab(page, debugLog);
    await waitForFullAccountPage(page, debugLog);
    return;
  }

  throw new Error("No se encontró el acceso a 'Ver saldos y últimos movimientos'");
}

async function extractMovements(page: Page): Promise<BankMovement[]> {
  const found = await findFullAccountContext(page);
  if (!found) {
    return [];
  }

  return parseScotiabankAccountMovements(found.state.rawMovements);
}

async function scotiaPaginate(page: Page, debugLog: string[]): Promise<BankMovement[]> {
  const all: BankMovement[] = [];
  for (let i = 0; i < 20; i++) {
    all.push(...await extractMovements(page));
    const urlBefore = page.url();
    const nextClicked = await page.evaluate(new Function(`${allDeepJs()}
      const candidates = allDeep(document, "button, a, [role='button']");
      for (const btn of candidates) {
        const text = btn.innerText?.trim().toLowerCase() || "";
        if (!text.includes("siguiente") && !text.includes("ver más") && !text.includes("mostrar más") && text !== "›" && text !== ">") continue;
        if (btn.disabled || btn.getAttribute("aria-disabled") === "true" || btn.classList.contains("disabled")) return false;
        btn.click(); return true;
      }
      return false;`) as () => boolean);
    if (!nextClicked) break;
    await delay(3000);
    const urlAfter = page.url();
    if (new URL(urlBefore).pathname.split("/").slice(0, 6).join("/") !== new URL(urlAfter).pathname.split("/").slice(0, 6).join("/")) { debugLog.push("  Pagination stopped: URL changed"); break; }
    debugLog.push(`  Pagination: page ${i + 2}`);
  }
  return deduplicateMovements(all);
}

async function navigateToPreviousPeriod(page: Page, debugLog: string[], doSave: (page: Page, name: string) => Promise<void>, stepIndex: number): Promise<boolean> {
  // Expand sidebar Cuentas
  await page.evaluate(new Function(`${allDeepJs()}
    for (const el of allDeep(document, "nav a, nav button, aside a, aside button, a, button, li, span")) {
      if (el.innerText?.trim().toLowerCase() === "cuentas") { el.click(); return true; }
    }
    return false;`) as () => boolean);
  await delay(2000);

  // Click Cartola/Movimientos submenu
  const subTargets = ["cartola", "movimientos cuenta", "cuenta corriente", "movimientos"];
  let entered = false;
  for (const target of subTargets) {
    const clicked = await page.evaluate(new Function(`${allDeepJs()}
      var t = ${JSON.stringify(target)};
      for (const el of allDeep(document, "a, button, [role='menuitem'], li, span")) {
        const text = el.innerText?.trim().toLowerCase() || "";
        if (text.includes(t) && text.length < 80) { el.click(); return true; }
      }
      return false;`) as () => boolean);
    if (clicked) { debugLog.push(`  Sidebar: ${target}`); await delay(5000); entered = true; break; }
  }
  if (!entered) return false;

  // Click "Consultar Movimientos Anteriores"
  const targets = ["movimientos anteriores", "consultar movimientos", "consultar cartolas"];
  let clicked = false;
  // Try main page
  clicked = await page.evaluate(new Function(`${allDeepJs()}
    var tgts = ${JSON.stringify(targets)};
    for (const t of tgts) {
      for (const el of allDeep(document, "a, button, span, [role='tab'], [role='link'], li")) {
        const text = el.innerText?.trim().toLowerCase() || "";
        if (text.includes(t) && text.length < 80) { el.click(); return true; }
      }
    }
    return false;`) as () => boolean);

  // Try frames
  if (!clicked) {
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      try {
        clicked = await frame.evaluate(new Function(`${allDeepJs()}
          var tgts = ${JSON.stringify(targets)};
          for (const t of tgts) {
            for (const el of allDeep(document, "a, button, span, [role='tab'], [role='link'], li")) {
              const text = el.innerText?.trim().toLowerCase() || "";
              if (text.includes(t) && text.length < 80) { el.click(); return true; }
            }
          }
          return false;`) as () => boolean);
        if (clicked) break;
      } catch { /* detached */ }
    }
  }

  if (!clicked) { debugLog.push("  No 'Consultar Movimientos Anteriores' link found"); return false; }
  debugLog.push("  Clicked: Consultar Movimientos Anteriores");
  await delay(4000);
  await doSave(page, `period-${stepIndex}-form`);
  return true;
}

async function fillAndSubmitDateRange(page: Page, startDate: string, endDate: string, debugLog: string[]): Promise<boolean> {
  const [sd, sm, sy] = startDate.split("/");
  const [ed, em, ey] = endDate.split("/");
  const frames = [page.mainFrame(), ...page.frames().filter((f) => f !== page.mainFrame())];

  for (const frame of frames) {
    try {
      const inputCount = await frame.evaluate(() =>
        Array.from(document.querySelectorAll('input[type="text"], input:not([type])')).filter(el => (el as HTMLInputElement).offsetParent !== null && !(el as HTMLInputElement).disabled).length
      ).catch(() => 0);
      if (inputCount < 4) continue;

      const filled = await frame.evaluate((vals: Record<string, string>) => {
        function setVal(el: HTMLInputElement, val: string) { el.focus(); el.value = val; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); el.blur(); }
        const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])')).filter(el => (el as HTMLInputElement).offsetParent !== null && !(el as HTMLInputElement).disabled) as HTMLInputElement[];
        let filled = 0;
        for (const inp of inputs) { const key = inp.name || inp.id; if (key && key in vals) { setVal(inp, vals[key]); filled++; } }
        if (filled === 0 && inputs.length >= 6) { const order = ["sd", "sm", "sy", "ed", "em", "ey"]; for (let i = 0; i < 6; i++) setVal(inputs[i], vals[order[i]]); return true; }
        return filled > 0;
      }, { idd: sd, imm: sm, iaa: sy, fdd: ed, fmm: em, faa: ey, sd, sm, sy, ed, em, ey });
      if (!filled) continue;

      await delay(500);
      const submitted = await frame.evaluate(() => {
        for (const el of document.querySelectorAll('button, input[type="submit"], input[type="button"], input[type="image"], a[href="#"]')) {
          const text = ((el as HTMLElement).innerText?.trim() || (el as HTMLInputElement).value || (el as HTMLInputElement).alt || "").toLowerCase();
          if (text === "aceptar" || text === "buscar" || text === "consultar" || text === "enviar") { (el as HTMLElement).click(); return true; }
        }
        for (const el of document.querySelectorAll('button, input[type="submit"], input[type="image"]')) {
          if ((el as HTMLInputElement).type === "submit" || (el as HTMLInputElement).type === "image") { (el as HTMLElement).click(); return true; }
        }
        return false;
      });
      if (submitted) { debugLog.push(`  Submitted: ${startDate} → ${endDate}`); await delay(6000); return true; }
    } catch { /* detached */ }
  }
  return false;
}

// ─── Main scrape function ────────────────────────────────────────

async function scrapeScotiabank(session: BrowserSession, options: ScraperOptions): Promise<ScrapeResult> {
  const { rut, password, saveScreenshots: doScreenshots, onProgress } = options;
  const { page, debugLog, screenshot: doSave } = session;
  const progress = onProgress || (() => {});
  const bank = "scotiabank";

  // 1. Navigate
  debugLog.push("1. Navigating to Scotiabank...");
  progress("Abriendo sitio del banco...");
  await page.goto(BANK_URL, { waitUntil: "networkidle2", timeout: 30000 });
  await delay(2000);
  await dismissBanners(page);
  await doSave(page, "01-homepage");

  // 2. Login
  debugLog.push("2. Clicking login button...");
  await page.evaluate(() => {
    for (const el of Array.from(document.querySelectorAll("a, button"))) {
      const text = (el as HTMLElement).innerText?.trim().toLowerCase() || "";
      const href = (el as HTMLAnchorElement).href || "";
      if (text === "ingresar" || text === "acceso clientes" || text.includes("iniciar sesión") || href.includes("login") || href.includes("auth")) {
        (el as HTMLElement).click(); return;
      }
    }
  });
  await delay(4000);
  await doSave(page, "02-login-form");

  debugLog.push("3. Filling RUT...");
  progress("Ingresando RUT...");
  if (!(await fillRut(page, rut, LOGIN_SELECTORS))) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, bank, accounts: [], error: "No se encontró campo de RUT", screenshot: ss as string, debug: debugLog.join("\n") };
  }
  await delay(1000);

  debugLog.push("4. Filling password...");
  let passOk = await fillPassword(page, password, LOGIN_SELECTORS);
  if (!passOk) { await page.keyboard.press("Enter"); await delay(3000); passOk = await fillPassword(page, password, LOGIN_SELECTORS); }
  if (!passOk) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, bank, accounts: [], error: "No se encontró campo de clave", screenshot: ss as string, debug: debugLog.join("\n") };
  }
  await delay(800);

  debugLog.push("5. Submitting login...");
  progress("Iniciando sesión...");
  await clickSubmit(page, page, LOGIN_SELECTORS);
  await delay(8000);
  await doSave(page, "03-after-login");

  // 2FA check
  const pageContent = (await page.content()).toLowerCase();
  if (pageContent.includes("clave dinámica") || pageContent.includes("segundo factor") || pageContent.includes("código de verificación") || pageContent.includes("token")) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, bank, accounts: [], error: "El banco pide clave dinámica o 2FA.", screenshot: ss as string, debug: debugLog.join("\n") };
  }

  const loginError = await detectLoginError(page);
  if (loginError) {
    const ss = await page.screenshot({ encoding: "base64" });
    return { success: false, bank, accounts: [], error: `Error del banco: ${loginError}`, screenshot: ss as string, debug: debugLog.join("\n") };
  }

  debugLog.push("6. Login OK!");
  progress("Sesión iniciada correctamente");
  await closePopups(page);
  await dismissScotiaTutorial(page, debugLog);

  // 7. Navigate to cartola
  debugLog.push("7. Looking for Cartola/Movimientos...");
  progress("Buscando cartola de cuenta...");
  await navigateToMovements(page, debugLog);
  await dismissScotiaTutorial(page, debugLog);

  // Wait for movements table to load (spinner to disappear)
  debugLog.push("7b. Waiting for movements to load...");
  progress("Esperando carga de movimientos...");
  const accountPage = await waitForFullAccountPage(page, debugLog);
  debugLog.push(
    `  Account page validated (${accountPage.url || "main"}): ${accountPage.state.fullTableHeaders.join(" | ")}`,
  );
  await activateSaldosTab(page, debugLog);

  await doSave(page, "04-movements-page");

  // 8. Try expanding date range
  try {
    const selectInfo = await page.evaluate(() => {
      const selects = Array.from(document.querySelectorAll("select"));
      return selects.map((sel, i) => ({
        index: i, name: sel.name || sel.id || `select-${i}`,
        options: Array.from(sel.querySelectorAll("option")).map((o) => ({ text: o.text.trim(), value: o.value })),
      }));
    });
    for (const sel of selectInfo) {
      for (const opt of sel.options) {
        const text = opt.text.toLowerCase();
        if (text.includes("todos") || text.includes("último mes") || text.includes("30 día") || text.includes("mes anterior")) {
          await page.evaluate((selIdx: number, optValue: string) => {
            const selects = document.querySelectorAll("select");
            const select = selects[selIdx] as HTMLSelectElement;
            if (select) { select.value = optValue; select.dispatchEvent(new Event("change", { bubbles: true })); }
          }, sel.index, opt.value);
          await delay(3000);
          break;
        }
      }
    }
  } catch { /* ignore */ }

  // 9. Extract current period
  const movements = await scotiaPaginate(page, debugLog);
  if (movements.length === 0) {
    throw new Error("La página de Cuenta Corriente cargó, pero no se pudieron extraer movimientos");
  }
  debugLog.push(`9. Extracted ${movements.length} movements (current period)`);
  progress(`Periodo actual: ${movements.length} movimientos`);

  // 10. Historical periods via "Consultar Cartolas" (month/year dropdowns)
  const months = Math.min(Math.max(parseInt(process.env.SCOTIABANK_MONTHS || "3", 10) || 3, 0), 12);
  if (months > 0) {
    debugLog.push(`10. Fetching ${months} historical cartola(s)...`);
    progress(`Extrayendo cartolas históricas...`);

    // Navigate to Cartolas via sidebar: Cuentas → Cuenta Corriente → Ver cartolas
    // Step 1: Click "Cuentas" in sidebar
    await page.evaluate(new Function(`${allDeepJs()}
      for (const el of allDeep(document, "nav a, nav button, aside a, aside button, a, button, li, span")) {
        const text = el.innerText?.trim().toLowerCase() || "";
        if (text === "cuentas" && text.length < 15) { el.click(); return true; }
      }
      return false;`) as () => boolean);
    debugLog.push("  Sidebar: Cuentas");
    await delay(2000);

    // Step 2: Click "Cuenta Corriente" submenu
    await page.evaluate(new Function(`${allDeepJs()}
      for (const el of allDeep(document, "a, button, li, span")) {
        const text = el.innerText?.trim().toLowerCase() || "";
        if (text === "cuenta corriente" && text.length < 25) { el.click(); return true; }
      }
      return false;`) as () => boolean);
    debugLog.push("  Sidebar: Cuenta Corriente");
    await delay(2000);

    // Step 3: Navigate to Cartolas tab — try URL param change first, then click
    const currentUrl = page.url();
    let clickedVerCartolas = false;

    // Try URL-based navigation (change tab=saldos to tab=cartolas)
    if (currentUrl.includes("tab=saldos") || currentUrl.includes("balancesmovements")) {
      const cartolasUrl = currentUrl.includes("tab=")
        ? currentUrl.replace(/tab=[^&]+/, "tab=cartolas")
        : currentUrl + (currentUrl.includes("?") ? "&" : "?") + "tab=cartolas";
      try {
        await page.goto(cartolasUrl, { waitUntil: "networkidle2", timeout: 15000 });
        clickedVerCartolas = true;
        debugLog.push("  Navigated to Cartolas tab via URL");
      } catch { /* fallback below */ }
    }

    // Fallback: click "Ver cartolas" or "Cartolas" tab
    if (!clickedVerCartolas) {
      clickedVerCartolas = await page.evaluate(new Function(`${allDeepJs()}
        for (const el of allDeep(document, "a, button, li, span")) {
          const text = el.innerText?.trim().toLowerCase() || "";
          if (text === "ver cartolas" || text.includes("ver cartola")) { el.click(); return true; }
        }
        return false;`) as () => boolean);
    }
    if (!clickedVerCartolas) {
      clickedVerCartolas = await page.evaluate(new Function(`${allDeepJs()}
        for (const el of allDeep(document, "a, button, [role='tab'], li, span")) {
          const text = el.innerText?.trim().toLowerCase() || "";
          if (text === "cartolas" && text.length < 20) { el.click(); return true; }
        }
        return false;`) as () => boolean);
    }

    if (clickedVerCartolas) {
      debugLog.push("  On Cartolas tab");
      await delay(4000);
      await dismissScotiaTutorial(page, debugLog);

      // Click "Consultar Cartolas" — check main page + all frames
      let clickedConsultar = await page.evaluate(new Function(`${allDeepJs()}
        for (const el of allDeep(document, "a, button, span")) {
          const text = el.innerText?.trim().toLowerCase() || "";
          if (text.includes("consultar cartola") && text.length < 40) { el.click(); return true; }
        }
        return false;`) as () => boolean);

      // Try frames if not found in main page
      if (!clickedConsultar) {
        for (const frame of page.frames()) {
          if (frame === page.mainFrame()) continue;
          try {
            clickedConsultar = await frame.evaluate(() => {
              for (const el of document.querySelectorAll("a, button, span, div")) {
                const text = (el as HTMLElement).innerText?.trim().toLowerCase() || "";
                if (text.includes("consultar cartola") && text.length < 40) {
                  (el as HTMLElement).click(); return true;
                }
              }
              return false;
            });
            if (clickedConsultar) { debugLog.push("  Found Consultar Cartolas in iframe"); break; }
          } catch { /* detached */ }
        }
      }

      if (clickedConsultar) {
        debugLog.push("  Clicked: Consultar Cartolas");
        await delay(5000);
        await doSave(page, "06-consultar-cartolas");

        const MONTH_NAMES = ["enero", "febrero", "marzo", "abril", "mayo", "junio",
          "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
        const now = new Date();

        for (let m = 0; m < months; m++) {
          const target = new Date(now.getFullYear(), now.getMonth() - m, 1);
          const targetMonth = target.getMonth(); // 0-based
          const targetYear = target.getFullYear();
          debugLog.push(`  Cartola: ${MONTH_NAMES[targetMonth]} ${targetYear}`);
          progress(`Cartola ${MONTH_NAMES[targetMonth]} ${targetYear}...`);

          // Try to select month/year in dropdowns (check all frames)
          const frames = [page.mainFrame(), ...page.frames().filter((f) => f !== page.mainFrame())];
          let submitted = false;

          // Debug: list frames and their select counts
          for (const frame of frames) {
            try {
              const info = await frame.evaluate(() => {
                const selects = document.querySelectorAll("select");
                const inputs = document.querySelectorAll("input");
                const buttons = document.querySelectorAll("button, input[type='submit'], input[type='button'], input[type='image']");
                return { url: window.location.href, selects: selects.length, inputs: inputs.length, buttons: buttons.length };
              });
              debugLog.push(`    Frame: ${info.url.substring(0, 80)} | selects=${info.selects} inputs=${info.inputs} buttons=${info.buttons}`);
            } catch { /* detached */ }
          }

          for (const frame of frames) {
            try {
              // Debug: dump select options
              const selectDebug = await frame.evaluate(() => {
                const selects = Array.from(document.querySelectorAll("select")) as HTMLSelectElement[];
                return selects.map((sel, i) => ({
                  index: i, name: sel.name || sel.id,
                  options: Array.from(sel.options).map(o => ({ text: o.text.trim(), value: o.value })),
                }));
              }).catch(() => []);
              if (selectDebug.length > 0) {
                if (selectDebug.length > 0) debugLog.push(`    Frame has ${selectDebug.length} selects`);
              }

              const filled = await frame.evaluate((monthIdx: number, year: number) => {
                const selects = Array.from(document.querySelectorAll("select")) as HTMLSelectElement[];
                if (selects.length < 1) return "no selects";

                // Use first two selects directly (month, year)
                const monthSelect = selects[0];
                const yearSelect = selects.length >= 2 ? selects[1] : null;
                if (!yearSelect) return "only 1 select";

                // Set month by value (01-12)
                const monthValue = String(monthIdx + 1).padStart(2, "0");
                monthSelect.value = monthValue;
                monthSelect.dispatchEvent(new Event("change", { bubbles: true }));

                // Set year
                yearSelect.value = String(year);
                yearSelect.dispatchEvent(new Event("change", { bubbles: true }));

                return "ok";
              }, targetMonth, targetYear);

              debugLog.push(`    Fill result: ${filled}`);
              if (filled !== "ok") continue;

              await delay(500);

              // Click "Aceptar" (could be button, submit, or image input)
              const accepted = await frame.evaluate(() => {
                for (const el of document.querySelectorAll('button, input[type="submit"], input[type="button"], input[type="image"], a, img')) {
                  const text = ((el as HTMLElement).innerText?.trim() || (el as HTMLInputElement).value || (el as HTMLInputElement).alt || "").toLowerCase();
                  if (text.includes("aceptar") || text === "buscar" || text === "consultar" || text === "enviar") {
                    (el as HTMLElement).click(); return text;
                  }
                }
                // Last resort: click any submit-like element
                const submit = document.querySelector('input[type="submit"], input[type="image"]') as HTMLElement;
                if (submit) { submit.click(); return "submit-fallback"; }
                return null;
              });
              debugLog.push(`    Accepted: ${accepted}`);

              if (accepted) {
                debugLog.push(`    Submitted: ${MONTH_NAMES[targetMonth]} ${targetYear}`);
                await delay(8000);

                // Wait for table to load
                const waitStart = Date.now();
                while (Date.now() - waitStart < 15000) {
                  const hasContent = await frame.evaluate(() => {
                    const tables = document.querySelectorAll("table");
                    for (const t of Array.from(tables)) { if (t.querySelectorAll("tr").length > 2) return true; }
                    return false;
                  }).catch(() => false);
                  if (hasContent) break;
                  await delay(2000);
                }

                await doSave(page, `07-cartola-${MONTH_NAMES[targetMonth]}-${targetYear}`);

                // Extract from this frame
                const periodMovements = await extractMovements(page);
                debugLog.push(`    Found: ${periodMovements.length} movements`);
                movements.push(...periodMovements);
                submitted = true;
                break;
              }
            } catch { /* detached frame */ }
          }

          if (!submitted) {
            debugLog.push(`    Could not submit cartola for ${MONTH_NAMES[targetMonth]} ${targetYear}`);
            break;
          }
        }
      } else {
        debugLog.push("  Could not click Consultar Cartolas");
      }
    } else {
      debugLog.push("  Could not navigate to Cartolas");
    }
  }

  const deduplicated = deduplicateMovements(movements);
  debugLog.push(`  Total: ${deduplicated.length} unique movements`);
  progress(`Listo — ${deduplicated.length} movimientos totales`);

  let balance: number | undefined;
  if (deduplicated.length > 0 && deduplicated[0].balance > 0) balance = deduplicated[0].balance;
  if (balance === undefined) {
    balance = await page.evaluate(() => {
      const bodyText = document.body?.innerText || "";
      const patterns = [
        /total disponible[\s\S]{0,50}\$\s*([\d.]+)/i,
        /saldo disponible[\s\S]{0,50}\$\s*([\d.]+)/i,
        /saldo actual[\s\S]{0,50}\$\s*([\d.]+)/i,
      ];
      for (const pattern of patterns) { const match = bodyText.match(pattern); if (match) return parseInt(match[1].replace(/[^0-9]/g, ""), 10); }
      return undefined;
    });
  }

  await doSave(page, "05-final");
  const ss = doScreenshots ? (await page.screenshot({ encoding: "base64", fullPage: true })) as string : undefined;

  return { success: true, bank, accounts: [{ balance: balance ?? undefined, movements: deduplicated }], screenshot: ss, debug: debugLog.join("\n") };
}

// ─── Export ──────────────────────────────────────────────────────

const scotiabank: BankScraper = {
  id: "scotiabank",
  name: "Scotiabank Chile",
  url: BANK_URL,
  scrape: (options) => runScraper("scotiabank", options, {}, scrapeScotiabank),
};

export default scotiabank;
