import * as fs from "fs";
import * as path from "path";
import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import type { BankMovement, BankScraper, CreditCardBalance, MovementSource, ScrapeResult, ScraperOptions } from "../types.js";
import { MOVEMENT_SOURCE } from "../types.js";
import { DebugLog, delay, deduplicateAcrossSources, deduplicateMovements, findChrome, monthYearLabel, normalizeDate, normalizeOwner, normalizeInstallments, parseChileanAmount } from "../utils.js";

// ─── Constants ───────────────────────────────────────────────────

const BANK_URL = "https://www.bancofalabella.cl";
const MAX_PAGES = 20;
const CMR_WAIT_MS = 30_000;
const HOMEPAGE_TIMEOUT_MS = 20_000;
const LOGIN_CONTROL_TIMEOUT_MS = 10_000;
const LOGIN_OUTCOME_TIMEOUT_MS = 30_000;
const LOGIN_OUTCOME_POLL_MS = 250;
const PASSWORD_STEP_PROBE_MS = 1_000;
const POST_LOGIN_RENDER_WAIT_MS = 3_000;
const POST_LOGIN_MODAL_WAIT_MS = 2_000;
const POST_LOGIN_MODAL_CLOSE_TIMEOUT_MS = 5_000;
const POST_LOGIN_MODAL_REAPPEAR_WAIT_MS = 400;
const POST_LOGIN_MODAL_MAX_CLOSE_ATTEMPTS = 4;
const FALABELLA_POINTS_MODAL_SELECTOR = ".modal-content-secretobancario-container";
const FALABELLA_POINTS_MODAL_CLOSE_SELECTOR = "button.close-misdocumentos";
const AUTHENTICATED_PATH = "/web-clientes/";
const AUTHENTICATED_ROOT_SELECTOR = "app-techbank-client-consolidated, app-root";
const LOGIN_ERROR_SELECTOR = '[class*="error"], [class*="alert"], [role="alert"]';
const RUT_INPUT_SELECTOR =
  '#document, input[name="document"], input[name*="rut" i], input[id*="rut" i], input[placeholder*="RUT" i]';
const PASSWORD_INPUT_SELECTOR =
  '#pass, input[name="pass"], input[type="password"], input[name*="clave" i], input[id*="clave" i]';
const SENSITIVE_INPUT_PATTERN =
  /<input\b[^>]*(?:type="password"|(?:id|name)="(?:document|pass)")[^>]*>/gi;
const INPUT_VALUE_PATTERN = /\svalue="[^"]*"/i;
const LOGIN_FORM_UNAVAILABLE_ERROR =
  "El banco cambió o no pudo mostrar su formulario de acceso.";
const LOGIN_FORM_REJECTED_ERROR =
  "El RUT o la clave no cumplen el formato requerido por el banco.";
const LOGIN_OUTCOME_TIMEOUT_ERROR =
  "El banco no confirmó el inicio de sesión dentro del tiempo esperado.";
const SCRAPE_CANCELLED_MESSAGE = "Sincronización cancelada por el usuario.";

interface ViewportSize {
  height: number;
  width: number;
}

interface ElementBox extends ViewportSize {
  x: number;
  y: number;
}

interface BannerCandidate {
  boundingBox: () => Promise<ElementBox | null>;
  click: () => Promise<void>;
}

interface WaitableLoginControl {
  waitFor: (options: { state: "visible"; timeout: number }) => Promise<void>;
}

interface LoginKeyboard {
  press: (key: string) => Promise<void>;
}

interface FalabellaLoginSnapshot {
  bodyText: string;
  hasAuthenticatedRoot: boolean;
  hasLoginForm: boolean;
  pathname: string;
  visibleErrors: string[];
}

type FalabellaLoginOutcome =
  | { status: "authenticated" }
  | { status: "error"; message: string }
  | { status: "timeout" }
  | { status: "two_factor" };

type FalabellaLoginResult =
  | { success: true }
  | { success: false; error: string; screenshot?: string };

class FalabellaLoginLayoutError extends Error {}

class FalabellaLoginSubmissionError extends Error {}

// ─── Browser helpers ─────────────────────────────────────────────

async function launchPlaywright(options: ScraperOptions): Promise<{ browser: Browser; page: Page; debugLog: string[] }> {
  const { chromePath, headful, onDebug } = options;
  const debugLog: string[] = onDebug ? new DebugLog(onDebug) : [];

  const execPath = findChrome(chromePath);
  if (!execPath) {
    throw new Error(
      "No se encontró Chrome/Chromium. Instala Google Chrome o pasa chromePath.\n" +
      "  Ubuntu/Debian: sudo apt install google-chrome-stable\n" +
      "  macOS: brew install --cask google-chrome",
    );
  }

  const browser = await chromium.launch({
    executablePath: execPath,
    headless: !headful,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-blink-features=AutomationControlled",
      "--disable-notifications",
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  });

  // Hide automation signals
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  const page = await context.newPage();
  return { browser, page, debugLog };
}

async function screenshotIfEnabled(page: Page, name: string, enabled: boolean, debugLog: string[]): Promise<string | undefined> {
  if (!enabled) return undefined;
  const safeName = name.replace(/[/\\:*?"<>|]/g, "_");
  const screenshotDir = path.resolve("screenshots");
  const debugDir = path.resolve("debug");
  if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });
  if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });
  await page.screenshot({ path: path.join(screenshotDir, `${safeName}.png`), fullPage: true });
  const redactedHtml = redactSensitiveInputValues(await page.content());
  await fs.promises.writeFile(path.join(debugDir, `${safeName}.html`), redactedHtml);
  debugLog.push(`  Screenshot: ${safeName}.png`);
  debugLog.push(`  HTML: debug/${safeName}.html`);
  return undefined;
}

export function redactSensitiveInputValues(html: string): string {
  return html.replace(SENSITIVE_INPUT_PATTERN, (input) =>
    input.replace(INPUT_VALUE_PATTERN, ' value="[REDACTED]"'),
  );
}

// ─── Login ───────────────────────────────────────────────────────

export function normalizeFalabellaRut(rut: string): string {
  return rut.replace(/[^0-9kK]/g, "").toUpperCase();
}

export function isElementBoxInViewport(box: ElementBox, viewport: ViewportSize): boolean {
  return (
    box.width > 0 &&
    box.height > 0 &&
    box.x < viewport.width &&
    box.y < viewport.height &&
    box.x + box.width > 0 &&
    box.y + box.height > 0
  );
}

export async function clickFirstBannerCandidateInViewport(
  candidates: readonly BannerCandidate[],
  viewport: ViewportSize,
): Promise<boolean> {
  for (const candidate of candidates) {
    const box = await candidate.boundingBox().catch(() => null);
    if (!box || !isElementBoxInViewport(box, viewport)) continue;

    const clicked = await candidate.click().then(() => true, () => false);
    if (clicked) return true;
  }

  return false;
}

export async function advanceFalabellaPasswordStepIfNeeded(
  passwordInput: WaitableLoginControl,
  keyboard: LoginKeyboard,
): Promise<boolean> {
  const alreadyVisible = await passwordInput
    .waitFor({ state: "visible", timeout: PASSWORD_STEP_PROBE_MS })
    .then(() => true, () => false);
  if (alreadyVisible) return false;

  await keyboard.press("Enter");
  await passwordInput.waitFor({ state: "visible", timeout: LOGIN_CONTROL_TIMEOUT_MS });
  return true;
}

export async function navigateToFalabellaHomepage(page: Page): Promise<void> {
  await page.goto(BANK_URL, {
    timeout: HOMEPAGE_TIMEOUT_MS,
    waitUntil: "domcontentloaded",
  });
}

export function classifyFalabellaLoginSnapshot(
  snapshot: FalabellaLoginSnapshot,
): FalabellaLoginOutcome | null {
  const normalizedBody = snapshot.bodyText.toLowerCase();
  if (
    !snapshot.hasLoginForm &&
    (normalizedBody.includes("clave dinámica") ||
      normalizedBody.includes("clave dinamica") ||
      normalizedBody.includes("segundo factor"))
  ) {
    return { status: "two_factor" };
  }

  const errorMessage = snapshot.visibleErrors.find(
    (message) => message.trim().length >= 4 && message.trim().length <= 200,
  );
  if (errorMessage) return { status: "error", message: errorMessage.trim() };

  if (snapshot.pathname.includes(AUTHENTICATED_PATH) || snapshot.hasAuthenticatedRoot) {
    return { status: "authenticated" };
  }

  return null;
}

async function login(
  page: Page,
  rut: string,
  password: string,
  debugLog: string[],
  doScreenshots: boolean,
  progress: (s: string) => void,
): Promise<FalabellaLoginResult> {
  debugLog.push("1. Navigating to bank homepage...");
  progress("Abriendo sitio del banco...");
  try {
    await navigateToFalabellaHomepage(page);
    await dismissFalabellaHomepageBanner(page, debugLog);
  } catch {
    return captureFalabellaLoginFailure(page, LOGIN_FORM_UNAVAILABLE_ERROR);
  }
  await screenshotIfEnabled(page, "01-homepage", doScreenshots, debugLog);

  debugLog.push("2. Opening 'Mi Cuenta' login form...");
  progress("Ingresando a Mi cuenta...");
  try {
    await openFalabellaLoginForm(page);
  } catch {
    return captureFalabellaLoginFailure(page, LOGIN_FORM_UNAVAILABLE_ERROR);
  }
  await screenshotIfEnabled(page, "02-login-form", doScreenshots, debugLog);

  debugLog.push("3. Filling RUT...");
  progress("Ingresando RUT...");
  try {
    await fillFalabellaLoginForm(page, rut, password, debugLog, progress);
  } catch {
    return captureFalabellaLoginFailure(page, LOGIN_FORM_UNAVAILABLE_ERROR);
  }
  await screenshotIfEnabled(page, "02-filled-login-form", doScreenshots, debugLog);

  debugLog.push("4. Submitting login...");
  progress("Iniciando sesión...");
  try {
    await submitFalabellaLoginForm(page);
  } catch (error) {
    const failureMessage =
      error instanceof FalabellaLoginSubmissionError
        ? LOGIN_FORM_REJECTED_ERROR
        : LOGIN_FORM_UNAVAILABLE_ERROR;
    return captureFalabellaLoginFailure(page, failureMessage);
  }
  await screenshotIfEnabled(page, "03-login-submitted", doScreenshots, debugLog);

  const outcome = await waitForFalabellaLoginOutcome(page);
  if (outcome.status !== "authenticated") {
    return captureFalabellaLoginFailure(page, getFalabellaLoginOutcomeError(outcome));
  }

  await delay(POST_LOGIN_RENDER_WAIT_MS);
  await screenshotIfEnabled(page, "03-after-login", doScreenshots, debugLog);
  await settleFalabellaDashboard(page, debugLog);

  const content = await page.content();
  if (content.toLowerCase().includes("clave dinámica") || content.toLowerCase().includes("segundo factor")) {
    return captureFalabellaLoginFailure(page, "El banco pide clave dinámica (2FA).");
  }

  debugLog.push("5. Login OK!");
  progress("Sesión iniciada correctamente");
  return { success: true };
}

async function dismissFalabellaHomepageBanner(
  page: Page,
  debugLog: string[],
): Promise<void> {
  const controls = page
    .locator("button, a")
    .filter({ hasText: /^(Aceptar|Entendido|Continuar)$/i });
  const viewport = page.viewportSize();
  if (!viewport) return;

  const candidates = Array.from({ length: await controls.count() }, (_, index) => {
    const control = controls.nth(index);
    return {
      boundingBox: () => control.boundingBox(),
      click: () => control.click({ timeout: 2_000 }),
    };
  });
  if (await clickFirstBannerCandidateInViewport(candidates, viewport)) {
    debugLog.push("  Dismissed homepage banner");
  }
}

async function openFalabellaLoginForm(page: Page): Promise<void> {
  const accountControl = page
    .getByRole("button", { name: /^mi cuenta$/i })
    .or(page.getByRole("link", { name: /^mi cuenta$/i }))
    .first();

  try {
    await accountControl.waitFor({ state: "visible", timeout: LOGIN_CONTROL_TIMEOUT_MS });
    await accountControl.click({ timeout: LOGIN_CONTROL_TIMEOUT_MS });
    await getFalabellaRutInput(page).waitFor({
      state: "visible",
      timeout: LOGIN_CONTROL_TIMEOUT_MS,
    });
  } catch {
    throw new FalabellaLoginLayoutError(LOGIN_FORM_UNAVAILABLE_ERROR);
  }
}

async function fillFalabellaLoginForm(
  page: Page,
  rut: string,
  password: string,
  debugLog: string[],
  progress: (step: string) => void,
): Promise<void> {
  const passwordInput = getFalabellaPasswordInput(page);

  try {
    await getFalabellaRutInput(page).fill(normalizeFalabellaRut(rut), {
      timeout: LOGIN_CONTROL_TIMEOUT_MS,
    });
    const advanced = await advanceFalabellaPasswordStepIfNeeded(
      passwordInput,
      page.keyboard,
    );
    if (advanced) debugLog.push("  Advanced to legacy password step");
    debugLog.push("  Filling password...");
    progress("Ingresando clave...");
    await passwordInput.fill(password, { timeout: LOGIN_CONTROL_TIMEOUT_MS });
  } catch {
    throw new FalabellaLoginLayoutError(LOGIN_FORM_UNAVAILABLE_ERROR);
  }
}

async function submitFalabellaLoginForm(page: Page): Promise<void> {
  const submitButton = page
    .getByRole("button", { name: /ingresar|entrar/i })
    .or(page.locator('button[type="submit"], input[type="submit"]'))
    .first();

  try {
    await submitButton.waitFor({ state: "visible", timeout: LOGIN_CONTROL_TIMEOUT_MS });
  } catch {
    throw new FalabellaLoginLayoutError(LOGIN_FORM_UNAVAILABLE_ERROR);
  }

  try {
    await submitButton.click({ timeout: LOGIN_CONTROL_TIMEOUT_MS });
  } catch {
    throw new FalabellaLoginSubmissionError(LOGIN_FORM_REJECTED_ERROR);
  }
}

function getFalabellaRutInput(page: Page): Locator {
  return page
    .locator(RUT_INPUT_SELECTOR)
    .or(page.getByRole("textbox", { name: /^RUT$/i }))
    .first();
}

function getFalabellaPasswordInput(page: Page): Locator {
  return page
    .locator(PASSWORD_INPUT_SELECTOR)
    .or(page.getByLabel(/clave|contraseña/i))
    .first();
}

async function waitForFalabellaLoginOutcome(page: Page): Promise<FalabellaLoginOutcome> {
  const deadline = Date.now() + LOGIN_OUTCOME_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const snapshot = await readFalabellaLoginSnapshot(page).catch(() => null);
    const outcome = snapshot ? classifyFalabellaLoginSnapshot(snapshot) : null;
    if (outcome) return outcome;
    await delay(LOGIN_OUTCOME_POLL_MS);
  }

  return { status: "timeout" };
}

async function readFalabellaLoginSnapshot(page: Page): Promise<FalabellaLoginSnapshot> {
  return page.evaluate(
    ({ authenticatedRootSelector, errorSelector, loginFormSelector }) => {
      const isVisible = (element: Element): boolean => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden"
        );
      };
      const visibleErrors = Array.from(document.querySelectorAll(errorSelector))
        .filter(isVisible)
        .map((element) => (element.textContent ?? "").trim())
        .filter(Boolean);

      return {
        bodyText: document.body?.innerText ?? "",
        hasAuthenticatedRoot: Boolean(document.querySelector(authenticatedRootSelector)),
        hasLoginForm: Boolean(document.querySelector(loginFormSelector)),
        pathname: window.location.pathname,
        visibleErrors,
      };
    },
    {
      authenticatedRootSelector: AUTHENTICATED_ROOT_SELECTOR,
      errorSelector: LOGIN_ERROR_SELECTOR,
      loginFormSelector: RUT_INPUT_SELECTOR,
    },
  );
}

function getFalabellaLoginOutcomeError(outcome: FalabellaLoginOutcome): string {
  if (outcome.status === "two_factor") return "El banco pide clave dinámica (2FA).";
  if (outcome.status === "error") return `Error del banco: ${outcome.message}`;
  return LOGIN_OUTCOME_TIMEOUT_ERROR;
}

async function captureFalabellaLoginFailure(
  page: Page,
  error: string,
): Promise<FalabellaLoginResult> {
  const screenshot = await page
    .screenshot()
    .then((value) => value.toString("base64"))
    .catch(() => undefined);

  return screenshot
    ? { success: false, error, screenshot }
    : { success: false, error };
}

export async function dismissFalabellaPointsModal(
  page: Page,
  debugLog: string[] = [],
  options: { waitMs?: number } = {},
): Promise<boolean> {
  const waitMs = options.waitMs ?? POST_LOGIN_MODAL_WAIT_MS;
  let dismissed = false;

  for (let attempt = 0; attempt < POST_LOGIN_MODAL_MAX_CLOSE_ATTEMPTS; attempt += 1) {
    const timeout = attempt === 0 ? waitMs : POST_LOGIN_MODAL_REAPPEAR_WAIT_MS;
    const appeared = await falabellaPointsModalIsVisible(page, timeout);
    if (!appeared) break;

    await closeFalabellaPointsModal(page);
    dismissed = true;
    debugLog.push(
      attempt === 0
        ? "  Closed CMR Puntos opt-in modal"
        : "  Closed CMR Puntos opt-in modal again",
    );
  }

  return dismissed;
}

async function falabellaPointsModalIsVisible(page: Page, waitMs: number): Promise<boolean> {
  const closeButton = page
    .locator(FALABELLA_POINTS_MODAL_SELECTOR)
    .first()
    .locator(FALABELLA_POINTS_MODAL_CLOSE_SELECTOR)
    .first();

  if (waitMs <= 0) {
    return closeButton.isVisible().catch(() => false);
  }

  return closeButton
    .waitFor({ state: "visible", timeout: waitMs })
    .then(() => true, () => false);
}

async function closeFalabellaPointsModal(page: Page): Promise<void> {
  const modal = page.locator(FALABELLA_POINTS_MODAL_SELECTOR).first();
  const closeButton = modal.locator(FALABELLA_POINTS_MODAL_CLOSE_SELECTOR).first();
  await closeButton.click({ timeout: POST_LOGIN_MODAL_CLOSE_TIMEOUT_MS });
  await modal
    .waitFor({ state: "hidden", timeout: POST_LOGIN_MODAL_CLOSE_TIMEOUT_MS })
    .catch(() => {});
}

async function dismissFalabellaGenericClosePopup(page: Page, debugLog: string[]): Promise<void> {
  const closeButton = page.getByRole("button", { name: "cerrar", exact: true });
  if (!(await closeButton.isVisible({ timeout: 500 }).catch(() => false))) return;

  await closeButton.click({ timeout: 2_000 }).catch(() => {});
  debugLog.push("  Closed generic popup");
}

async function clearFalabellaBlockingOverlays(
  page: Page,
  debugLog: string[],
  waitMs = POST_LOGIN_MODAL_WAIT_MS,
): Promise<void> {
  await dismissFalabellaPointsModal(page, debugLog, { waitMs });
  await dismissFalabellaGenericClosePopup(page, debugLog);
  if (waitMs > 0) {
    await dismissFalabellaPointsModal(page, debugLog, { waitMs: POST_LOGIN_MODAL_REAPPEAR_WAIT_MS });
  }
}

async function settleFalabellaDashboard(page: Page, debugLog: string[]): Promise<void> {
  await clearFalabellaBlockingOverlays(page, debugLog);

  const retryButton = page.getByText("Reintentar");
  if (await retryButton.isVisible().catch(() => false)) {
    await retryButton.click({ timeout: 2_000 }).catch(() => {});
    await delay(5_000);
    await clearFalabellaBlockingOverlays(page, debugLog);
  }
}

// ─── Account movements ──────────────────────────────────────────

async function scrapeAccountMovements(page: Page, debugLog: string[], doScreenshots: boolean, progress: (s: string) => void): Promise<{ movements: BankMovement[]; balance?: number }> {
  debugLog.push("7. [Cuenta] Looking for account...");
  progress("Buscando cartola de cuenta...");
  await clearFalabellaBlockingOverlays(page, debugLog, 0);

  // Try clicking on Cuenta Corriente product card
  const ccLink = page.getByRole("link", { name: /Cuenta Corriente \d/ });
  let navigated = false;

  if (await ccLink.isVisible({ timeout: 5000 }).catch(() => false)) {
    await ccLink.click();
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await delay(3000);
    await clearFalabellaBlockingOverlays(page, debugLog);
    navigated = true;
  }

  if (!navigated) {
    // Fallback: try clicking Cartola/Movimientos text links
    for (const text of ["cartola", "últimos movimientos", "movimientos", "estado de cuenta"]) {
      const link = page.locator("a, button, [role='tab']").filter({ hasText: new RegExp(text, "i") }).first();
      if (await link.isVisible({ timeout: 2000 }).catch(() => false)) {
        try {
          await clearFalabellaBlockingOverlays(page, debugLog, 0);
          await link.click();
          await delay(4000);
          await clearFalabellaBlockingOverlays(page, debugLog);
          navigated = true;
          break;
        } catch { /* try next */ }
      }
    }
  }

  if (!navigated) {
    // Try clicking any account-like element
    const acctEl = page.locator("a, div, button").filter({ hasText: /cuenta corriente|cuenta vista/i }).first();
    if (await acctEl.isVisible({ timeout: 3000 }).catch(() => false)) {
      await clearFalabellaBlockingOverlays(page, debugLog, 0);
      await acctEl.click();
      await delay(4000);
      await clearFalabellaBlockingOverlays(page, debugLog);
    }
  }

  await clearFalabellaBlockingOverlays(page, debugLog, 0);
  await screenshotIfEnabled(page, "05-account-movements", doScreenshots, debugLog);

  // Expand date range if possible
  await tryExpandDateRange(page, debugLog);

  // Extract movements via pagination
  progress("Extrayendo movimientos de cuenta...");
  const movements = await paginateAccountMovements(page, debugLog);
  debugLog.push(`8. [Cuenta] Extracted ${movements.length} movements`);
  progress(`Cuenta: ${movements.length} movimientos encontrados`);

  // Extract balance
  let balance: number | undefined;
  if (movements.length > 0 && movements[0].balance > 0) {
    balance = movements[0].balance;
  }
  if (balance === undefined) {
    const bodyText = await page.locator("body").textContent().catch(() => "");
    const match = bodyText?.match(/Saldo disponible[\s\S]{0,50}\$\s*([\d.]+)/i);
    if (match) balance = parseInt(match[1].replace(/[^0-9]/g, ""), 10);
  }

  return { movements, balance };
}

async function tryExpandDateRange(page: Page, debugLog: string[]): Promise<void> {
  try {
    await clearFalabellaBlockingOverlays(page, debugLog, 0);
    const selects = page.locator("select");
    const count = await selects.count();
    for (let i = 0; i < count; i++) {
      const sel = selects.nth(i);
      const options = await sel.locator("option").allTextContents();
      for (const text of options) {
        const lower = text.toLowerCase();
        if (lower.includes("todos") || lower.includes("último mes") || lower.includes("30 día") || lower.includes("mes anterior")) {
          await sel.selectOption({ label: text });
          debugLog.push(`  Changed select to "${text}"`);
          await delay(3000);
          await clearFalabellaBlockingOverlays(page, debugLog);
          break;
        }
      }
    }
  } catch { /* best effort */ }
}

async function extractMovementsFromPage(page: Page): Promise<BankMovement[]> {
  return page.evaluate(() => {
    const results: Array<{ date: string; description: string; amount: number; balance: number; source: string }> = [];

    const tables = Array.from(document.querySelectorAll("table"));
    for (const table of tables) {
      const rows = Array.from(table.querySelectorAll("tr"));
      if (rows.length < 2) continue;

      // Find header row to determine column indices
      let dateIdx = 0, descIdx = 1, cargoIdx = -1, abonoIdx = -1, amountIdx = -1, balanceIdx = -1;
      let hasHeader = false;

      for (const row of rows) {
        const headers = row.querySelectorAll("th");
        if (headers.length < 2) continue;
        const hTexts = Array.from(headers).map(h => (h as HTMLElement).innerText?.trim().toLowerCase() || "");
        if (!hTexts.some(h => h.includes("fecha"))) continue;
        hasHeader = true;
        dateIdx = hTexts.findIndex(h => h.includes("fecha"));
        descIdx = hTexts.findIndex(h => h.includes("descrip") || h.includes("detalle") || h.includes("glosa"));
        cargoIdx = hTexts.findIndex(h => h.includes("cargo") || h.includes("débito"));
        abonoIdx = hTexts.findIndex(h => h.includes("abono") || h.includes("crédito"));
        amountIdx = hTexts.findIndex(h => h === "monto" || h.includes("importe"));
        balanceIdx = hTexts.findIndex(h => h.includes("saldo"));
        break;
      }
      if (!hasHeader) continue;

      let lastDate = "";
      for (const row of rows) {
        const cells = row.querySelectorAll("td");
        if (cells.length < 3) continue;
        const vals = Array.from(cells).map(c => (c as HTMLElement).innerText?.trim() || "");
        const rawDate = vals[dateIdx] || "";
        const hasDate = /^\d{1,2}[\/.\-]\d{1,2}([\/.\-]\d{2,4})?$/.test(rawDate);
        const date = hasDate ? rawDate : lastDate;
        if (!date) continue;
        if (hasDate) lastDate = rawDate;

        const description = descIdx >= 0 ? (vals[descIdx] || "") : "";
        let amountStr = "";
        if (cargoIdx >= 0 && vals[cargoIdx]?.replace(/\s/g, "")) {
          amountStr = `-${vals[cargoIdx]}`;
        } else if (abonoIdx >= 0 && vals[abonoIdx]?.replace(/\s/g, "")) {
          amountStr = vals[abonoIdx];
        } else if (amountIdx >= 0) {
          amountStr = vals[amountIdx] || "";
        }
        if (!amountStr) continue;

        const balStr = balanceIdx >= 0 ? (vals[balanceIdx] || "") : "";

        // Parse amounts inline (can't call external functions inside evaluate)
        function parseCLP(text: string): number {
          const clean = text.replace(/[^0-9.,-]/g, "");
          if (!clean) return 0;
          const isNeg = clean.startsWith("-") || text.includes("-$");
          const norm = clean.replace(/-/g, "").replace(/\./g, "").replace(",", ".");
          const val = parseInt(norm, 10) || 0;
          return isNeg ? -val : val;
        }

        results.push({
          date,
          description,
          amount: parseCLP(amountStr),
          balance: parseCLP(balStr),
          source: "account",
        });
      }
    }
    return results;
  }).then(raw =>
    raw
      .filter(m => m.description || m.amount !== 0)
      .map(m => ({
        date: normalizeDate(m.date),
        description: m.description,
        amount: m.amount,
        balance: m.balance,
        source: MOVEMENT_SOURCE.account as MovementSource,
      }))
  );
}

async function paginateAccountMovements(page: Page, debugLog: string[]): Promise<BankMovement[]> {
  const all: BankMovement[] = [];

  for (let i = 0; i < MAX_PAGES; i++) {
    await dismissFalabellaPointsModal(page, debugLog, { waitMs: 0 });
    const movements = await extractMovementsFromPage(page);
    all.push(...movements);

    // Try clicking "Siguiente" or "Ver más"
    let clicked = false;
    for (const text of ["siguiente", "ver más", "mostrar más"]) {
      const btn = page.locator("button, a").filter({ hasText: new RegExp(text, "i") }).first();
      if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
        const disabled = await btn.isDisabled().catch(() => true);
        if (!disabled) {
          await dismissFalabellaPointsModal(page, debugLog, { waitMs: 0 });
          await btn.click();
          await delay(2500);
          await clearFalabellaBlockingOverlays(page, debugLog);
          clicked = true;
          debugLog.push(`  Pagination: loaded page ${i + 2}`);
          break;
        }
      }
    }
    if (!clicked) break;
  }

  return deduplicateMovements(all);
}

// ─── CMR credit card ────────────────────────────────────────────

async function scrapeCreditCard(page: Page, debugLog: string[], doScreenshots: boolean, progress: (s: string) => void, ownerFilter: string): Promise<{ movements: BankMovement[]; creditCard: CreditCardBalance }> {
  const creditCard: CreditCardBalance = { label: "CMR" };
  const allMovements: BankMovement[] = [];

  debugLog.push("9. [CMR] Looking for CMR card...");
  progress("Navegando a tarjeta de crédito...");
  await clearFalabellaBlockingOverlays(page, debugLog, 0);

  // Extract cupos from dashboard
  const cupoData = await extractCupos(page, debugLog);
  if (cupoData) Object.assign(creditCard, cupoData);

  const cardClicked = await clickCmrProductCard(page, debugLog);
  if (!cardClicked) {
    debugLog.push("  [CMR] No CMR card found on dashboard");
    return { movements: [], creditCard };
  }

  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await delay(5000);
  await clearFalabellaBlockingOverlays(page, debugLog);
  await screenshotIfEnabled(page, "06-cmr-card", doScreenshots, debugLog);

  // Wait for CMR shadow DOM to render
  await waitForCmrContent(page, CMR_WAIT_MS);
  await clearFalabellaBlockingOverlays(page, debugLog, 0);

  // Owner filter
  if (ownerFilter !== "B") {
    await page.evaluate(({ host, value }: { host: string; value: string }) => {
      const shadowEl = document.querySelector(host) as Element & { shadowRoot?: ShadowRoot };
      const root = shadowEl?.shadowRoot || document;
      const select = root.querySelector("select[name='searchownership']") as HTMLSelectElement | null;
      if (select) { select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); }
    }, { host: "credit-card-movements", value: ownerFilter });
    await waitForCmrContent(page, CMR_WAIT_MS);
    await clearFalabellaBlockingOverlays(page, debugLog, 0);
  }

  // ── No facturados (default tab) ────────────────────────────────
  debugLog.push("10. [CMR] Extracting unbilled movements...");
  progress("Extrayendo movimientos TC por facturar...");

  // Extract billing period info
  const unbilledInfo = await extractUnbilledPeriodInfo(page);
  if (unbilledInfo.nextBillingDate) creditCard.nextBillingDate = normalizeDate(unbilledInfo.nextBillingDate);
  if (unbilledInfo.nextDueDate) creditCard.nextDueDate = normalizeDate(unbilledInfo.nextDueDate);
  if (unbilledInfo.periodExpenses !== undefined) creditCard.periodExpenses = unbilledInfo.periodExpenses;

  const unbilledMovements = await paginateCmrMovements(page, MOVEMENT_SOURCE.credit_card_unbilled, debugLog);
  debugLog.push(`  Unbilled: ${unbilledMovements.length} movements`);
  allMovements.push(...unbilledMovements);

  await screenshotIfEnabled(page, "07-cmr-no-facturados", doScreenshots, debugLog);

  // ── Facturados tab ─────────────────────────────────────────────
  debugLog.push("11. [CMR] Switching to facturados tab...");
  progress("Extrayendo movimientos TC facturados...");

  await clearFalabellaBlockingOverlays(page, debugLog, 0);
  const tabClicked = await clickCmrTab(page, debugLog);
  if (tabClicked) {
    await delay(2000);
    await clearFalabellaBlockingOverlays(page, debugLog);
    await waitForCmrContent(page, CMR_WAIT_MS);
    await delay(3000);
    await clearFalabellaBlockingOverlays(page, debugLog, 0);
    await screenshotIfEnabled(page, "07-cmr-facturados", doScreenshots, debugLog);

    // Extract last statement info
    const billedInfo = await extractBilledStatementInfo(page);
    if (billedInfo.billingDate && billedInfo.billedAmount && billedInfo.dueDate) {
      creditCard.lastStatement = {
        billingDate: normalizeDate(billedInfo.billingDate),
        billedAmount: billedInfo.billedAmount,
        dueDate: normalizeDate(billedInfo.dueDate),
        minimumPayment: billedInfo.minimumPayment,
      };
      creditCard.billingPeriod = monthYearLabel(creditCard.lastStatement.billingDate);
    }

    const billedMovements = await paginateCmrMovements(page, MOVEMENT_SOURCE.credit_card_billed, debugLog);
    debugLog.push(`  Billed: ${billedMovements.length} movements`);
    allMovements.push(...billedMovements);
  }

  // Tag movements with card mask
  const cardMask = creditCard.label.match(/\*{4}\d{4}/)?.[0];
  const tagged = cardMask ? allMovements.map(m => ({ ...m, card: cardMask })) : allMovements;
  creditCard.movements = deduplicateAcrossSources(deduplicateMovements(tagged));

  return { movements: creditCard.movements, creditCard };
}

// ─── CMR Shadow DOM helpers ─────────────────────────────────────

async function clickCmrProductCard(page: Page, debugLog: string[]): Promise<boolean> {
  await waitForLocatorAttached(
    page.locator("app-credit-cards, #cardDetail0, a[id^='cardDetail']").first(),
    5000,
  );

  const candidates: Array<{ label: string; locator: Locator }> = [
    { label: "#cardDetail0", locator: page.locator("#cardDetail0").first() },
    {
      label: "a[id^='cardDetail']",
      locator: page
        .locator("a[id^='cardDetail']")
        .filter({ hasText: /CMR|Mastercard|Visa/i })
        .first(),
    },
    {
      label: "app-credit-cards a.div-product",
      locator: page
        .locator("app-credit-cards a.div-product")
        .filter({ hasText: /CMR|Mastercard|Visa/i })
        .first(),
    },
    {
      label: "role link",
      locator: page.getByRole("link", { name: /CMR|Mastercard|Visa/i }).first(),
    },
    {
      label: "text link/button",
      locator: page.locator("a, button").filter({ hasText: /CMR|Mastercard|Visa/i }).first(),
    },
  ];

  for (const candidate of candidates) {
    if (!(await isLocatorVisible(candidate.locator, 1500))) continue;
    try {
      await candidate.locator.scrollIntoViewIfNeeded();
    } catch { /* best effort */ }
    await dismissFalabellaPointsModal(page, debugLog, { waitMs: 0 });
    await candidate.locator.click({ timeout: 5000 });
    debugLog.push(`  [CMR] Clicked card via ${candidate.label}`);
    return true;
  }

  await dismissFalabellaPointsModal(page, debugLog, { waitMs: 0 });
  const clicked = await page.evaluate(() => {
    function clickElement(element: HTMLElement): void {
      element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      element.click();
      element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    }

    const cardDetail = document.querySelector<HTMLElement>("#cardDetail0");
    if (cardDetail) {
      clickElement(cardDetail);
      return "#cardDetail0";
    }

    const links = document.querySelectorAll<HTMLElement>(
      "app-credit-cards a, a[id^='cardDetail']",
    );
    for (const element of Array.from(links)) {
      const text = element.innerText || element.textContent || "";
      if (!/CMR|Mastercard|Visa/i.test(text)) continue;
      clickElement(element);
      return element.id ? `#${element.id}` : "app-credit-cards link";
    }

    return null;
  });

  if (clicked) {
    debugLog.push(`  [CMR] Clicked card via DOM fallback ${clicked}`);
    return true;
  }

  return false;
}

async function waitForLocatorAttached(locator: Locator, timeoutMs: number): Promise<void> {
  try {
    await locator.waitFor({ state: "attached", timeout: timeoutMs });
  } catch { /* optional wait */ }
}

async function isLocatorVisible(locator: Locator, timeoutMs: number): Promise<boolean> {
  try {
    return await locator.isVisible({ timeout: timeoutMs });
  } catch {
    return false;
  }
}

async function waitForCmrContent(page: Page, timeoutMs: number): Promise<void> {
  try {
    await page.waitForFunction((host: string) => {
      const el = document.querySelector(host) as Element & { shadowRoot?: ShadowRoot };
      const topRoot = el?.shadowRoot || document;
      function collectAll(root: ShadowRoot | Element | Document): Array<ShadowRoot | Element | Document> {
        const found: Array<ShadowRoot | Element | Document> = [root];
        for (const child of Array.from((root as ParentNode).querySelectorAll("*"))) {
          const sr = (child as Element & { shadowRoot?: ShadowRoot }).shadowRoot;
          if (sr) found.push(...collectAll(sr));
        }
        return found;
      }
      return collectAll(topRoot).some(
        r => (r as ParentNode).querySelectorAll("table tbody tr td").length > 0,
      );
    }, "credit-card-movements", { timeout: timeoutMs });
  } catch { /* timeout */ }
  await delay(500);
}

async function extractCupos(page: Page, debugLog: string[]): Promise<Partial<CreditCardBalance> | null> {
  try {
    const cupoData = await page.evaluate(() => {
      const text = document.body?.innerText || "";
      const labelMatch = text.match(/(CMR\s+\w+(?:\s+\w+)?)\s*\n?\s*[•·*\s]+\s*(\d{4})/i);
      const label = labelMatch ? `${labelMatch[1]} ****${labelMatch[2]}` : "";
      const cupoMatch = text.match(/\$([\d.,]+)\s*\n?\s*Cupo de compras/i);
      const usadoMatch = text.match(/\$([\d.,]+)\s*\n?\s*Cupo utilizado/i);
      const disponibleMatch = text.match(/\$([\d.,]+)\s*\n?\s*Cupo disponible/i);
      return { label, cupo: cupoMatch?.[1], usado: usadoMatch?.[1], disponible: disponibleMatch?.[1] };
    });
    if (!cupoData.cupo && !cupoData.disponible) return null;
    const total = cupoData.cupo ? parseChileanAmount(cupoData.cupo) : 0;
    const used = cupoData.usado ? parseChileanAmount(cupoData.usado) : 0;
    const available = cupoData.disponible ? parseChileanAmount(cupoData.disponible) : 0;
    debugLog.push(`  CMR cupos: total=$${total}, used=$${used}, available=$${available}`);
    return { label: cupoData.label || "CMR", national: { total, used, available } };
  } catch {
    return null;
  }
}

async function extractUnbilledPeriodInfo(page: Page): Promise<{ nextBillingDate?: string; nextDueDate?: string; periodExpenses?: number }> {
  return page.evaluate((host: string) => {
    const shadowEl = document.querySelector(host) as Element & { shadowRoot?: ShadowRoot };
    const topRoot = shadowEl?.shadowRoot || document;

    function collectAllRoots(root: ShadowRoot | Element): Array<ShadowRoot | Element> {
      const found: Array<ShadowRoot | Element> = [root];
      for (const el of Array.from((root as Element).querySelectorAll("*"))) {
        const sr = (el as Element & { shadowRoot?: ShadowRoot }).shadowRoot;
        if (sr) found.push(...collectAllRoots(sr));
      }
      return found;
    }

    function extractFromSameDiv(root: ShadowRoot | Element, label: string): string | undefined {
      for (const div of Array.from((root as Element).querySelectorAll("div"))) {
        const text = div.textContent?.trim() || "";
        if (text.toLowerCase().startsWith(label.toLowerCase())) {
          const rest = text.slice(label.length).trim();
          if (rest) return rest;
        }
      }
      return undefined;
    }

    function parseAmount(text?: string): number | undefined {
      if (!text) return undefined;
      const m = text.match(/\$([\d.,]+)/);
      if (!m) return undefined;
      return parseInt(m[1].replace(/\./g, "").replace(",", ""), 10) || undefined;
    }

    function extractDate(text?: string): string | undefined {
      if (!text) return undefined;
      const m = text.match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
      return m ? m[1] : undefined;
    }

    let billingRaw: string | undefined;
    let dueRaw: string | undefined;
    let expensesRaw: string | undefined;

    for (const root of collectAllRoots(topRoot)) {
      if (!billingRaw) billingRaw = extractFromSameDiv(root, "Próxima facturación");
      if (!dueRaw) dueRaw = extractFromSameDiv(root, "Próximo vencimiento");
      if (!expensesRaw) expensesRaw = extractFromSameDiv(root, "Gastos del periodo");
    }

    return {
      nextBillingDate: extractDate(billingRaw),
      nextDueDate: extractDate(dueRaw),
      periodExpenses: parseAmount(expensesRaw),
    };
  }, "credit-card-movements");
}

async function extractBilledStatementInfo(page: Page): Promise<{ billingDate?: string; billedAmount?: number; dueDate?: string; minimumPayment?: number }> {
  return page.evaluate((host: string) => {
    const shadowEl = document.querySelector(host) as Element & { shadowRoot?: ShadowRoot };
    const topRoot = shadowEl?.shadowRoot || document;

    function collectAllRoots(root: ShadowRoot | Element): Array<ShadowRoot | Element> {
      const found: Array<ShadowRoot | Element> = [root];
      for (const el of Array.from((root as Element).querySelectorAll("*"))) {
        const sr = (el as Element & { shadowRoot?: ShadowRoot }).shadowRoot;
        if (sr) found.push(...collectAllRoots(sr));
      }
      return found;
    }

    function findNextSiblingValue(root: ShadowRoot | Element, labelText: string): string | undefined {
      const divs = Array.from((root as Element).querySelectorAll<HTMLElement>("div"));
      for (let i = 0; i < divs.length - 1; i++) {
        if ((divs[i].textContent?.trim() || "").toLowerCase() === labelText.toLowerCase()) {
          const val = divs[i + 1]?.textContent?.trim() || "";
          if (val) return val;
        }
      }
      return undefined;
    }

    function parseAmount(text?: string): number | undefined {
      if (!text) return undefined;
      const m = text.match(/\$([\d.,]+)/);
      if (!m) return undefined;
      return parseInt(m[1].replace(/\./g, "").replace(",", ""), 10) || undefined;
    }

    function extractDate(text?: string): string | undefined {
      if (!text) return undefined;
      const m = text.match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
      return m ? m[1] : undefined;
    }

    let billingDate: string | undefined;
    let billedAmount: number | undefined;
    let dueDate: string | undefined;
    let minimumPayment: number | undefined;

    for (const root of collectAllRoots(topRoot)) {
      if (!billingDate) billingDate = extractDate(findNextSiblingValue(root, "Fecha de facturación"));
      if (!billedAmount) billedAmount = parseAmount(findNextSiblingValue(root, "Monto facturado"));
      if (!dueDate) dueDate = extractDate(findNextSiblingValue(root, "Fecha de vencimiento"));
      if (!minimumPayment) minimumPayment = parseAmount(findNextSiblingValue(root, "Pago minimo"));
    }

    return { billingDate, billedAmount, dueDate, minimumPayment };
  }, "credit-card-movements");
}

async function clickCmrTab(page: Page, debugLog: string[]): Promise<boolean> {
  const result = await page.evaluate(({ host, radioId }: { host: string; radioId: string }) => {
    const shadowEl = document.querySelector(host) as Element & { shadowRoot?: ShadowRoot };
    const roots: Array<Document | ShadowRoot> = [];
    if (shadowEl?.shadowRoot) roots.push(shadowEl.shadowRoot);
    roots.push(document);

    function clickElement(element: HTMLElement): void {
      element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      element.click();
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }

    // Try well-known radio id first
    for (const root of roots) {
      const radio = root.getElementById?.(radioId) as HTMLInputElement | null;
      if (radio) {
        radio.checked = true;
        radio.dispatchEvent(new Event("change", { bubbles: true }));
        radio.click();
        const label = root.querySelector(`label[for="${radio.id}"]`) as HTMLElement | null
          ?? (radio.closest("label") as HTMLElement | null);
        if (label) label.click();
        return `radio#${radio.id}`;
      }
    }

    // The legacy Angular CMR page uses tabs like <a id="InvoicedMovements">.
    for (const root of roots) {
      const tab = root.getElementById?.("InvoicedMovements") as HTMLElement | null;
      if (tab) {
        clickElement(tab);
        return `tab#${tab.id}`;
      }
    }

    // Fallback: find label containing "facturado"
    for (const root of roots) {
      for (const label of Array.from(root.querySelectorAll<HTMLLabelElement>("label"))) {
        if (!label.innerText?.trim().toLowerCase().includes("facturado")) continue;
        const forId = label.getAttribute("for");
        const radio = forId
          ? (root.querySelector(`#${forId}`) as HTMLInputElement | null)
          : (label.querySelector("input[type='radio']") as HTMLInputElement | null);
        if (radio) {
          radio.checked = true;
          radio.dispatchEvent(new Event("change", { bubbles: true }));
          radio.click();
        }
        label.click();
        return `label: "${label.innerText.trim()}"`;
      }
    }

    // Fallback for tab/link/button UIs without radios or labels.
    for (const root of roots) {
      for (const tab of Array.from(root.querySelectorAll<HTMLElement>("a, button, [role='tab']"))) {
        const text = tab.innerText?.trim().toLowerCase() || "";
        if (!text.includes("facturado")) continue;
        clickElement(tab);
        return `tab: "${tab.innerText.trim()}"`;
      }
    }
    return null;
  }, { host: "credit-card-movements", radioId: "invoicedMovements" });

  if (result) debugLog.push(`  CMR: Clicked facturados tab via ${result}`);
  return result !== null;
}

async function paginateCmrMovements(page: Page, source: MovementSource, debugLog: string[]): Promise<BankMovement[]> {
  const all: BankMovement[] = [];
  const host = "credit-card-movements";

  for (let i = 0; i < MAX_PAGES; i++) {
    await dismissFalabellaPointsModal(page, debugLog, { waitMs: 0 });
    // Extract + click next in a single evaluate
    const result: { rows: BankMovement[]; firstRow: string; clicked: boolean } = await page.evaluate(
      ({ host: h, src, isBilled }: { host: string; src: string; isBilled: boolean }) => {
        const shadowEl = document.querySelector(h) as Element & { shadowRoot?: ShadowRoot };
        const topRoot = shadowEl?.shadowRoot || document;

        function collectAll(root: ShadowRoot | Element | Document): Array<ShadowRoot | Element> {
          const found: Array<ShadowRoot | Element> = root instanceof Document ? [] : [root as Element];
          for (const el of Array.from((root as ParentNode).querySelectorAll("*"))) {
            const sr = (el as Element & { shadowRoot?: ShadowRoot }).shadowRoot;
            if (sr) found.push(...collectAll(sr));
          }
          return found;
        }
        const roots = collectAll(topRoot);

        // Extract movements from visible tables
        const allTables: HTMLTableElement[] = roots.flatMap(
          r => Array.from((r as Element).querySelectorAll<HTMLTableElement>("table")),
        );
        function isVisible(t: HTMLTableElement): boolean {
          const r = t.getBoundingClientRect();
          return r.width > 0 || r.height > 0;
        }

        const rows: BankMovement[] = [];
        const tablesToUse = isBilled
          ? allTables.filter(t => {
              if (!isVisible(t)) return false;
              const hdr = (t.querySelector("thead, tr:first-child") as HTMLElement | null)?.innerText?.toLowerCase() ?? "";
              return hdr.includes("fecha de compra") || hdr.includes("monto total") || hdr.includes("cuota a pagar");
            })
          : allTables.filter(t => isVisible(t));

        const finalTables = tablesToUse.length > 0
          ? tablesToUse
          : allTables.filter(t => isVisible(t) && !t.closest("app-last-movements"));

        for (const table of finalTables) {
          for (const row of Array.from(table.querySelectorAll("tbody tr"))) {
            const cells = row.querySelectorAll("td");
            if (cells.length < 4) continue;
            const texts = Array.from(cells).map(c => (c as HTMLElement).innerText?.trim() || "");
            const dateMatch = texts[0]?.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/);
            const pendingImg = row.querySelector("td:first-child img[alt*='pendiente'], td:first-child .td-time-img");
            if (!dateMatch && !pendingImg && texts[0] !== "") continue;
            const date = dateMatch ? dateMatch[1].replace(/\//g, "-") : "pendiente";
            const description = texts[1] || "";
            const totalText = texts[3] || "";
            const cuotaText = texts[5] || "";
            const montoText = cuotaText || totalText;
            const isNeg = montoText.includes("-$");
            const amountMatch = montoText.match(/\$\s*([\d.,]+)/);
            let amount = 0;
            if (amountMatch) {
              const value = parseInt(amountMatch[1].replace(/\./g, "").replace(",", "."), 10) || 0;
              amount = isNeg ? value : -value;
            }
            const totalAmountMatch = totalText.match(/\$\s*([\d.,]+)/);
            const totalAmount = totalAmountMatch
              ? parseInt(totalAmountMatch[1].replace(/\./g, "").replace(",", "."), 10) || undefined
              : undefined;
            if (description && amount !== 0) {
              rows.push({
                date, description, amount, balance: 0,
                source: src as MovementSource,
                owner: (texts[2] || undefined) as any,
                installments: texts[4] || undefined,
                totalAmount,
              });
            }
          }
        }

        // First row signature for change detection.
        // For billed movements, prefer the "fecha de compra" table — "pendientes de
        // confirmación" rows don't change across pages and cause false negatives.
        let firstRow = "";
        if (isBilled) {
          outer: for (const r of roots) {
            for (const tbl of Array.from((r as Element).querySelectorAll<HTMLTableElement>("table"))) {
              const hdr = (tbl.querySelector("thead, tr:first-child") as HTMLElement | null)?.innerText?.toLowerCase() ?? "";
              if (!hdr.includes("fecha de compra")) continue;
              const cells = tbl.querySelectorAll("tbody tr:first-child td");
              if (cells.length > 0) {
                firstRow = Array.from(cells).map(c => (c as HTMLElement).innerText?.trim()).join("|");
                break outer;
              }
            }
          }
        }
        if (!firstRow) {
          for (const r of roots) {
            const cells = (r as Element).querySelectorAll("table tbody tr:first-child td");
            if (cells.length > 0) {
              firstRow = Array.from(cells).map(c => (c as HTMLElement).innerText?.trim()).join("|");
              break;
            }
          }
        }

        // Click next button
        let clicked = false;
        for (const root of roots) {
          if (clicked) break;
          for (const btn of Array.from((root as Element).querySelectorAll<HTMLButtonElement>(".btn-pagination, button"))) {
            if (btn.disabled) continue;
            const img = btn.querySelector("img");
            const imgAlt = (img?.getAttribute("alt") || "").toLowerCase();
            const imgSrc = img?.getAttribute("src") || "";
            const label = (btn.getAttribute("aria-label") || btn.innerText || "").toLowerCase();
            const isNext =
              imgAlt.includes("avanzar") || imgAlt.includes("siguiente") || imgAlt.includes("next") ||
              imgSrc.includes("right-arrow") || imgSrc.includes("arrow-right") || imgSrc.includes("next") ||
              label.includes("siguiente") || label.includes("next") || label.includes("avanzar");
            if (isNext) { btn.click(); clicked = true; break; }
          }
        }

        return { rows, firstRow, clicked };
      },
      { host, src: source, isBilled: source === MOVEMENT_SOURCE.credit_card_billed },
    );

    debugLog.push(`  [CMR pag] page ${i + 1}: ${result.rows.length} rows`);
    all.push(...result.rows);

    if (!result.clicked) break;

    // Wait for content to change — use the same "fecha de compra" preference as above
    const prevRow = result.firstRow;
    const isBilled = source === MOVEMENT_SOURCE.credit_card_billed;
    const changed = await page.waitForFunction(
      ({ host: h, prev, billed }: { host: string; prev: string; billed: boolean }) => {
        const el = document.querySelector(h) as Element & { shadowRoot?: ShadowRoot };
        const topRoot = el?.shadowRoot || document;
        function collectAll(root: ShadowRoot | Element | Document): Array<ShadowRoot | Element> {
          const found: Array<ShadowRoot | Element> = root instanceof Document ? [] : [root as Element];
          for (const child of Array.from((root as ParentNode).querySelectorAll("*"))) {
            const sr = (child as Element & { shadowRoot?: ShadowRoot }).shadowRoot;
            if (sr) found.push(...collectAll(sr));
          }
          return found;
        }
        const roots = collectAll(topRoot);
        // Prefer "fecha de compra" table for billed to avoid false negatives
        if (billed) {
          for (const r of roots) {
            for (const tbl of Array.from((r as Element).querySelectorAll<HTMLTableElement>("table"))) {
              const hdr = (tbl.querySelector("thead, tr:first-child") as HTMLElement | null)?.innerText?.toLowerCase() ?? "";
              if (!hdr.includes("fecha de compra")) continue;
              const cells = tbl.querySelectorAll("tbody tr:first-child td");
              if (cells.length > 0) {
                const sig = Array.from(cells).map(c => (c as HTMLElement).innerText?.trim()).join("|");
                return sig !== prev && sig !== "";
              }
            }
          }
        }
        // Fallback: any table's first row
        for (const root of roots) {
          const cells = (root as Element).querySelectorAll("table tbody tr:first-child td");
          if (cells.length > 0) {
            const sig = Array.from(cells).map(c => (c as HTMLElement).innerText?.trim()).join("|");
            return sig !== prev && sig !== "";
          }
        }
        return false;
      },
      { host, prev: prevRow, billed: isBilled },
      { timeout: 15000 },
    ).then(() => true, () => false);

    if (!changed) break;
    await delay(300);
    await clearFalabellaBlockingOverlays(page, debugLog);
  }

  return deduplicateMovements(
    all.map(m => ({
      ...m,
      date: normalizeDate(m.date),
      owner: normalizeOwner(m.owner),
      installments: normalizeInstallments(m.installments),
    })),
  );
}

// ─── Main scrape function ────────────────────────────────────────

async function scrapeFalabella(options: ScraperOptions): Promise<ScrapeResult> {
  const {
    rut,
    password,
    saveScreenshots: doScreenshots = false,
    owner = "B",
    signal,
  } = options;
  const progress = options.onProgress || (() => {});
  const bank = "falabella";

  if (!rut || !password) {
    return { success: false, bank, accounts: [], error: "Debes proveer RUT y clave." };
  }

  if (signal?.aborted) {
    return buildCancelledFalabellaResult();
  }

  let browser: Browser | undefined;
  const closeBrowserOnAbort = (): void => {
    if (browser) {
      void browser.close().catch(() => {});
    }
  };

  try {
    const session = await launchPlaywright(options);
    browser = session.browser;
    signal?.addEventListener("abort", closeBrowserOnAbort, { once: true });

    if (signal?.aborted) {
      closeBrowserOnAbort();
      return buildCancelledFalabellaResult(session.debugLog);
    }

    const { page, debugLog } = session;

    // Login
    const loginResult = await login(page, rut, password, debugLog, doScreenshots, progress);
    if (!loginResult.success) {
      return {
        success: false,
        bank,
        accounts: [],
        error: loginResult.error,
        screenshot: loginResult.screenshot,
        debug: debugLog.join("\n"),
      };
    }

    const dashboardUrl = page.url();
    await screenshotIfEnabled(page, "04-post-login", doScreenshots, debugLog);

    // Phase 1: Account movements
    const { movements: accountMovements, balance } = await scrapeAccountMovements(page, debugLog, doScreenshots, progress);

    // Phase 2: CMR credit card — navigate back to dashboard first
    debugLog.push("  Navigating back to dashboard for CMR...");
    progress("Navegando a tarjeta de crédito...");
    await page.goto(dashboardUrl, { waitUntil: "domcontentloaded" });
    await delay(2000);
    await clearFalabellaBlockingOverlays(page, debugLog);

    const { creditCard } = await scrapeCreditCard(page, debugLog, doScreenshots, progress, owner);

    const totalMov = accountMovements.length + (creditCard.movements?.length ?? 0);
    debugLog.push(`12. Total: ${accountMovements.length} account + ${creditCard.movements?.length ?? 0} TC = ${totalMov}`);
    progress(`Listo — ${totalMov} movimientos totales`);

    await screenshotIfEnabled(page, "08-final", doScreenshots, debugLog);
    const ss = doScreenshots ? (await page.screenshot({ fullPage: true })).toString("base64") : undefined;

    // Logout
    try {
      await page.evaluate(() => {
        for (const el of Array.from(document.querySelectorAll("a, button, span"))) {
          const text = (el as HTMLElement).innerText?.trim().toLowerCase();
          if (text === "cerrar sesión" || text === "cerrar sesion" || text === "salir") {
            (el as HTMLElement).click();
            return;
          }
        }
      });
      await delay(2000);
    } catch { /* best effort */ }

    if (signal?.aborted) {
      return buildCancelledFalabellaResult(debugLog);
    }

    return {
      success: true,
      bank,
      accounts: [{ balance, movements: deduplicateMovements(accountMovements) }],
      creditCards: [creditCard],
      screenshot: ss,
      debug: debugLog.join("\n"),
    };
  } catch (error) {
    if (signal?.aborted) {
      return buildCancelledFalabellaResult();
    }

    return {
      success: false,
      bank,
      accounts: [],
      error: `Error del scraper: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    signal?.removeEventListener("abort", closeBrowserOnAbort);
    if (browser) await browser.close().catch(() => {});
  }
}

function buildCancelledFalabellaResult(debugLog: string[] = []): ScrapeResult {
  return {
    success: false,
    bank: "falabella",
    accounts: [],
    error: SCRAPE_CANCELLED_MESSAGE,
    debug: debugLog.join("\n"),
  };
}

// ─── Export ──────────────────────────────────────────────────────

const falabella: BankScraper = {
  id: "falabella",
  name: "Banco Falabella",
  url: BANK_URL,
  scrape: scrapeFalabella,
};

export default falabella;
