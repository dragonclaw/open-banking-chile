import * as fs from "fs";
import { homedir } from "os";
import * as path from "path";
import type {
  Browser,
  ElementHandle,
  HTTPRequest,
  HTTPResponse,
  Page,
} from "puppeteer-core";
import { detectLoginError } from "../actions/login.js";
import { closePopups, delay, findChrome } from "../utils.js";

export const SCOTIABANK_BANK_URL = "https://www.scotiabank.cl";
export const AUTH_CALLBACK_PATH = "/mfe-login/api/auth/callback/enigma";

const LOGIN_CALLBACK_TIMEOUT_MS = 30_000;
const LOGIN_MAX_ATTEMPTS = 3;
const SECURITY_SENSOR_SETTLE_MS = 8_000;
const SCOTIABANK_ACCEPT_LANGUAGE =
  "en-CL,en;q=0.9,es-US;q=0.8,es;q=0.7,en-US;q=0.6";
const SCOTIABANK_CHROME_VERSION = "152.0.0.0";
const SCOTIABANK_WINDOWS_PLATFORM_VERSION = "19.0.0";
const SCOTIABANK_WINDOWS_RENDERER =
  "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 (0x00002786) Direct3D11 vs_5_0 ps_5_0, D3D11)";

export const SCOTIABANK_CHROME_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-blink-features=AutomationControlled",
  "--disable-notifications",
  "--enable-gpu",
  "--lang=en-CL",
  "--window-size=1920,1080",
];

export const SCOTIABANK_LOGIN_SELECTORS = {
  rutSelectors: [
    '[data-testid="inputDni"]',
    "#login-retail-content-card-form-input-dni-input",
    'input[name="userId"]',
    'input[placeholder*="RUT"]',
    "#inputDni",
    'input[name="inputDni"]',
    'input[id*="Dni"]',
    'input[name*="Dni"]',
  ],
  passwordSelectors: [
    '[data-testid="inputPassword"]',
    "#login-retail-content-card-form-input-password-input",
    'input[name="pass"]',
    'input[placeholder*="contraseña"]',
    "#inputPassword",
    'input[name="inputPassword"]',
    'input[id*="Password"]',
    'input[name*="Password"]',
  ],
  submitSelectors: ['button[type="submit"]', 'input[type="submit"]'],
};

export const SCOTIABANK_BROWSER_HEADERS = {
  "Accept-Language": SCOTIABANK_ACCEPT_LANGUAGE,
  DNT: "1",
};

export type ScotiabankAuthCallbackOutcome =
  | "accepted"
  | "blocked"
  | "credentials_rejected"
  | "unexpected";

export type ScotiabankLoginResult =
  | { success: true }
  | { error: string; screenshot?: string; success: false };

interface ScotiabankLoginHooks {
  dismissTutorial: (page: Page, debugLog: string[]) => Promise<void>;
  waitForDashboard: (page: Page) => Promise<boolean>;
}

export function classifyScotiabankAuthCallback(
  status: number,
): ScotiabankAuthCallbackOutcome {
  if (status === 200) return "accepted";
  if (status === 401) return "credentials_rejected";
  if (status === 403) return "blocked";
  return "unexpected";
}

export function resolveScotiabankProfileDirectory(
  configuredDirectory?: string,
): string {
  return path.resolve(
    configuredDirectory || path.join(".browser-profiles", "scotiabank"),
  );
}

const CACHED_CHROME_VERSION_DIR =
  /^(?:linux|win64|mac|mac_arm)-(\d+)\.(\d+)\.(\d+)\.(\d+)$/;

export async function resolveScotiabankChrome(
  customPath?: string,
): Promise<string | null> {
  if (customPath && fs.existsSync(customPath)) return customPath;

  const puppeteerChrome = await resolvePuppeteerBundledChrome();
  if (puppeteerChrome) return puppeteerChrome;

  const cachedPuppeteerChrome = findCachedChromeForTesting();
  if (cachedPuppeteerChrome) return cachedPuppeteerChrome;

  const playwrightChrome = await resolvePlaywrightBundledChrome();
  if (playwrightChrome) return playwrightChrome;

  return findChrome();
}

export function findCachedChromeForTesting(
  cacheRoots: string[] = defaultPuppeteerCacheRoots(),
): string | null {
  const found: Array<{ chromePath: string; version: number[] }> = [];

  for (const root of cacheRoots) {
    const chromeRoot = path.join(root, "chrome");
    if (!fs.existsSync(chromeRoot)) continue;

    for (const entry of fs.readdirSync(chromeRoot)) {
      const match = entry.match(CACHED_CHROME_VERSION_DIR);
      if (!match) continue;
      const chromePath = resolveCachedChromeBinary(path.join(chromeRoot, entry));
      if (!chromePath) continue;
      found.push({
        chromePath,
        version: match.slice(1, 5).map(Number),
      });
    }
  }

  found.sort((left, right) => compareChromeVersions(right.version, left.version));
  return found[0]?.chromePath ?? null;
}

function defaultPuppeteerCacheRoots(): string[] {
  return uniqueExistingRoots([
    process.env.PUPPETEER_CACHE_DIR,
    path.join(homedir(), ".cache", "puppeteer"),
  ]);
}

function uniqueExistingRoots(values: Array<string | undefined>): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    roots.push(normalized);
  }

  return roots;
}

function resolveCachedChromeBinary(versionDirectory: string): string | null {
  const candidates = [
    path.join(versionDirectory, "chrome-linux64", "chrome"),
    path.join(versionDirectory, "chrome-win64", "chrome.exe"),
    path.join(
      versionDirectory,
      "chrome-mac-x64",
      "Google Chrome for Testing.app",
      "Contents",
      "MacOS",
      "Google Chrome for Testing",
    ),
    path.join(
      versionDirectory,
      "chrome-mac-arm64",
      "Google Chrome for Testing.app",
      "Contents",
      "MacOS",
      "Google Chrome for Testing",
    ),
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function compareChromeVersions(left: number[], right: number[]): number {
  for (let index = 0; index < 4; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

async function resolvePuppeteerBundledChrome(): Promise<string | null> {
  try {
    const puppeteer = await import("puppeteer");
    const executablePath = await Promise.resolve(puppeteer.executablePath());
    return executablePath && fs.existsSync(executablePath) ? executablePath : null;
  } catch {
    return null;
  }
}

async function resolvePlaywrightBundledChrome(): Promise<string | null> {
  try {
    const { chromium } = await import("playwright-core");
    const executablePath = chromium.executablePath();
    return executablePath && fs.existsSync(executablePath) ? executablePath : null;
  } catch {
    return null;
  }
}

export function formatScotiabankRut(rut: string): string {
  const cleanRut = rut.replace(/[.\-]/g, "");
  return `${cleanRut.slice(0, -1)}-${cleanRut.slice(-1)}`;
}

export function isScotiabankDashboardUrl(url: string): boolean {
  return /\/mfe-home-cl\//.test(url);
}

export function normalizeScotiabankFingerprint(
  encoded: string,
  chromeVersion = SCOTIABANK_CHROME_VERSION,
): string {
  try {
    const fingerprint = JSON.parse(
      Buffer.from(encoded, "base64").toString("utf8"),
    ) as Record<string, unknown>;
    const browser = getRecord(fingerprint.Browser);
    const general = getRecord(fingerprint.General);
    const personalization = getRecord(fingerprint.Personalization);
    if (!browser || !general || !personalization) return encoded;

    const majorVersion = chromeVersion.split(".")[0] || "152";
    Object.assign(browser, {
      browserMajor: majorVersion,
      browserVersion: chromeVersion,
      osName: "Windows",
      osVersion: "10",
      userAgent:
        `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ` +
        `(KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`,
    });
    Object.assign(general, {
      availableResolution: "1920x1032",
      deviceMemory: "32",
      hardwareConcurrency: "16",
      language: "en-CL",
      navigatorPlatform: "Win32",
      rendererVideo: SCOTIABANK_WINDOWS_RENDERER,
      resolution: "1920x1080",
      vendorWebGL: "1",
    });
    Object.assign(personalization, { numberFonts: "33", numberPlugins: "5" });
    return Buffer.from(JSON.stringify(fingerprint), "utf8").toString("base64");
  } catch {
    return encoded;
  }
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseScotiabankChromeVersion(version: string): {
  full: string;
  major: string;
} {
  const match = version.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return { full: SCOTIABANK_CHROME_VERSION, major: "152" };
  }
  return { full: match[0], major: match[1] ?? "152" };
}

export async function configureScotiabankPage(
  browser: Browser,
  page: Page,
  debugLog: string[],
  diagnoseNetwork = false,
): Promise<void> {
  debugLog.push(
    `  Chrome ${await browser.version()} — skipping Windows fingerprint spoof to keep UA and TLS aligned.`,
  );
  await page.setExtraHTTPHeaders(SCOTIABANK_BROWSER_HEADERS);
  if (diagnoseNetwork) attachScotiabankNetworkDiagnostics(page, debugLog);
}

async function configureScotiabankWindowsIdentity(
  page: Page,
  chromeVersion: { full: string; major: string },
): Promise<void> {
  const userAgent =
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ` +
    `(KHTML, like Gecko) Chrome/${chromeVersion.major}.0.0.0 Safari/537.36`;
  const brandVersion = { brand: "Google Chrome", version: chromeVersion.major };
  const chromiumVersion = { brand: "Chromium", version: chromeVersion.major };
  const cdpSession = await page.createCDPSession();
  await cdpSession.send("Network.setUserAgentOverride", {
    acceptLanguage: SCOTIABANK_ACCEPT_LANGUAGE,
    platform: "Win32",
    userAgent,
    userAgentMetadata: {
      architecture: "x86",
      bitness: "64",
      brands: [
        chromiumVersion,
        { brand: "Not-A.Brand", version: "24" },
        brandVersion,
      ],
      fullVersion: chromeVersion.full,
      fullVersionList: [
        { brand: "Chromium", version: chromeVersion.full },
        { brand: "Not-A.Brand", version: "24.0.0.0" },
        { brand: "Google Chrome", version: chromeVersion.full },
      ],
      mobile: false,
      model: "",
      platform: "Windows",
      platformVersion: SCOTIABANK_WINDOWS_PLATFORM_VERSION,
      wow64: false,
    },
  });
  await cdpSession.send("Emulation.setLocaleOverride", { locale: "en-CL" });
  await page.evaluateOnNewDocument(
    ({ renderer }) => {
      Object.defineProperty(navigator, "deviceMemory", { get: () => 32 });
      Object.defineProperty(navigator, "platform", { get: () => "Win32" });
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      Object.defineProperty(screen, "availHeight", { get: () => 1032 });
      type WebGlContext = WebGLRenderingContext | WebGL2RenderingContext;
      const overrideWebGl = (
        prototype:
          | typeof WebGLRenderingContext.prototype
          | typeof WebGL2RenderingContext.prototype,
      ): void => {
        const getExtension = prototype.getExtension as unknown as (
          this: WebGlContext,
          name: string,
        ) => unknown;
        const getParameter = prototype.getParameter as unknown as (
          this: WebGlContext,
          parameter: number,
        ) => unknown;
        prototype.getExtension = function (
          this: WebGlContext,
          name: string,
        ): unknown {
          if (name === "WEBGL_debug_renderer_info") {
            return {
              UNMASKED_RENDERER_WEBGL: 37446,
              UNMASKED_VENDOR_WEBGL: 37445,
            };
          }
          return getExtension.call(this, name);
        } as typeof prototype.getExtension;
        prototype.getParameter = function (
          this: WebGlContext,
          parameter: number,
        ): unknown {
          if (parameter === 37445) return "Google Inc. (NVIDIA)";
          if (parameter === 37446) return renderer;
          return getParameter.call(this, parameter);
        };
      };
      overrideWebGl(WebGLRenderingContext.prototype);
      if (typeof WebGL2RenderingContext !== "undefined") {
        overrideWebGl(WebGL2RenderingContext.prototype);
      }
    },
    { renderer: SCOTIABANK_WINDOWS_RENDERER },
  );
}

async function installScotiabankFingerprintRoute(
  page: Page,
  chromeVersion: string,
): Promise<void> {
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    void continueScotiabankRequest(request, chromeVersion);
  });
}

async function continueScotiabankRequest(
  request: HTTPRequest,
  chromeVersion: string,
): Promise<void> {
  try {
    if (request.isInterceptResolutionHandled()) return;
    if (!isScotiabankAuthCallbackRequest(request)) {
      await request.continue();
      return;
    }
    const postData = request.postData();
    if (!postData) {
      await request.continue();
      return;
    }
    const form = new URLSearchParams(postData);
    const fingerprint = form.get("xFingerPrintDevice");
    if (!fingerprint) {
      await request.continue();
      return;
    }
    form.set(
      "xFingerPrintDevice",
      normalizeScotiabankFingerprint(fingerprint, chromeVersion),
    );
    await request.continue({ postData: form.toString() });
  } catch {
    if (!request.isInterceptResolutionHandled()) {
      await request.continue().catch(() => {});
    }
  }
}

function isScotiabankAuthCallbackRequest(request: HTTPRequest): boolean {
  try {
    return (
      request.method() === "POST" &&
      new URL(request.url()).pathname === AUTH_CALLBACK_PATH
    );
  } catch {
    return false;
  }
}

function isScotiabankAuthCallback(response: HTTPResponse): boolean {
  return isScotiabankAuthCallbackRequest(response.request());
}

function attachScotiabankNetworkDiagnostics(
  page: Page,
  debugLog: string[],
): void {
  page.on("response", (response) => {
    void logScotiabankNetworkResponse(response, debugLog);
  });
}

async function logScotiabankNetworkResponse(
  response: HTTPResponse,
  debugLog: string[],
): Promise<void> {
  try {
    const url = new URL(response.url());
    if (url.pathname !== AUTH_CALLBACK_PATH) return;
    const server = response.headers()["server"] ?? "unknown";
    debugLog.push(
      `[network] HTTP ${response.status()} POST ${url.origin}${url.pathname} server=${server}`,
    );
    const request = response.request();
    const headers = request.headers();
    const cookies = await response.frame()?.page().cookies(response.url());
    const akamaiCookie = cookies?.find((cookie) => cookie.name === "_abck");
    const akamaiSegments = akamaiCookie?.value.split("~") ?? [];
    debugLog.push(
      `[network-profile] ${JSON.stringify({
        akamaiState: akamaiCookie
          ? {
              sensorLength: akamaiSegments[2]?.length ?? 0,
              status: akamaiSegments[1] ?? "unknown",
            }
          : null,
        cookieNames: (headers.cookie ?? "")
          .split(";")
          .map((cookie) => cookie.split("=", 1)[0]?.trim())
          .filter(Boolean),
        headers: {
          accept: headers.accept,
          acceptLanguage: headers["accept-language"],
          dnt: headers.dnt,
          origin: headers.origin,
          referer: headers.referer ? "[redacted query]" : undefined,
          secChUa: headers["sec-ch-ua"],
          secChUaMobile: headers["sec-ch-ua-mobile"],
          secChUaPlatform: headers["sec-ch-ua-platform"],
          userAgent: headers["user-agent"],
        },
        payloadKeys: Array.from(
          new URLSearchParams(request.postData() ?? "").keys(),
        ),
      })}`,
    );
  } catch {
    // Ignore malformed diagnostic URLs.
  }
}

async function dismissScotiabankBanners(page: Page): Promise<void> {
  const clicked = await page.evaluate(() => {
    const pattern = /^(Aceptar|Entendido|Continuar|Cerrar)$/i;
    for (const control of Array.from(document.querySelectorAll("button, a"))) {
      const text = (control as HTMLElement).innerText?.trim() ?? "";
      if (!pattern.test(text)) continue;
      const style = window.getComputedStyle(control as HTMLElement);
      if (style.display === "none" || style.visibility === "hidden") continue;
      (control as HTMLElement).click();
      return true;
    }
    return false;
  });
  if (clicked) await delay(500);
}

async function clickWithMouse(
  page: Page,
  element: ElementHandle<Element>,
): Promise<void> {
  const box = await element.boundingBox();
  if (!box) {
    await element.click({ delay: 80 });
    return;
  }
  await page.mouse.move(40, 40);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
    steps: 24,
  });
  await delay(180);
  await page.mouse.down();
  await delay(90);
  await page.mouse.up();
}

async function fillFirstVisible(
  page: Page,
  selectors: readonly string[],
  value: string,
  timeoutMs = 15_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const field = await findVisibleElement(page, selectors);
    if (field) {
      await clickWithMouse(page, field);
      await field.evaluate((node) => {
        const input = node as HTMLInputElement;
        input.focus();
        input.select();
      });
      await field.type(value, { delay: 45 });
      await field.evaluate((node) => (node as HTMLInputElement).blur());
      return true;
    }
    await delay(250);
  }
  return false;
}

async function findVisibleElement(
  page: Page,
  selectors: readonly string[],
): Promise<ElementHandle<Element> | null> {
  for (const selector of selectors) {
    const elements = await page.$$(selector);
    for (const element of elements) {
      if (await element.isVisible().catch(() => false)) return element;
    }
  }
  return null;
}

async function clickScotiabankSubmit(page: Page): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const submit =
      (await findVisibleElement(page, SCOTIABANK_LOGIN_SELECTORS.submitSelectors)) ??
      (await findSubmitByText(page));
    if (submit) {
      await clickWithMouse(page, submit);
      return;
    }
    await delay(250);
  }
  await page.keyboard.press("Enter");
}

async function findSubmitByText(
  page: Page,
): Promise<ElementHandle<Element> | null> {
  const handle = await page.evaluateHandle(() => {
    const pattern = /ingresar|entrar/i;
    for (const node of Array.from(
      document.querySelectorAll("button, input[type='submit']"),
    )) {
      const text =
        (node as HTMLElement).innerText?.trim() ||
        (node as HTMLInputElement).value ||
        "";
      if (pattern.test(text)) return node;
    }
    return null;
  });
  const element = handle.asElement() as ElementHandle<Element> | null;
  if (!element) return null;
  if (await element.isVisible().catch(() => false)) return element;
  return null;
}

export async function settleScotiabankSecuritySensors(
  page: Page,
): Promise<void> {
  const viewport = page.viewport() ?? { height: 900, width: 1280 };
  const points = [
    { x: viewport.width * 0.25, y: viewport.height * 0.3 },
    { x: viewport.width * 0.65, y: viewport.height * 0.45 },
    { x: viewport.width * 0.45, y: viewport.height * 0.7 },
  ];
  for (const point of points) {
    await page.mouse.move(point.x, point.y, { steps: 16 });
    await delay(400);
  }
  await delay(SECURITY_SENSOR_SETTLE_MS);
}

async function submitScotiabankLoginWithRetries(
  page: Page,
  debugLog: string[],
): Promise<HTTPResponse | null> {
  for (let attempt = 1; attempt <= LOGIN_MAX_ATTEMPTS; attempt++) {
    debugLog.push(`5.${attempt}. Submitting login...`);
    const callbackPromise = page.waitForResponse(isScotiabankAuthCallback, {
      timeout: LOGIN_CALLBACK_TIMEOUT_MS,
    });
    await clickScotiabankSubmit(page);
    const callback = await callbackPromise.catch(() => null);
    if (
      !callback ||
      callback.status() !== 403 ||
      attempt === LOGIN_MAX_ATTEMPTS
    ) {
      return callback;
    }
    debugLog.push(
      `  Akamai blocked attempt ${attempt}; keeping the session and retrying...`,
    );
    await settleScotiabankSecuritySensors(page);
  }
  return null;
}

async function captureScotiabankFailure(
  page: Page,
  error: string,
): Promise<ScotiabankLoginResult> {
  const screenshot = await page.screenshot({ encoding: "base64", fullPage: true });
  return { error, screenshot: screenshot as string, success: false };
}

export async function loginScotiabank(
  page: Page,
  rut: string,
  password: string,
  debugLog: string[],
  doSave: (page: Page, name: string) => Promise<void>,
  progress: (step: string) => void,
  hooks: ScotiabankLoginHooks,
): Promise<ScotiabankLoginResult> {
  debugLog.push("1. Navigating to Scotiabank...");
  progress("Abriendo sitio del banco...");
  await page.goto(SCOTIABANK_BANK_URL, {
    timeout: 30_000,
    waitUntil: "domcontentloaded",
  });
  await delay(2_000);
  await dismissScotiabankBanners(page);
  await doSave(page, "01-homepage");

  const openedLogin = await openScotiabankLogin(page, debugLog);
  if (!openedLogin.success) return openedLogin;
  if (openedLogin.reusedSession) {
    return finishReusedSession(page, debugLog, hooks);
  }
  await doSave(page, "02-login-form");

  const filled = await fillScotiabankCredentials(page, rut, password, debugLog, progress);
  if (!filled.success) return filled;
  await settleScotiabankSecuritySensors(page);

  progress("Iniciando sesión...");
  const callback = await submitScotiabankLoginWithRetries(page, debugLog);
  return finishSubmittedLogin(page, callback, debugLog, doSave, progress, hooks);
}

async function openScotiabankLogin(
  page: Page,
  debugLog: string[],
): Promise<ScotiabankLoginResult & { reusedSession?: boolean }> {
  debugLog.push("2. Clicking login button...");
  const loginHref = await page
    .$eval('a[href*="/login/personas"]', (element) => element.getAttribute("href"))
    .catch(() => null);
  if (!loginHref) {
    return captureScotiabankFailure(page, "No se encontró el acceso de clientes.");
  }
  await page.goto(new URL(loginHref, page.url()).toString(), {
    referer: page.url(),
    timeout: 30_000,
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction(
    () =>
      /banco\.scotiabank\.cl\/mfe-login\//.test(window.location.href) ||
      /\/mfe-home-cl\//.test(window.location.href),
    { timeout: 20_000 },
  );
  if (isScotiabankDashboardUrl(page.url())) {
    return { reusedSession: true, success: true };
  }
  return { success: true };
}

async function finishReusedSession(
  page: Page,
  debugLog: string[],
  hooks: ScotiabankLoginHooks,
): Promise<ScotiabankLoginResult> {
  debugLog.push("3. Reusing the authenticated Scotiabank session.");
  const dashboardLoaded = await hooks.waitForDashboard(page);
  if (!dashboardLoaded) {
    return captureScotiabankFailure(
      page,
      "Scotiabank abrió la sesión existente, pero no cargó el dashboard.",
    );
  }
  await closePopups(page);
  await hooks.dismissTutorial(page, debugLog);
  return { success: true };
}

async function fillScotiabankCredentials(
  page: Page,
  rut: string,
  password: string,
  debugLog: string[],
  progress: (step: string) => void,
): Promise<ScotiabankLoginResult> {
  debugLog.push("3. Filling RUT...");
  progress("Ingresando RUT...");
  const rutFilled = await fillFirstVisible(
    page,
    SCOTIABANK_LOGIN_SELECTORS.rutSelectors,
    formatScotiabankRut(rut),
  );
  if (!rutFilled) {
    return captureScotiabankFailure(page, "No se encontró campo de RUT");
  }

  debugLog.push("4. Filling password...");
  let passwordFilled = await fillFirstVisible(
    page,
    SCOTIABANK_LOGIN_SELECTORS.passwordSelectors,
    password,
    1_000,
  );
  if (!passwordFilled) {
    await page.keyboard.press("Enter");
    passwordFilled = await fillFirstVisible(
      page,
      SCOTIABANK_LOGIN_SELECTORS.passwordSelectors,
      password,
      10_000,
    );
  }
  if (!passwordFilled) {
    return captureScotiabankFailure(page, "No se encontró campo de clave");
  }
  return { success: true };
}

async function finishSubmittedLogin(
  page: Page,
  callback: HTTPResponse | null,
  debugLog: string[],
  doSave: (page: Page, name: string) => Promise<void>,
  progress: (step: string) => void,
  hooks: ScotiabankLoginHooks,
): Promise<ScotiabankLoginResult> {
  if (!callback) {
    return captureScotiabankFailure(
      page,
      "Scotiabank no respondió al intento de inicio de sesión.",
    );
  }
  const callbackError = describeCallbackError(callback.status());
  if (callbackError) return captureScotiabankFailure(page, callbackError);

  const dashboardLoaded = await hooks.waitForDashboard(page);
  await doSave(page, "03-after-login");
  const pageContent = (await page.content()).toLowerCase();
  if (
    pageContent.includes("clave dinámica") ||
    pageContent.includes("segundo factor") ||
    pageContent.includes("código de verificación")
  ) {
    return captureScotiabankFailure(page, "El banco pide clave dinámica o 2FA.");
  }
  const loginError = await detectLoginError(page);
  if (loginError) {
    return captureScotiabankFailure(page, `Error del banco: ${loginError}`);
  }
  if (!dashboardLoaded) {
    return captureScotiabankFailure(
      page,
      "Scotiabank aceptó el login, pero no cargó el dashboard.",
    );
  }

  debugLog.push("6. Login OK!");
  progress("Sesión iniciada correctamente");
  await closePopups(page);
  await hooks.dismissTutorial(page, debugLog);
  return { success: true };
}

function describeCallbackError(status: number): string | null {
  const outcome = classifyScotiabankAuthCallback(status);
  if (outcome === "credentials_rejected") {
    return "Scotiabank rechazó el RUT o la clave.";
  }
  if (outcome === "blocked") {
    return "Scotiabank bloqueó la solicitud de acceso antes de validar las credenciales.";
  }
  if (outcome === "unexpected") {
    return `Scotiabank respondió con HTTP ${status} al iniciar sesión.`;
  }
  return null;
}
