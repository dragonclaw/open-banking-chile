import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyScotiabankAuthCallback,
  findCachedChromeForTesting,
  formatScotiabankRut,
  isScotiabankDashboardUrl,
  normalizeScotiabankFingerprint,
  parseScotiabankChromeVersion,
  resolveScotiabankChrome,
  resolveScotiabankProfileDirectory,
} from "./scotiabank-auth.js";

let tempRoot = "";

afterEach(() => {
  if (tempRoot) {
    fs.rmSync(tempRoot, { force: true, recursive: true });
    tempRoot = "";
  }
});

describe("classifyScotiabankAuthCallback", () => {
  it("classifies the auth callback status", () => {
    expect(classifyScotiabankAuthCallback(200)).toBe("accepted");
    expect(classifyScotiabankAuthCallback(401)).toBe("credentials_rejected");
    expect(classifyScotiabankAuthCallback(403)).toBe("blocked");
    expect(classifyScotiabankAuthCallback(500)).toBe("unexpected");
  });
});

describe("resolveScotiabankChrome", () => {
  it("uses an explicit Chrome path first", async () => {
    await expect(resolveScotiabankChrome(process.execPath)).resolves.toBe(
      process.execPath,
    );
  });
});

describe("findCachedChromeForTesting", () => {
  it("picks the newest Chrome for Testing binary in the cache", () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "scotia-chrome-"));
    const older = path.join(
      tempRoot,
      "chrome",
      "linux-145.0.7632.77",
      "chrome-linux64",
    );
    const newer = path.join(
      tempRoot,
      "chrome",
      "linux-152.0.7977.75",
      "chrome-linux64",
    );
    fs.mkdirSync(older, { recursive: true });
    fs.mkdirSync(newer, { recursive: true });
    fs.writeFileSync(path.join(older, "chrome"), "");
    const newestChrome = path.join(newer, "chrome");
    fs.writeFileSync(newestChrome, "");

    expect(findCachedChromeForTesting([tempRoot])).toBe(newestChrome);
  });
});

describe("resolveScotiabankProfileDirectory", () => {
  it("uses a local persistent profile by default", () => {
    expect(resolveScotiabankProfileDirectory()).toBe(
      path.resolve(".browser-profiles", "scotiabank"),
    );
  });

  it("resolves a configured directory", () => {
    expect(resolveScotiabankProfileDirectory("tmp/scotia-profile")).toBe(
      path.resolve("tmp/scotia-profile"),
    );
  });
});

describe("formatScotiabankRut", () => {
  it("formats a clean RUT with a dash", () => {
    expect(formatScotiabankRut("123456789")).toBe("12345678-9");
    expect(formatScotiabankRut("12.345.678-9")).toBe("12345678-9");
  });
});

describe("isScotiabankDashboardUrl", () => {
  it("detects the authenticated home MFE", () => {
    expect(
      isScotiabankDashboardUrl(
        "https://banco.scotiabank.cl/mfe-home-cl/dashboard",
      ),
    ).toBe(true);
    expect(
      isScotiabankDashboardUrl(
        "https://banco.scotiabank.cl/mfe-login/personas",
      ),
    ).toBe(false);
  });
});

describe("parseScotiabankChromeVersion", () => {
  it("reads a full Chrome version string", () => {
    expect(parseScotiabankChromeVersion("Chrome/131.0.6778.85")).toEqual({
      full: "131.0.6778.85",
      major: "131",
    });
  });

  it("falls back when the version is missing", () => {
    expect(parseScotiabankChromeVersion("Chrome")).toEqual({
      full: "152.0.0.0",
      major: "152",
    });
  });
});

describe("normalizeScotiabankFingerprint", () => {
  it("rewrites browser and device fields to a Windows profile", () => {
    const encoded = Buffer.from(
      JSON.stringify({
        Browser: {
          browserMajor: "1",
          browserVersion: "1.0.0.0",
          osName: "Linux",
          osVersion: "6",
          userAgent: "old",
        },
        General: {
          availableResolution: "1x1",
          deviceMemory: "4",
          hardwareConcurrency: "2",
          language: "es",
          navigatorPlatform: "Linux x86_64",
          rendererVideo: "llvmpipe",
          resolution: "1x1",
          vendorWebGL: "0",
        },
        Personalization: { numberFonts: "1", numberPlugins: "0" },
      }),
      "utf8",
    ).toString("base64");

    const normalized = JSON.parse(
      Buffer.from(normalizeScotiabankFingerprint(encoded, "131.0.6778.85"), "base64").toString(
        "utf8",
      ),
    ) as {
      Browser: { osName: string; browserMajor: string; browserVersion: string };
      General: { navigatorPlatform: string; language: string };
      Personalization: { numberFonts: string };
    };

    expect(normalized.Browser.osName).toBe("Windows");
    expect(normalized.Browser.browserMajor).toBe("131");
    expect(normalized.Browser.browserVersion).toBe("131.0.6778.85");
    expect(normalized.General.navigatorPlatform).toBe("Win32");
    expect(normalized.General.language).toBe("en-CL");
    expect(normalized.Personalization.numberFonts).toBe("33");
  });

  it("returns the original payload when the fingerprint is invalid", () => {
    expect(normalizeScotiabankFingerprint("not-valid-base64")).toBe(
      "not-valid-base64",
    );
  });
});
