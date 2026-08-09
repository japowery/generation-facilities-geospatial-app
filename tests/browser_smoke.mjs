#!/usr/bin/env node
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const EXPECTED = Object.freeze({
  facilityCount: 15_887,
  mappedFacilityCount: 15_876,
  generatorCount: 34_894,
  activeGeneratorCount: 27_768,
  retiredGeneratorCount: 7_126,
});
const VIEWPORTS = Object.freeze([
  { width: 390, height: 844 },
  { width: 768, height: 900 },
  { width: 1280, height: 800 },
  { width: 1600, height: 900 },
]);

const MIME_TYPES = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
});

const NEUTRAL_TILE = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">'
  + '<rect width="256" height="256" fill="#aebdca"/></svg>',
  "utf-8",
);

function createStaticServer() {
  return createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
      if (requestUrl.pathname === "/favicon.ico") {
        response.writeHead(204);
        response.end();
        return;
      }

      const decodedPath = decodeURIComponent(requestUrl.pathname);
      const relativePath = decodedPath === "/" ? "index.html" : decodedPath.slice(1);
      const filePath = resolve(join(REPOSITORY_ROOT, relativePath));
      const repositoryPrefix = `${REPOSITORY_ROOT}${sep}`;
      if (filePath !== REPOSITORY_ROOT && !filePath.startsWith(repositoryPrefix)) {
        response.writeHead(403);
        response.end("Forbidden");
        return;
      }
      const fileStats = await stat(filePath);
      if (!fileStats.isFile()) throw new Error("Not a file");
      const body = await readFile(filePath);
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Length": body.length,
        "Content-Type": MIME_TYPES[extname(filePath)] || "application/octet-stream",
      });
      response.end(body);
    } catch {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
    }
  });
}

async function listen(server) {
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => error ? rejectPromise(error) : resolvePromise());
  });
}

async function waitForReady(page) {
  await page.locator('#app[aria-busy="false"]').waitFor({ timeout: 30_000 });
  assert.equal(await page.locator("#fatalError").isHidden(), true, "fatal error overlay is visible");
}

async function assertCorrectedDefaults(page) {
  const metadata = await page.evaluate(() => ({
    facilityCount: window.GENERATION_DATA?.metadata?.facilityCount,
    mappedFacilityCount: window.GENERATION_DATA?.metadata?.mappedFacilityCount,
    generatorCount: window.GENERATION_DATA?.metadata?.generatorCount,
    activeGeneratorCount: window.GENERATION_DATA?.metadata?.activeGeneratorCount,
    retiredGeneratorCount: window.GENERATION_DATA?.metadata?.retiredGeneratorCount,
  }));
  assert.deepEqual(metadata, EXPECTED, "bundled metadata does not match the corrected snapshot");
  assert.equal(
    (await page.locator("#facilityCountKpi").textContent())?.trim(),
    "15,887",
    "default facility KPI is incorrect",
  );
  assert.equal(
    (await page.locator("#generatorCountKpi").textContent())?.trim(),
    "34,894",
    "default generator KPI is incorrect",
  );
}

async function assertChartData(page) {
  const chartData = await page.evaluate(() => {
    const technology = window.Chart?.getChart(document.getElementById("technologyChart"));
    const state = window.Chart?.getChart(document.getElementById("stateChart"));
    return {
      technologyLabels: technology?.data?.labels || [],
      technologyValues: technology?.data?.datasets?.[0]?.data || [],
      stateLabels: state?.data?.labels || [],
      stateValues: state?.data?.datasets?.[0]?.data || [],
    };
  });
  assert(chartData.technologyLabels.length > 0, "technology chart has no labels");
  assert.equal(
    chartData.technologyLabels.length,
    chartData.technologyValues.length,
    "technology chart labels and values do not align",
  );
  assert(
    chartData.technologyLabels.includes("Natural Gas Fired Combined Cycle"),
    "expected leading technology is absent from the chart",
  );
  assert(chartData.stateLabels.includes("TX"), "Texas is absent from the state chart");
  assert.equal(
    chartData.stateLabels.length,
    chartData.stateValues.length,
    "state chart labels and values do not align",
  );
}

async function assertMapEncoding(page) {
  const overviewLegend = (await page.locator("#legendContent").textContent()) || "";
  assert(
    overviewLegend.includes("Nearby facilities grouped at this zoom"),
    "national map does not explain its aggregated facility display",
  );
  assert(
    overviewLegend.includes("Facilities in each cluster"),
    "national cluster-size encoding is missing or inaccurate",
  );
  assert(
    await page.locator(".facility-cluster-count").count() > 0,
    "national map does not display cluster counts",
  );

  for (let index = 0; index < 3; index += 1) {
    await page.locator("#zoomInBtn").click();
    await page.waitForTimeout(400);
  }
  await page.waitForFunction(
    () => document.querySelector("#legendContent")?.textContent?.includes("One marker per mapped facility"),
    null,
    { timeout: 3_000 },
  );
  const detailedLegend = (await page.locator("#legendContent").textContent()) || "";
  assert(
    detailedLegend.includes("One marker per mapped facility"),
    "zoomed map does not resolve clusters into facility markers",
  );
  assert(
    detailedLegend.includes("Filtered nameplate MW"),
    "zoomed facility-size encoding is missing or inaccurate",
  );
  await page.locator("#zoomHomeBtn").click();
  await page.waitForTimeout(400);
}

async function exerciseTabsListAndDetail(page) {
  await page.locator("#facilitiesTab").click();
  assert.equal(await page.locator("#facilitiesView").isVisible(), true, "Facilities tab did not open");
  const firstFacility = page.locator(".facility-row").first();
  await firstFacility.waitFor();
  await firstFacility.click();
  assert.equal(
    await page.locator("#detailDrawer").evaluate((element) => element.classList.contains("open")),
    true,
    "facility detail drawer did not open",
  );
  assert((await page.locator("#detailContent h2").textContent())?.trim(), "detail title is empty");
  assert(
    await page.locator("#detailContent .generator-table tbody tr").count() > 0,
    "facility detail has no generator rows",
  );
  assert(
    (await page.locator(".table-scroll-hint").textContent())?.includes("Scroll horizontally"),
    "wide generator table lacks a horizontal-scroll affordance",
  );
  await page.locator("#detailCloseBtn").click();

  await page.locator("#dataTab").click();
  assert.equal(await page.locator("#dataView").isVisible(), true, "Data tab did not open");
  await page.locator("#overviewTab").click();
  assert.equal(await page.locator("#overviewView").isVisible(), true, "Overview tab did not reopen");
}

async function exerciseTheme(page) {
  const before = await page.locator("html").getAttribute("data-theme");
  await page.locator("#themeBtn").click();
  const after = await page.locator("html").getAttribute("data-theme");
  assert.notEqual(after, before, "theme did not change");
  assert.equal(
    await page.evaluate(() => localStorage.getItem("generation-intelligence-theme")),
    after,
    "theme preference was not persisted",
  );
}

async function exerciseHashRecovery(page, baseUrl) {
  await page.evaluate(() => {
    location.hash = "state=TX";
  });
  await page.waitForFunction(
    () => document.querySelector("#facilityCountKpi")?.textContent?.trim() === "1,165",
    null,
    { timeout: 3_000 },
  );
  assert.equal(
    (await page.locator("#stateFilter .multi-select-button span").textContent())?.trim(),
    "TX",
    "same-document shared hash did not update the State control",
  );
  await page.evaluate(() => {
    location.hash = "";
  });
  await page.waitForFunction(
    () => document.querySelector("#facilityCountKpi")?.textContent?.trim() === "15,887",
    null,
    { timeout: 3_000 },
  );

  await page.goto(`${baseUrl}/#tech=%`, { waitUntil: "domcontentloaded" });
  await waitForReady(page);
  assert.equal(await page.locator("#fatalError").isHidden(), true, "malformed hash caused fatal boot");

  await page.goto(
    `${baseUrl}/#year=2026-1900&mw=7000-0`,
    { waitUntil: "domcontentloaded" },
  );
  await waitForReady(page);
  const ranges = await page.evaluate(() => ({
    yearMin: Number(document.getElementById("operatingYearMinInput").value),
    yearMax: Number(document.getElementById("operatingYearMaxInput").value),
    mwMin: Number(document.getElementById("capacityMinInput").value),
    mwMax: Number(document.getElementById("capacityMaxInput").value),
  }));
  assert(ranges.yearMin <= ranges.yearMax, "reversed year hash was not normalized");
  assert(ranges.mwMin <= ranges.mwMax, "reversed capacity hash was not normalized");
  assert(
    Number((await page.locator("#facilityCountKpi").textContent())?.replaceAll(",", "")) > 0,
    "normalized reversed ranges produced no facilities",
  );
}

async function exerciseMobilePanel(page, baseUrl) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForReady(page);

  const trigger = page.locator("#filtersMobileBtn");
  const panel = page.locator("#filterPanel");
  const scrim = page.locator("#mobileScrim");
  await trigger.click();
  assert.equal(await panel.evaluate((element) => element.classList.contains("mobile-open")), true);
  assert.equal(await scrim.evaluate((element) => element.classList.contains("show")), true);
  assert.equal(await trigger.getAttribute("aria-expanded"), "true");
  assert.equal(await page.locator(".topbar").evaluate((element) => element.inert), true);
  await page.locator("#exportBtn").focus();
  await page.keyboard.press("Tab");
  assert.equal(
    await page.evaluate(() => document.querySelector("#filterPanel").contains(document.activeElement)),
    true,
    "filter drawer allowed focus to escape",
  );

  await page.locator('[data-close-panel="filterPanel"]').click();
  assert.equal(await panel.evaluate((element) => element.classList.contains("mobile-open")), false);
  assert.equal(await scrim.evaluate((element) => element.classList.contains("show")), false);
  assert.equal(await trigger.getAttribute("aria-expanded"), "false");
  assert.equal(await page.locator(".topbar").evaluate((element) => element.inert), false);

  await page.locator("#insightsMobileBtn").click();
  await page.locator("#overviewView").focus();
  await page.keyboard.press("Tab");
  assert.equal(
    await page.evaluate(() => document.querySelector("#insightsPanel").contains(document.activeElement)),
    true,
    "insights drawer allowed focus to escape",
  );
  await page.locator('[data-close-panel="insightsPanel"]').click();

  await trigger.click();
  await page.mouse.click(388, 420);
  assert.equal(await panel.evaluate((element) => element.classList.contains("mobile-open")), false);
  assert.equal(await scrim.evaluate((element) => element.classList.contains("show")), false);
}

async function assertResponsiveOverflow(page) {
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(100);
    const geometry = await page.evaluate(() => ({
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      topbar: (() => {
        const rect = document.querySelector(".topbar").getBoundingClientRect();
        return { left: rect.left, right: rect.right };
      })(),
    }));
    assert(
      geometry.documentWidth <= geometry.viewportWidth + 1,
      `${viewport.width}px viewport has document overflow: ${geometry.documentWidth}px`,
    );
    assert(
      geometry.bodyWidth <= geometry.viewportWidth + 1,
      `${viewport.width}px viewport has body overflow: ${geometry.bodyWidth}px`,
    );
    assert(
      geometry.topbar.left >= -1 && geometry.topbar.right <= geometry.viewportWidth + 1,
      `${viewport.width}px viewport clips the topbar`,
    );
  }
}

async function main() {
  const server = createStaticServer();
  const unexpectedExternalRequests = [];
  const browserErrors = [];
  let browser;

  try {
    const baseUrl = await listen(server);
    const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined;
    const extraArgs = process.env.PLAYWRIGHT_EXTRA_ARGS
      ? JSON.parse(process.env.PLAYWRIGHT_EXTRA_ARGS)
      : undefined;
    browser = await chromium.launch({
      headless: true,
      executablePath,
      args: extraArgs,
    });
    const context = await browser.newContext({
      viewport: { width: 1600, height: 900 },
      reducedMotion: "reduce",
    });
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin === new URL(baseUrl).origin) {
        await route.continue();
        return;
      }
      if (
        url.protocol === "https:"
        && /^[a-d]\.basemaps\.cartocdn\.com$/.test(url.hostname)
      ) {
        await route.fulfill({ body: NEUTRAL_TILE, contentType: "image/svg+xml" });
        return;
      }
      unexpectedExternalRequests.push(url.href);
      await route.abort("blockedbyclient");
    });

    const page = await context.newPage();
    page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
    });

    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await waitForReady(page);
    await assertCorrectedDefaults(page);
    await assertChartData(page);
    await assertMapEncoding(page);
    await exerciseTabsListAndDetail(page);
    await exerciseTheme(page);
    await exerciseHashRecovery(page, baseUrl);
    await exerciseMobilePanel(page, baseUrl);
    await assertResponsiveOverflow(page);

    assert.deepEqual(
      unexpectedExternalRequests,
      [],
      `unexpected external requests: ${unexpectedExternalRequests.join(", ")}`,
    );
    assert.deepEqual(browserErrors, [], `browser errors:\n${browserErrors.join("\n")}`);
    await context.close();
    console.log(
      `Browser smoke passed: corrected KPIs, charts, tabs/detail, theme, hash recovery, `
      + `map aggregation, mobile panel, and ${VIEWPORTS.length} responsive widths.`,
    );
  } finally {
    if (browser) await browser.close();
    await closeServer(server);
  }
}

main().catch((error) => {
  const path = relative(process.cwd(), fileURLToPath(import.meta.url));
  console.error(`${path} failed: ${error.stack || error}`);
  process.exitCode = 1;
});
