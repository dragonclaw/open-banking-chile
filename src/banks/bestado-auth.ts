import type { HTTPResponse, Page } from 'puppeteer-core';
import type { BrowserOptions } from '../infrastructure/browser.js';
import { delay } from '../utils.js';

const LOGIN_TIMEOUT_MS = 30_000;
const LOGIN_POLL_MS = 500;
const LOGIN_API_PATH = '/bff/v1/claveinternet-web-bff/loginbff';
const BESTADO_CHROME_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-blink-features=AutomationControlled',
  '--disable-notifications',
  '--window-size=1280,900',
];

export interface BestadoAuthState {
  authenticated: boolean;
  loginFormVisible: boolean;
  credentialsRejected: boolean;
  verificationRequired: boolean;
  bankError: boolean;
}

export interface BestadoLoginObservation {
  status?: number;
  stop: () => void;
}

export function buildBestadoBrowserOptions(): Partial<BrowserOptions> {
  return {
    forceHeadful: true,
    customArgs: BESTADO_CHROME_ARGS,
    ignoreDefaultArgs: ['--enable-automation'],
    preserveUserAgent: true,
  };
}

// Self-contained so Puppeteer can execute the same reader in each frame.
export function readBestadoAuthState(root: Document = document): BestadoAuthState {
  const visible = (element: Element): boolean => {
    const view = root.defaultView;
    const style = view?.getComputedStyle(element);
    return !!element.getClientRects().length && style?.visibility !== 'hidden';
  };
  const loginFormVisible = Array.from(root.querySelectorAll('#rut, #pass')).some(visible);
  const controls = Array.from(root.querySelectorAll('button, a, [role=button]'))
    .filter(visible)
    .map((element) =>
      `${element.textContent ?? ''} ${element.getAttribute('aria-label') ?? ''}`
        .trim()
        .toLowerCase(),
    );
  const text = root.body?.innerText?.toLowerCase() ?? '';
  const errors = Array.from(
    root.querySelectorAll(
      '[role="alert"], [role="dialog"], [class*="error"], [class*="alert"], .input-messages',
    ),
  )
    .filter((element) => visible(element) && !element.querySelector('#rut, #pass'))
    .map((element) => (element as HTMLElement).innerText ?? '')
    .join(' ');
  return {
    authenticated:
      !loginFormVisible &&
      controls.some((label) => /cerrar sesi[oó]n|salir|logout/.test(label)) &&
      /saldo|movimientos|mis productos|cuenta\s*rut/.test(text),
    loginFormVisible,
    credentialsRejected:
      /(?:rut|clave|contrase[ñn]a|credenciales).{0,50}(?:incorrect|inv[aá]lid)|(?:incorrect|inv[aá]lid).{0,50}(?:rut|clave|credenciales)/i.test(
        errors,
      ),
    verificationRequired:
      /clave din[aá]mica|segundo factor|autoriza.{0,40}app|verifica.{0,40}identidad/i.test(errors),
    bankError: /error|problema|intenta nuevamente|intente nuevamente|bloquead|reintente/i.test(
      errors,
    ),
  };
}

export async function readBestadoPageAuthState(page: Page): Promise<BestadoAuthState> {
  const states = await Promise.all(
    page.frames().map(async (frame) => {
      try {
        const hostname = new URL(frame.url()).hostname;
        if (hostname !== 'bancoestado.cl' && !hostname.endsWith('.bancoestado.cl')) return null;
        return await frame.evaluate(readBestadoAuthState);
      } catch {
        return null; // Frames can detach during authentication redirects.
      }
    }),
  );
  return {
    authenticated: states.some((state) => state?.authenticated),
    loginFormVisible: states.some((state) => state?.loginFormVisible),
    credentialsRejected: states.some((state) => state?.credentialsRejected),
    verificationRequired: states.some((state) => state?.verificationRequired),
    bankError: states.some((state) => state?.bankError),
  };
}

export async function fillBestadoInput(
  page: Page,
  selector: '#rut' | '#pass',
  value: string,
): Promise<boolean> {
  const input = await page.$(selector);
  if (!input) return false;
  await input.click();
  // BancoEstado removes readonly on focus; wait for Angular rather than changing its DOM.
  await page.waitForFunction(
    (target) => {
      const field = document.querySelector<HTMLInputElement>(target);
      return !!field && !field.readOnly && !field.disabled;
    },
    { timeout: 5_000 },
    selector,
  );
  await input.click({ count: 3 });
  await page.keyboard.press('Backspace');
  await input.type(value, { delay: 80 });
  await page.keyboard.press('Tab');
  return page.evaluate(
    (target, expected) => {
      const field = document.querySelector<HTMLInputElement>(target);
      const actual =
        target === '#rut' ? field?.value.replace(/[.\-\s]/g, '').toLowerCase() : field?.value;
      const normalizedExpected = target === '#rut' ? expected.toLowerCase() : expected;
      return actual === normalizedExpected && !!field?.validity.valid;
    },
    selector,
    value,
  );
}

export function observeBestadoLoginResponses(
  page: Page,
  debugLog: string[],
): BestadoLoginObservation {
  const observation: BestadoLoginObservation = {
    stop: () => {
      page.off('response', onResponse);
    },
  };
  const onResponse = (response: HTTPResponse): void => {
    const request = response.request();
    const url = new URL(response.url());
    if (url.hostname !== 'bancoestado.cl' && !url.hostname.endsWith('.bancoestado.cl')) return;
    if (url.pathname !== LOGIN_API_PATH) return;
    if (request.method() !== 'POST') return;
    // Never record URLs, request/response bodies, headers, or security tokens.
    observation.status = response.status();
    debugLog.push(`  BancoEstado authentication response: HTTP ${observation.status}`);
  };
  page.on('response', onResponse);
  return observation;
}

export function bestadoAuthFailure(state: BestadoAuthState): string {
  if (state.credentialsRejected)
    return 'BancoEstado rechazó el RUT o la clave: credenciales inválidas.';
  if (state.verificationRequired) return 'BancoEstado requiere segundo factor para iniciar sesión.';
  if (state.bankError) return 'BancoEstado mostró un error de acceso; revisa el diagnóstico local.';
  return 'BancoEstado no confirmó una sesión autenticada; revisa el diagnóstico local.';
}

export async function waitForBestadoLogin(
  page: Page,
  debugLog: string[],
  observation: BestadoLoginObservation,
): Promise<string | null> {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let state = await readBestadoPageAuthState(page);
  while (Date.now() < deadline) {
    if (state.authenticated) return null;
    if (observation.status === 403) return 'BancoEstado bloqueó la solicitud de acceso (HTTP 403).';
    if (observation.status && observation.status >= 400) {
      return `BancoEstado respondió con HTTP ${observation.status} al solicitar acceso.`;
    }
    if (state.credentialsRejected || state.verificationRequired || state.bankError) break;
    await delay(LOGIN_POLL_MS);
    state = await readBestadoPageAuthState(page);
  }
  debugLog.push(`  Authentication state: ${JSON.stringify(state)}`);
  return bestadoAuthFailure(state);
}
