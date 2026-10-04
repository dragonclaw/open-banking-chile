import { JSDOM } from 'jsdom';
import type { HTTPResponse, Page } from 'puppeteer-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bestadoAuthFailure,
  buildBestadoBrowserOptions,
  fillBestadoInput,
  observeBestadoLoginResponses,
  readBestadoAuthState,
  waitForBestadoLogin,
} from './bestado-auth.js';

const LOGIN_FORM =
  '<div role="dialog"><input id="rut"><input id="pass" type="password"><button>¿Problemas con tu Clave?</button></div>';

function createDocument(html: string): Document {
  const { window } = new JSDOM(html);
  Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
    get() {
      return this.textContent;
    },
  });
  Object.defineProperty(window.HTMLElement.prototype, 'getClientRects', {
    value() {
      return this.closest('[hidden], [style*="display:none"]') ? [] : [{}];
    },
  });
  return window.document;
}

function createPage(root: Document): Page {
  return {
    frames: () => [
      {
        url: () => 'https://www.bancoestado.cl/',
        evaluate: (read: typeof readBestadoAuthState) => read(root),
      },
    ],
  } as unknown as Page;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('BancoEstado authentication', () => {
  it("preserves Chrome's real identity and GPU in a visible browser", () => {
    const options = buildBestadoBrowserOptions();
    expect(options.forceHeadful).toBe(true);
    expect(options.preserveUserAgent).toBe(true);
    expect(options.customArgs).not.toContain('--disable-gpu');
    expect(options.ignoreDefaultArgs).toContain('--enable-automation');
  });

  it('does not authenticate the public site or treat password help as an error', () => {
    const state = readBestadoAuthState(
      createDocument(`${LOGIN_FORM}<p>CuentaRUT desde $2.700</p>`),
    );
    expect(state).toEqual({
      authenticated: false,
      loginFormVisible: true,
      credentialsRejected: false,
      verificationRequired: false,
      bankError: false,
    });
  });

  it('requires an authenticated control and account content even after the form disappears', () => {
    expect(
      readBestadoAuthState(createDocument('<p>CuentaRUT saldo $2.700</p>')).authenticated,
    ).toBe(false);
    expect(readBestadoAuthState(createDocument('<button>Salir</button>')).authenticated).toBe(
      false,
    );
    expect(
      readBestadoAuthState(
        createDocument('<button aria-label="Cerrar sesión"></button><p>Saldo disponible</p>'),
      ).authenticated,
    ).toBe(true);
  });

  it('ignores hidden credential errors and distinguishes service failures from rejection', () => {
    const state = readBestadoAuthState(
      createDocument(`${LOGIN_FORM}
      <div role="alert" hidden>Clave incorrecta</div>
      <div role="alert">Hemos detectado un error, reintente más tarde.</div>`),
    );
    expect(state.credentialsRejected).toBe(false);
    expect(state.bankError).toBe(true);
    expect(bestadoAuthFailure(state)).not.toContain('credenciales inválidas');
    expect(
      readBestadoAuthState(createDocument('<div role="alert">RUT o clave incorrectos</div>'))
        .credentialsRejected,
    ).toBe(true);
  });

  it('rejects an HTTP 403 without reporting successful authentication', async () => {
    const result = await waitForBestadoLogin(createPage(createDocument(LOGIN_FORM)), [], {
      status: 403,
      stop: vi.fn(),
    });
    expect(result).toContain('HTTP 403');
  });

  it('does not treat HTTP 200 alone as an authenticated session', async () => {
    vi.useFakeTimers();
    const debug: string[] = [];
    const pending = waitForBestadoLogin(createPage(createDocument(LOGIN_FORM)), debug, {
      status: 200,
      stop: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toContain('no confirmó una sesión autenticada');
    expect(debug.join()).toContain('"loginFormVisible":true');
  });

  it('accepts a formatted RUT and rejects a truncated password', async () => {
    const root = createDocument(LOGIN_FORM);
    vi.stubGlobal('document', root);
    const field = root.querySelector<HTMLInputElement>('#rut')!;
    const input = {
      click: vi.fn(),
      type: vi.fn(async () => {
        field.value = '12.345.678-9';
      }),
    };
    const page = {
      $: vi.fn(async () => input),
      waitForFunction: vi.fn(),
      keyboard: { press: vi.fn() },
      evaluate: (
        check: (selector: string, value: string) => boolean,
        selector: string,
        value: string,
      ) => check(selector, value),
    } as unknown as Page;
    expect(await fillBestadoInput(page, '#rut', '123456789')).toBe(true);
    const password = root.querySelector<HTMLInputElement>('#pass')!;
    input.type.mockImplementation(async () => {
      password.value = 'truncated';
    });
    expect(await fillBestadoInput(page, '#pass', 'truncated-password')).toBe(false);
  });

  it('logs only the authentication status and detaches the observer', () => {
    const on = vi.fn();
    const off = vi.fn();
    const debug: string[] = [];
    const page = { on, off } as unknown as Page;
    const observation = observeBestadoLoginResponses(page, debug);
    const listener = on.mock.calls[0][1] as (response: HTTPResponse) => void;
    const response = (url: string): HTTPResponse =>
      ({
        url: () => url,
        request: () => ({ method: () => 'POST' }),
        status: () => 403,
      }) as unknown as HTTPResponse;
    listener(response('https://www.bancoestado.cl/telemetry'));
    listener(
      response('https://www.bancoestado.cl/bff/v1/claveinternet-web-bff/loginbff?token=secret'),
    );
    expect(debug).toEqual(['  BancoEstado authentication response: HTTP 403']);
    expect(observation.status).toBe(403);
    observation.stop();
    expect(off).toHaveBeenCalledWith('response', listener);
  });
});
