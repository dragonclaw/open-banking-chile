import type { Page } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import falabella, {
  advanceFalabellaPasswordStepIfNeeded,
  classifyFalabellaLoginSnapshot,
  clickFirstBannerCandidateInViewport,
  dismissFalabellaPointsModal,
  isElementBoxInViewport,
  navigateToFalabellaHomepage,
  normalizeFalabellaRut,
  redactSensitiveInputValues,
} from "./falabella.js";

function createFalabellaPointsModalPage(visibleChecksBeforeGone: number) {
  let visibleChecks = 0;
  const click = vi.fn().mockResolvedValue(undefined);
  const closeButtonWaitFor = vi.fn().mockImplementation(async (options: { state: string }) => {
    if (options.state !== "visible") return;
    visibleChecks += 1;
    if (visibleChecks > visibleChecksBeforeGone) {
      throw new Error("hidden");
    }
  });
  const closeButton = {
    click,
    first: vi.fn(),
    isVisible: vi.fn().mockImplementation(async () => {
      visibleChecks += 1;
      return visibleChecks <= visibleChecksBeforeGone;
    }),
    waitFor: closeButtonWaitFor,
  };
  closeButton.first.mockReturnValue(closeButton);
  const modalWaitFor = vi.fn().mockResolvedValue(undefined);
  const modalLocator = {
    first: vi.fn(),
    locator: vi.fn().mockReturnValue(closeButton),
    waitFor: modalWaitFor,
  };
  modalLocator.first.mockReturnValue(modalLocator);
  const pageLocator = vi.fn().mockReturnValue(modalLocator);

  return { click, closeButton, modalLocator, modalWaitFor, pageLocator };
}

describe("Banco Falabella login helpers", () => {
  it("does not launch Playwright when cancellation was already requested", async () => {
    const abortController = new AbortController();
    abortController.abort();

    await expect(
      falabella.scrape({
        password: "secret",
        rut: "11111111-1",
        signal: abortController.signal,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        error: "Sincronización cancelada por el usuario.",
        success: false,
      }),
    );
  });

  it("closes the CMR Puntos opt-in modal without accepting its terms", async () => {
    const { click, modalLocator, modalWaitFor, pageLocator } = createFalabellaPointsModalPage(1);
    const debugLog: string[] = [];

    const dismissed = await dismissFalabellaPointsModal(
      { locator: pageLocator } as unknown as Page,
      debugLog,
    );

    expect(dismissed).toBe(true);
    expect(pageLocator).toHaveBeenCalledWith(
      ".modal-content-secretobancario-container",
    );
    expect(modalLocator.locator).toHaveBeenCalledWith(
      "button.close-misdocumentos",
    );
    expect(click).toHaveBeenCalledOnce();
    expect(modalWaitFor).toHaveBeenCalledWith({
      state: "hidden",
      timeout: 5_000,
    });
    expect(debugLog).toContain("  Closed CMR Puntos opt-in modal");
  });

  it("closes the CMR Puntos modal again when it reappears after a tab change", async () => {
    const { click, pageLocator } = createFalabellaPointsModalPage(2);
    const debugLog: string[] = [];

    const dismissed = await dismissFalabellaPointsModal(
      { locator: pageLocator } as unknown as Page,
      debugLog,
    );

    expect(dismissed).toBe(true);
    expect(click).toHaveBeenCalledTimes(2);
    expect(debugLog).toContain("  Closed CMR Puntos opt-in modal");
    expect(debugLog).toContain("  Closed CMR Puntos opt-in modal again");
  });

  it("probes the CMR Puntos modal without waiting when waitMs is 0", async () => {
    const { click, closeButton, pageLocator } = createFalabellaPointsModalPage(0);

    const dismissed = await dismissFalabellaPointsModal(
      { locator: pageLocator } as unknown as Page,
      [],
      { waitMs: 0 },
    );

    expect(dismissed).toBe(false);
    expect(closeButton.isVisible).toHaveBeenCalledOnce();
    expect(closeButton.waitFor).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });

  it("loads the homepage without waiting for global network idle", async () => {
    const goto = vi.fn().mockResolvedValue(null);

    await navigateToFalabellaHomepage({ goto } as unknown as Page);

    expect(goto).toHaveBeenCalledTimes(1);
    expect(goto.mock.calls[0]?.[1]).toEqual({
      timeout: 20_000,
      waitUntil: "domcontentloaded",
    });
  });

  it.each([
    ["12.345.678-5", "123456785"],
    ["12345678-5", "123456785"],
    ["12 345 678-k", "12345678K"],
  ])("normalizes RUT %s for the current input", (rut, expected) => {
    expect(normalizeFalabellaRut(rut)).toBe(expected);
  });

  it("recognizes only boxes intersecting the viewport", () => {
    const viewport = { height: 900, width: 1280 };

    expect(
      isElementBoxInViewport(
        { height: 56, width: 172, x: 732, y: -881 },
        viewport,
      ),
    ).toBe(false);
    expect(
      isElementBoxInViewport(
        { height: 48, width: 97, x: 524, y: 824 },
        viewport,
      ),
    ).toBe(true);
  });

  it("skips an offscreen cookie control and clicks the in-viewport duplicate", async () => {
    const hiddenClick = vi.fn().mockResolvedValue(undefined);
    const visibleClick = vi.fn().mockResolvedValue(undefined);

    const clicked = await clickFirstBannerCandidateInViewport(
      [
        {
          boundingBox: vi
            .fn()
            .mockResolvedValue({ height: 56, width: 172, x: 732, y: -881 }),
          click: hiddenClick,
        },
        {
          boundingBox: vi
            .fn()
            .mockResolvedValue({ height: 48, width: 97, x: 524, y: 824 }),
          click: visibleClick,
        },
      ],
      { height: 900, width: 1280 },
    );

    expect(clicked).toBe(true);
    expect(hiddenClick).not.toHaveBeenCalled();
    expect(visibleClick).toHaveBeenCalledOnce();
  });

  it("does not press Enter when the one-step password field is already visible", async () => {
    const waitFor = vi.fn().mockResolvedValue(undefined);
    const press = vi.fn().mockResolvedValue(undefined);

    const advanced = await advanceFalabellaPasswordStepIfNeeded(
      { waitFor },
      { press },
    );

    expect(advanced).toBe(false);
    expect(press).not.toHaveBeenCalled();
    expect(waitFor).toHaveBeenCalledOnce();
  });

  it("uses Enter only as a fallback for the legacy two-step form", async () => {
    const waitFor = vi
      .fn()
      .mockRejectedValueOnce(new Error("Password field is not visible"))
      .mockResolvedValueOnce(undefined);
    const press = vi.fn().mockResolvedValue(undefined);

    const advanced = await advanceFalabellaPasswordStepIfNeeded(
      { waitFor },
      { press },
    );

    expect(advanced).toBe(true);
    expect(press).toHaveBeenCalledWith("Enter");
    expect(waitFor).toHaveBeenCalledTimes(2);
  });

  it("fails when the password control is still missing after the legacy fallback", async () => {
    const waitFor = vi.fn().mockRejectedValue(new Error("Password field is missing"));
    const press = vi.fn().mockResolvedValue(undefined);

    await expect(
      advanceFalabellaPasswordStepIfNeeded({ waitFor }, { press }),
    ).rejects.toThrow("Password field is missing");
    expect(press).toHaveBeenCalledWith("Enter");
    expect(waitFor).toHaveBeenCalledTimes(2);
  });

  it("classifies 2FA before an authenticated shell", () => {
    expect(
      classifyFalabellaLoginSnapshot({
        bodyText: "Debes ingresar tu clave dinámica",
        hasAuthenticatedRoot: true,
        hasLoginForm: false,
        pathname: "/web-clientes/",
        visibleErrors: [],
      }),
    ).toEqual({ status: "two_factor" });
  });

  it("returns a visible bank error while the login form remains open", () => {
    expect(
      classifyFalabellaLoginSnapshot({
        bodyText: "RUT Clave internet",
        hasAuthenticatedRoot: false,
        hasLoginForm: true,
        pathname: "/",
        visibleErrors: ["RUT o clave incorrectos"],
      }),
    ).toEqual({
      message: "RUT o clave incorrectos",
      status: "error",
    });
  });

  it.each([
    {
      bodyText: "",
      hasAuthenticatedRoot: false,
      hasLoginForm: false,
      pathname: "/web-clientes/",
      visibleErrors: [],
    },
    {
      bodyText: "",
      hasAuthenticatedRoot: true,
      hasLoginForm: false,
      pathname: "/",
      visibleErrors: [],
    },
  ])("recognizes an authenticated dashboard", (snapshot) => {
    expect(classifyFalabellaLoginSnapshot(snapshot)).toEqual({
      status: "authenticated",
    });
  });

  it("keeps waiting when no login outcome is present", () => {
    expect(
      classifyFalabellaLoginSnapshot({
        bodyText: "RUT Clave internet",
        hasAuthenticatedRoot: false,
        hasLoginForm: true,
        pathname: "/",
        visibleErrors: [],
      }),
    ).toBeNull();
  });

  it("ignores the homepage anti-fraud warning while the login form is present", () => {
    expect(
      classifyFalabellaLoginSnapshot({
        bodyText: "Nunca te pediremos tu clave dinámica",
        hasAuthenticatedRoot: false,
        hasLoginForm: true,
        pathname: "/",
        visibleErrors: [],
      }),
    ).toBeNull();
  });

  it("redacts credentials from saved login HTML", () => {
    const html = [
      '<input id="document" type="text" value="12345678-9">',
      '<input value="secret" name="pass" type="password">',
      '<input id="search" type="text" value="visible">',
    ].join("");

    expect(redactSensitiveInputValues(html)).toBe(
      [
        '<input id="document" type="text" value="[REDACTED]">',
        '<input value="[REDACTED]" name="pass" type="password">',
        '<input id="search" type="text" value="visible">',
      ].join(""),
    );
  });
});
