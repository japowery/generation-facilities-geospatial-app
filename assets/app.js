(() => {
  "use strict";

  const DATA = window.GENERATION_DATA;
  const $ = (id) => document.getElementById(id);
  const app = $("app");
  const loadingScreen = $("loadingScreen");
  const loadingMessage = $("loadingMessage");
  const loadingProgress = $("loadingProgress");
  const fatalError = $("fatalError");
  const fatalErrorMessage = $("fatalErrorMessage");

  const F = Object.freeze({
    ID: 0, ENTITY: 1, NAME: 2, STATE: 3, COUNTY: 4, SECTOR: 5,
    LAT: 6, LON: 7, START: 8, COUNT: 9,
  });
  const G = Object.freeze({
    ID: 0, NAMEPLATE: 1, SUMMER: 2, WINTER: 3, TECH: 4, ENERGY: 5,
    PRIME: 6, OP_MONTH: 7, OP_YEAR: 8, RET_MONTH: 9, RET_YEAR: 10,
    STATUS: 11, SOURCE: 12,
  });

  const sourceLabels = ["Active", "Retired"];
  const markerRenderer = window.L ? L.canvas({ padding: 0.5, tolerance: 5 }) : null;
  const dictionaries = DATA?.dictionaries || {};
  const rawFacilities = DATA?.facilities || [];
  const rawGenerators = DATA?.generators || [];
  const metadata = DATA?.metadata || {};
  const metadataInteger = (key, fallback) => {
    const value = Number(metadata[key]);
    return Number.isInteger(value) ? value : fallback;
  };
  const APP_CONFIG = Object.freeze({
    asOfYear: metadataInteger("asOfYear", 2026),
    retirementKpiEndYear: Math.max(metadataInteger("asOfYear", 2026), metadataInteger("retirementKpiEndYear", 2035)),
    retirementChartEndYear: Math.max(metadataInteger("asOfYear", 2026), metadataInteger("retirementChartEndYear", 2050)),
    facilityPageSize: Math.max(1, metadataInteger("facilityPageSize", 25)),
  });

  let map;
  let lightTiles;
  let darkTiles;
  let activeTiles;
  let markerLayer;
  let heatLayer;
  let facilityModels = [];
  let markers = [];
  let visibleFacilities = [];
  let visibleByIndex = new Map();
  let lastAggregate = null;
  let renderTimer = null;
  let toastTimer = null;
  let currentDetailIndex = null;
  let currentPage = 1;
  let currentTab = "overview";
  let legendExpanded = true;
  let legendUserToggled = false;
  let detailReturnFocus = null;
  let mobilePanelReturnFocus = null;
  let moreMenuOpen = false;
  let chartFailureMessage = "";
  let tileFailureNotified = false;
  let lastAnnouncement = "";
  let lastHandledNavigationHash = null;
  let mapLegendTechnologies = new Set();
  const hashWarnings = new Set();
  const OTHER_MAP_COLOR = "#7d8b9b";

  const charts = {};
  const controls = {};
  const filterOverlayLayout = typeof window.matchMedia === "function" ? window.matchMedia("(max-width: 1023px)") : null;
  const insightsOverlayLayout = typeof window.matchMedia === "function" ? window.matchMedia("(max-width: 1279px)") : null;
  const mobileLayout = typeof window.matchMedia === "function" ? window.matchMedia("(max-width: 760px)") : null;
  let previousMobileMapLayout = Boolean(mobileLayout?.matches);

  const filters = {
    active: true,
    retired: true,
    search: "",
    technologies: new Set(),
    states: new Set(),
    sectors: new Set(),
    operatingYearMin: 1900,
    operatingYearMax: 2026,
    capacityMin: 0,
    capacityMax: 7000,
    heat: false,
    scaleDots: true,
  };

  const universe = {
    technologies: [],
    states: [],
    sectors: [],
    operatingYearMin: 1900,
    operatingYearMax: 2026,
    capacityMax: 7000,
  };

  const numberFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
  const oneDecimalFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
  const compactFormatter = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

  function setLoading(percent, message) {
    const bounded = Math.max(0, Math.min(100, percent));
    loadingProgress.style.width = `${bounded}%`;
    loadingProgress.parentElement?.setAttribute("aria-valuenow", String(Math.round(bounded)));
    if (message) loadingMessage.textContent = message;
  }

  function fail(message, error) {
    console.error(message, error || "");
    loadingScreen.classList.add("hidden");
    fatalError.hidden = false;
    fatalErrorMessage.textContent = message;
    setTimeout(() => focusElement($("retryBtn")), 0);
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
    }[character]));
  }

  function normalize(value) {
    return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  }

  function finite(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function fmt(value, decimals = 0) {
    if (!finite(value)) return "—";
    return decimals ? oneDecimalFormatter.format(value) : numberFormatter.format(Math.round(value));
  }

  function fmtMw(value) {
    if (!finite(value)) return "—";
    return `${value >= 10000 ? compactFormatter.format(value) : fmt(value, value < 100 ? 1 : 0)} MW`;
  }

  function fmtDateTime(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function sumMap(target, source) {
    for (const [key, value] of source) target.set(key, (target.get(key) || 0) + value);
  }

  function topEntries(mapValue, limit = 10) {
    return [...mapValue.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  }

  function hashHue(text) {
    let hash = 2166136261;
    const value = String(text || "Unknown");
    for (let i = 0; i < value.length; i += 1) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function technologyColor(technology) {
    const value = normalize(technology);
    if (value.includes("solar")) return "#f5c451";
    if (value.includes("wind")) return "#43c8d8";
    if (value.includes("hydro") || value.includes("water")) return "#4b91f1";
    if (value.includes("natural gas") || value === "other natural gas") return "#ff9d5c";
    if (value.includes("coal")) return "#8793a2";
    if (value.includes("petroleum") || value.includes("oil")) return "#ef6875";
    if (value.includes("nuclear")) return "#b38cff";
    if (value.includes("batter")) return "#5dd39e";
    if (value.includes("geothermal")) return "#e47bd0";
    if (value.includes("biomass") || value.includes("wood") || value.includes("landfill")) return "#79c267";
    const hue = hashHue(technology) % 360;
    return `hsl(${hue} 62% 58%)`;
  }

  function technologyGroup(name) {
    const value = normalize(name);
    if (
      value.includes("batter")
      || value.includes("pumped storage")
      || value.includes("flywheel")
      || value.includes("compressed air storage")
    ) return "storage";
    if (["solar", "wind", "hydro", "geothermal", "biomass", "wood", "landfill", "municipal solid waste"].some((token) => value.includes(token))) return "renewables";
    if (["natural gas", "coal", "petroleum", "oil", "other gases"].some((token) => value.includes(token))) return "fossil";
    if (value.includes("nuclear")) return "nuclear";
    return "other";
  }

  function roundCapacityMax(value) {
    if (value <= 100) return Math.ceil(value / 10) * 10;
    if (value <= 1000) return Math.ceil(value / 100) * 100;
    return Math.ceil(value / 500) * 500;
  }


  function storageGet(key) {
    try { return window.localStorage.getItem(key); } catch (_) { return null; }
  }

  function storageSet(key, value) {
    try { window.localStorage.setItem(key, value); } catch (_) { /* storage can be unavailable in hardened or opaque contexts */ }
  }

  function replaceUrl(url) {
    try { history.replaceState(null, "", url); } catch (_) { /* URL state is optional in restricted file contexts */ }
  }

  function showToast(message) {
    const toast = $("toast");
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 2400);
  }

  function isFocusable(element) {
    return element instanceof HTMLElement
      && element.isConnected
      && !element.hasAttribute("disabled")
      && element.getAttribute("aria-hidden") !== "true";
  }

  function focusElement(element) {
    if (!isFocusable(element)) return;
    try { element.focus({ preventScroll: true }); } catch (_) { element.focus(); }
  }

  function applyThemeMetadata(theme) {
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#09111f" : "#edf2f7");
    $("themeBtn")?.setAttribute("aria-pressed", String(theme === "light"));
    $("moreThemeBtn")?.setAttribute("data-active-theme", theme);
  }

  function setBasemapStatus(message = "") {
    const status = $("basemapStatus");
    if (!status) return;
    const label = activeTiles === darkTiles ? "Dark basemap selected" : "Light basemap selected";
    status.textContent = message || label;
  }

  function setChartEmptyState(name, empty, message = "No data in the current selection") {
    document.querySelectorAll("[data-chart-empty]").forEach((node) => {
      const declared = node.dataset.chartEmpty;
      const canvasId = node.closest(".chart-card")?.querySelector("canvas")?.id;
      const matches = !declared
        ? canvasId === `${name}Chart`
        : [name, `${name}Chart`].includes(declared);
      if (!matches) return;
      node.hidden = !empty;
      node.classList.toggle("show", empty);
      node.setAttribute("aria-hidden", String(!empty));
      const canvas = node.closest(".chart-wrap")?.querySelector("canvas");
      canvas?.setAttribute("aria-hidden", String(empty));
      if (empty && (!node.textContent.trim() || chartFailureMessage)) node.textContent = message;
    });
  }

  function announceResults(aggregate) {
    const announcer = $("resultsAnnouncer");
    if (!announcer) return;
    const message = visibleFacilities.length
      ? `${fmt(visibleFacilities.length)} facilities, ${fmt(aggregate.generatorCount)} generators, ${fmtMw(aggregate.capacity)} in the current selection.`
      : "No facilities match the current filters.";
    if (message === lastAnnouncement) return;
    lastAnnouncement = message;
    announcer.textContent = message;
  }

  class MultiSelect {
    constructor(element, { label, items, selected, onChange }) {
      this.element = element;
      this.label = label;
      this.items = items;
      this.selected = new Set(selected);
      this.onChange = onChange;
      this.searchTerm = "";
      this.renderShell();
      this.renderOptions();
      this.updateButton();
    }

    renderShell() {
      const menuId = `${this.element.id || `multi-${this.label.toLowerCase().replace(/\W+/g, "-")}`}-menu`;
      this.element.innerHTML = `
        <button class="multi-select-button" type="button" aria-haspopup="listbox" aria-expanded="false" aria-controls="${escapeHtml(menuId)}">
          <span></span>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 9 5 5 5-5"/></svg>
        </button>
        <div class="multi-select-menu" id="${escapeHtml(menuId)}" aria-hidden="true">
          <input class="multi-search" type="search" placeholder="Search ${escapeHtml(this.label.toLowerCase())}…" aria-label="Search ${escapeHtml(this.label.toLowerCase())}">
          <div class="multi-actions"><button type="button" data-action="all">Select all</button><button type="button" data-action="none">Clear</button></div>
          <div class="multi-options" role="listbox" aria-multiselectable="true"></div>
        </div>`;
      this.button = this.element.querySelector(".multi-select-button");
      this.menu = this.element.querySelector(".multi-select-menu");
      this.search = this.element.querySelector(".multi-search");
      this.optionsElement = this.element.querySelector(".multi-options");

      this.button.addEventListener("click", (event) => {
        event.stopPropagation();
        const opening = !this.element.classList.contains("open");
        document.querySelectorAll(".multi-select.open").forEach((node) => {
          if (node === this.element) return;
          node.classList.remove("open");
          node.querySelector(".multi-select-button")?.setAttribute("aria-expanded", "false");
          node.querySelector(".multi-select-menu")?.setAttribute("aria-hidden", "true");
        });
        this.element.classList.toggle("open", opening);
        this.button.setAttribute("aria-expanded", String(opening));
        this.menu.setAttribute("aria-hidden", String(!opening));
        if (opening) setTimeout(() => this.search.focus(), 0);
      });

      this.menu.addEventListener("click", (event) => event.stopPropagation());
      this.element.addEventListener("keydown", (event) => {
        if (event.key !== "Escape" || !this.element.classList.contains("open")) return;
        event.preventDefault();
        event.stopPropagation();
        this.close(true);
      });
      this.search.addEventListener("input", () => {
        this.searchTerm = normalize(this.search.value);
        this.renderOptions();
      });
      this.menu.querySelector('[data-action="all"]').addEventListener("click", () => {
        this.selected = new Set(this.items.map((item) => item.value));
        this.changed();
      });
      this.menu.querySelector('[data-action="none"]').addEventListener("click", () => {
        this.selected.clear();
        this.changed();
      });
    }

    renderOptions() {
      const filtered = this.items.filter((item) => normalize(item.label).includes(this.searchTerm));
      if (!filtered.length) {
        this.optionsElement.innerHTML = '<div class="multi-empty">No matching options</div>';
        return;
      }
      this.optionsElement.innerHTML = filtered.map((item) => `
        <label class="multi-option">
          <input type="checkbox" value="${escapeHtml(item.value)}" ${this.selected.has(item.value) ? "checked" : ""}>
          ${item.color ? `<i class="option-dot" style="--option-color:${item.color}"></i>` : ""}
          <span>${escapeHtml(item.label)}</span>
          ${finite(item.count) ? `<small>${fmt(item.count)}</small>` : ""}
        </label>`).join("");
      this.optionsElement.querySelectorAll("input").forEach((input) => {
        input.addEventListener("change", () => {
          if (input.checked) this.selected.add(input.value);
          else this.selected.delete(input.value);
          this.changed(false);
        });
      });
    }

    changed(rebuild = true) {
      if (rebuild) this.renderOptions();
      this.updateButton();
      this.onChange(new Set(this.selected));
    }

    updateButton() {
      const label = this.button.querySelector("span");
      if (this.selected.size === this.items.length) label.textContent = `All ${this.label.toLowerCase()}`;
      else if (this.selected.size === 0) label.textContent = `No ${this.label.toLowerCase()}`;
      else if (this.selected.size === 1) {
        const selectedValue = [...this.selected][0];
        label.textContent = this.items.find((item) => item.value === selectedValue)?.label || selectedValue;
      } else label.textContent = `${this.selected.size} ${this.label.toLowerCase()} selected`;
    }

    setSelected(values, notify = true) {
      this.selected = new Set([...values].filter((value) => this.items.some((item) => item.value === value)));
      this.renderOptions();
      this.updateButton();
      if (notify) this.onChange(new Set(this.selected));
    }

    selectAll(notify = true) {
      this.setSelected(new Set(this.items.map((item) => item.value)), notify);
    }

    close(restoreFocus = false) {
      this.element.classList.remove("open");
      this.button.setAttribute("aria-expanded", "false");
      this.menu.setAttribute("aria-hidden", "true");
      if (restoreFocus) focusElement(this.button);
    }
  }

  class DualRange {
    constructor(element, { min, max, valueMin, valueMax, step = 1, readout, minInput, maxInput, formatter, onChange }) {
      this.element = element;
      this.min = min;
      this.max = max;
      this.step = step;
      this.readout = readout;
      this.minInput = minInput;
      this.maxInput = maxInput;
      this.formatter = formatter;
      this.onChange = onChange;
      this.rangeMin = element.querySelector(".range-min");
      this.rangeMax = element.querySelector(".range-max");
      this.fill = element.querySelector(".range-fill");

      [this.rangeMin, this.rangeMax].forEach((input) => {
        input.min = String(min);
        input.max = String(max);
        input.step = String(step);
      });
      this.minInput.min = String(min);
      this.minInput.max = String(max);
      this.minInput.step = String(step);
      this.maxInput.min = String(min);
      this.maxInput.max = String(max);
      this.maxInput.step = String(step);

      this.rangeMin.addEventListener("input", () => this.handleRange("min"));
      this.rangeMax.addEventListener("input", () => this.handleRange("max"));
      this.minInput.addEventListener("change", () => this.handleNumber("min"));
      this.maxInput.addEventListener("change", () => this.handleNumber("max"));
      this.setValues(valueMin, valueMax, false);
    }

    handleRange(which) {
      let low = Number(this.rangeMin.value);
      let high = Number(this.rangeMax.value);
      if (low > high) {
        if (which === "min") low = high;
        else high = low;
      }
      this.setValues(low, high, true);
    }

    handleNumber(which) {
      let low = Number(this.minInput.value);
      let high = Number(this.maxInput.value);
      if (!Number.isFinite(low)) low = this.valueMin;
      if (!Number.isFinite(high)) high = this.valueMax;
      low = Math.max(this.min, Math.min(this.max, low));
      high = Math.max(this.min, Math.min(this.max, high));
      if (low > high) {
        if (which === "min") low = high;
        else high = low;
      }
      this.setValues(low, high, true);
    }

    setValues(low, high, notify = true) {
      this.valueMin = Math.max(this.min, Math.min(this.max, low));
      this.valueMax = Math.max(this.min, Math.min(this.max, high));
      if (this.valueMin > this.valueMax) [this.valueMin, this.valueMax] = [this.valueMax, this.valueMin];
      this.rangeMin.value = String(this.valueMin);
      this.rangeMax.value = String(this.valueMax);
      this.minInput.value = String(this.valueMin);
      this.maxInput.value = String(this.valueMax);
      const span = this.max - this.min || 1;
      const left = ((this.valueMin - this.min) / span) * 100;
      const right = 100 - ((this.valueMax - this.min) / span) * 100;
      this.fill.style.left = `${left}%`;
      this.fill.style.right = `${right}%`;
      this.readout.textContent = this.formatter(this.valueMin, this.valueMax);
      if (notify) this.onChange(this.valueMin, this.valueMax);
    }
  }

  function prepareModels() {
    const techCounts = new Map();
    const stateCounts = new Map();
    const sectorCounts = new Map();
    let minYear = Infinity;
    let maxYear = -Infinity;
    let maxFacilityCapacity = 0;

    facilityModels = rawFacilities.map((facility, index) => {
      const model = {
        index,
        id: facility[F.ID],
        entity: dictionaries.entities[facility[F.ENTITY]] || "Unknown entity",
        name: dictionaries.plants[facility[F.NAME]] || "Unnamed facility",
        state: dictionaries.states[facility[F.STATE]] || "",
        county: dictionaries.counties[facility[F.COUNTY]] || "",
        sector: dictionaries.sectors[facility[F.SECTOR]] || "Unspecified",
        lat: facility[F.LAT],
        lon: facility[F.LON],
        start: facility[F.START],
        count: facility[F.COUNT],
        totalMw: 0,
        activeMw: 0,
        retiredMw: 0,
        firstYear: Infinity,
        lastYear: -Infinity,
        technologies: new Set(),
      };

      stateCounts.set(model.state, (stateCounts.get(model.state) || 0) + 1);
      sectorCounts.set(model.sector, (sectorCounts.get(model.sector) || 0) + 1);

      for (let position = model.start; position < model.start + model.count; position += 1) {
        const generator = rawGenerators[position];
        const capacity = finite(generator[G.NAMEPLATE]) ? generator[G.NAMEPLATE] : 0;
        const technology = dictionaries.technologies[generator[G.TECH]] || "Unknown";
        const operatingYear = generator[G.OP_YEAR];
        model.totalMw += capacity;
        if (generator[G.SOURCE] === 0) model.activeMw += capacity;
        else model.retiredMw += capacity;
        model.technologies.add(technology);
        techCounts.set(technology, (techCounts.get(technology) || 0) + 1);
        if (finite(operatingYear)) {
          minYear = Math.min(minYear, operatingYear);
          maxYear = Math.max(maxYear, operatingYear);
          model.firstYear = Math.min(model.firstYear, operatingYear);
          model.lastYear = Math.max(model.lastYear, operatingYear);
        }
      }
      maxFacilityCapacity = Math.max(maxFacilityCapacity, model.totalMw);
      model.searchText = normalize([model.id, model.name, model.entity, model.state, model.county, model.sector, ...model.technologies].join(" "));
      return model;
    });

    universe.technologies = [...techCounts.keys()].sort((a, b) => a.localeCompare(b));
    universe.states = [...stateCounts.keys()].filter(Boolean).sort((a, b) => a.localeCompare(b));
    universe.sectors = [...sectorCounts.keys()].filter(Boolean).sort((a, b) => a.localeCompare(b));
    universe.operatingYearMin = Number.isFinite(minYear) ? minYear : 1900;
    universe.operatingYearMax = Number.isFinite(maxYear) ? maxYear : 2026;
    universe.capacityMax = roundCapacityMax(maxFacilityCapacity);

    filters.technologies = new Set(universe.technologies);
    filters.states = new Set(universe.states);
    filters.sectors = new Set(universe.sectors);
    filters.operatingYearMin = universe.operatingYearMin;
    filters.operatingYearMax = universe.operatingYearMax;
    filters.capacityMin = 0;
    filters.capacityMax = universe.capacityMax;

    return { techCounts, stateCounts, sectorCounts };
  }

  function initializeMap() {
    map = L.map("map", {
      zoomControl: false,
      preferCanvas: true,
      minZoom: 3,
      maxZoom: 18,
      worldCopyJump: true,
    }).setView([38.5, -97.5], homeMapZoom());

    lightTiles = L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      subdomains: "abcd",
      maxZoom: 20,
      attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
    });
    darkTiles = L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
      subdomains: "abcd",
      maxZoom: 20,
      attribution: "&copy; OpenStreetMap contributors &copy; CARTO",
    });
    [lightTiles, darkTiles].forEach((tiles) => {
      tiles.on("tileerror", () => {
        setBasemapStatus("Basemap tiles unavailable");
        if (tileFailureNotified) return;
        tileFailureNotified = true;
        showToast("Basemap tiles could not be loaded; facility data remains available");
      });
      tiles.on("load", () => {
        if (!tileFailureNotified) setBasemapStatus();
      });
    });
    activeTiles = document.documentElement.dataset.theme === "light" ? lightTiles : darkTiles;
    activeTiles.addTo(map);

    map.createPane("heatPane");
    map.getPane("heatPane").style.zIndex = 350;
    map.createPane("markerPaneCustom");
    map.getPane("markerPaneCustom").style.zIndex = 450;
    map.createPane("clusterLabelPane");
    map.getPane("clusterLabelPane").style.zIndex = 455;
    map.getPane("clusterLabelPane").style.pointerEvents = "none";

    markerLayer = L.layerGroup().addTo(map);
    markers = facilityModels.map((facility) => {
      if (!finite(facility.lat) || !finite(facility.lon)) return null;
      const marker = L.circleMarker([facility.lat, facility.lon], {
        renderer: markerRenderer,
        pane: "markerPaneCustom",
        radius: 4,
        color: "rgba(255,255,255,.72)",
        weight: 1,
        fillColor: "#5ea6ff",
        fillOpacity: 0.82,
      });
      marker._facilityIndex = facility.index;
      marker.bindPopup((layer) => popupHtml(layer._selection), { maxWidth: 300, closeButton: true });
      marker.on("click", () => {
        currentDetailIndex = facility.index;
      });
      return marker;
    });

    map.on("popupopen", (event) => {
      const button = event.popup.getElement()?.querySelector("[data-open-facility]");
      if (button) button.addEventListener("click", () => openFacility(Number(button.dataset.openFacility)));
    });
    map.on("zoomend", () => {
      updateZoomControls();
      if (!lastAggregate) return;
      renderMap();
      renderLegend(lastAggregate);
    });
    updateZoomControls();
    setBasemapStatus();
  }

  function initializeControls(counts) {
    const snapshot = metadata.snapshot || "Bundled snapshot";
    const compactSnapshot = snapshot.replace(
      /^(January|February|March|April|May|June|July|August|September|October|November|December)\b/,
      (month) => month.slice(0, 3),
    );
    $("datasetLabel").textContent = `${compactSnapshot} · ${compactFormatter.format(metadata.generatorCount)} gen`;
    $("datasetLabel").setAttribute("aria-label", `${snapshot}, ${fmt(metadata.generatorCount)} generators`);
    $("datasetLabel").title = `${snapshot} · ${fmt(metadata.generatorCount)} generators`;
    $("activeCountBadge").textContent = fmt(metadata.activeGeneratorCount);
    $("retiredCountBadge").textContent = fmt(metadata.retiredGeneratorCount);

    controls.technology = new MultiSelect($("technologyFilter"), {
      label: "Technologies",
      items: universe.technologies.map((value) => ({ value, label: value, color: technologyColor(value), count: counts.techCounts.get(value) || 0 })),
      selected: filters.technologies,
      onChange: (selected) => {
        filters.technologies = selected;
        syncTechnologyGroupButtons();
        scheduleRender(true);
      },
    });
    controls.state = new MultiSelect($("stateFilter"), {
      label: "States",
      items: universe.states.map((value) => ({ value, label: value, count: counts.stateCounts.get(value) || 0 })),
      selected: filters.states,
      onChange: (selected) => {
        filters.states = selected;
        scheduleRender(true);
      },
    });
    controls.sector = new MultiSelect($("sectorFilter"), {
      label: "Sectors",
      items: universe.sectors.map((value) => ({ value, label: value, count: counts.sectorCounts.get(value) || 0 })),
      selected: filters.sectors,
      onChange: (selected) => {
        filters.sectors = selected;
        scheduleRender(true);
      },
    });

    controls.operatingYear = new DualRange($("operatingYearRange"), {
      min: universe.operatingYearMin,
      max: universe.operatingYearMax,
      valueMin: filters.operatingYearMin,
      valueMax: filters.operatingYearMax,
      readout: $("operatingYearReadout"),
      minInput: $("operatingYearMinInput"),
      maxInput: $("operatingYearMaxInput"),
      formatter: (low, high) => `${Math.round(low)}–${Math.round(high)}`,
      onChange: (low, high) => {
        filters.operatingYearMin = low;
        filters.operatingYearMax = high;
        scheduleRender(true);
      },
    });

    controls.capacity = new DualRange($("capacityRange"), {
      min: 0,
      max: universe.capacityMax,
      valueMin: filters.capacityMin,
      valueMax: filters.capacityMax,
      readout: $("capacityReadout"),
      minInput: $("capacityMinInput"),
      maxInput: $("capacityMaxInput"),
      formatter: (low, high) => `${fmt(low)}–${fmt(high)} MW`,
      onChange: (low, high) => {
        filters.capacityMin = low;
        filters.capacityMax = high;
        scheduleRender(true);
      },
    });

    $("globalSearch").addEventListener("input", () => {
      filters.search = normalize($("globalSearch").value);
      scheduleRender(true);
    });

    $("activeStatusBtn").addEventListener("click", () => {
      filters.active = !filters.active;
      if (!filters.active && !filters.retired) filters.retired = true;
      syncStatusButtons();
      scheduleRender(true);
    });
    $("retiredStatusBtn").addEventListener("click", () => {
      filters.retired = !filters.retired;
      if (!filters.active && !filters.retired) filters.active = true;
      syncStatusButtons();
      scheduleRender(true);
    });

    $("technologyClearBtn").addEventListener("click", () => controls.technology.selectAll());
    $("technologyGroups").addEventListener("click", (event) => {
      const button = event.target.closest("[data-tech-group]");
      if (!button) return;
      const group = button.dataset.techGroup;
      const selected = new Set(universe.technologies.filter((technology) => technologyGroup(technology) === group));
      controls.technology.setSelected(selected);
    });

    $("heatToggle").addEventListener("change", () => {
      const requested = $("heatToggle").checked;
      if (requested && typeof L.heatLayer !== "function") {
        $("heatToggle").checked = false;
        filters.heat = false;
        showToast("The heatmap layer is unavailable");
        syncHashState();
        return;
      }
      filters.heat = requested;
      renderMap();
      if (lastAggregate) renderLegend(lastAggregate);
      syncHashState();
    });
    $("scaleDotsToggle").addEventListener("change", () => {
      filters.scaleDots = $("scaleDotsToggle").checked;
      renderMap();
      if (lastAggregate) renderLegend(lastAggregate);
      syncHashState();
    });
    if (typeof L.heatLayer !== "function") {
      $("heatToggle").disabled = true;
      $("heatToggle").closest(".switch-row")?.setAttribute("title", "Heatmap library unavailable");
    }

    $("resetBtn").addEventListener("click", resetFilters);
    $("homeBtn").addEventListener("click", resetFilters);
    $("fitSelectionBtn").addEventListener("click", fitSelection);
    $("zoomHomeBtn").addEventListener("click", resetMapExtent);
    $("zoomInBtn")?.addEventListener("click", () => map.zoomIn());
    $("zoomOutBtn")?.addEventListener("click", () => map.zoomOut());
    $("basemapBtn").addEventListener("click", toggleBasemap);
    $("exportBtn").addEventListener("click", exportFacilities);
    $("shareBtn").addEventListener("click", copyShareLink);
    $("themeBtn").addEventListener("click", toggleTheme);
    $("detailCloseBtn").addEventListener("click", () => closeFacility(true));
    $("legendToggle").addEventListener("click", toggleLegend);

    $("facilitySort").addEventListener("change", () => {
      currentPage = 1;
      renderFacilityList();
    });
    $("previousPageBtn").addEventListener("click", () => {
      currentPage = Math.max(1, currentPage - 1);
      renderFacilityList();
    });
    $("nextPageBtn").addEventListener("click", () => {
      currentPage += 1;
      renderFacilityList();
    });
    $("facilityList").addEventListener("click", (event) => {
      const row = event.target.closest("[data-facility-index]");
      if (row) openFacility(Number(row.dataset.facilityIndex));
    });

    $("overviewTab").addEventListener("click", () => setTab("overview"));
    $("facilitiesTab").addEventListener("click", () => setTab("facilities"));
    $("dataTab").addEventListener("click", () => setTab("data"));
    initializeTabKeyboard();
    initializeMoreMenu();

    document.addEventListener("click", () => {
      document.querySelectorAll(".multi-select.open").forEach((element) => {
        element.classList.remove("open");
        element.querySelector(".multi-select-button")?.setAttribute("aria-expanded", "false");
        element.querySelector(".multi-select-menu")?.setAttribute("aria-hidden", "true");
      });
      closeMoreMenu(false);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Tab" && trapFocusInOpenDrawer(event)) return;
      if (event.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) {
        event.preventDefault();
        $("globalSearch").focus();
      }
      if (event.key === "Escape") {
        if (moreMenuOpen) {
          closeMoreMenu(true);
          return;
        }
        if ($("detailDrawer").classList.contains("open")) {
          closeFacility(true);
          return;
        }
        closeMobilePanels(true);
      }
    });

    initializeMobilePanels();
    initializeRetryControl();
    populateMetadata();
    syncStatusButtons();
    applyHashState();
    lastHandledNavigationHash = location.hash;
    window.addEventListener("hashchange", handleLocationStateChange);
    window.addEventListener("popstate", handleLocationStateChange);
    syncResponsiveState();
  }

  function initializeMobilePanels() {
    const filterButton = $("filtersMobileBtn");
    const insightsButton = $("insightsMobileBtn");
    filterButton.setAttribute("aria-controls", "filterPanel");
    filterButton.setAttribute("aria-expanded", "false");
    insightsButton.setAttribute("aria-controls", "insightsPanel");
    insightsButton.setAttribute("aria-expanded", "false");
    filterButton.addEventListener("click", () => openMobilePanel("filterPanel"));
    insightsButton.addEventListener("click", () => openMobilePanel("insightsPanel"));
    $("mobileScrim").addEventListener("click", () => closeMobilePanels(true));
    document.querySelectorAll("[data-close-panel]").forEach((button) => {
      button.addEventListener("click", () => closeMobilePanels(true));
    });
    [filterOverlayLayout, insightsOverlayLayout, mobileLayout].forEach((query) => {
      if (!query) return;
      if (typeof query.addEventListener === "function") query.addEventListener("change", handleResponsiveChange);
      else if (typeof query.addListener === "function") query.addListener(handleResponsiveChange);
    });
  }

  function panelUsesDrawer(id) {
    if (id === "filterPanel") return Boolean(filterOverlayLayout?.matches);
    if (id === "insightsPanel") return Boolean(insightsOverlayLayout?.matches);
    return false;
  }

  function handleResponsiveChange() {
    const isMobileMapLayout = Boolean(mobileLayout?.matches);
    const enteredMobileMapLayout = isMobileMapLayout && !previousMobileMapLayout;
    previousMobileMapLayout = isMobileMapLayout;
    const menuWasOpen = moreMenuOpen;
    const panelWasOpen = Boolean(document.querySelector(".side-panel.mobile-open"));
    document.querySelectorAll(".side-panel.mobile-open").forEach((panel) => panel.classList.remove("mobile-open"));
    mobilePanelReturnFocus = null;
    closeMoreMenu(false);
    syncResponsiveState();
    if (enteredMobileMapLayout && map?.getZoom() <= 4) resetMapExtent();
    if (menuWasOpen || panelWasOpen) focusElement($("globalSearch"));
  }

  function openDrawerPanel() {
    return ["filterPanel", "insightsPanel"]
      .map((id) => $(id))
      .find((panel) => panelUsesDrawer(panel.id) && panel.classList.contains("mobile-open")) || null;
  }

  function syncModalIsolation(openPanel) {
    const exempt = new Set([openPanel, $("mobileScrim"), $("toast"), fatalError]);
    [...app.children].forEach((child) => {
      const isolated = child.hasAttribute("data-modal-inert-state");
      if (openPanel && !exempt.has(child)) {
        if (!isolated) child.dataset.modalInertState = child.inert ? "true" : "false";
        child.inert = true;
        return;
      }
      if (!isolated) return;
      child.inert = child.dataset.modalInertState === "true";
      delete child.dataset.modalInertState;
    });
  }

  function drawerFocusableElements(panel) {
    const selector = [
      "a[href]",
      "button:not([disabled])",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "[tabindex]:not([tabindex='-1'])",
    ].join(",");
    return [...panel.querySelectorAll(selector)].filter((element) => (
      !element.inert
      && element.getAttribute("aria-hidden") !== "true"
      && element.getClientRects().length > 0
    ));
  }

  function trapFocusInOpenDrawer(event) {
    const panel = openDrawerPanel();
    if (!panel) return false;
    const focusable = drawerFocusableElements(panel);
    if (!focusable.length) {
      event.preventDefault();
      focusElement(panel);
      return true;
    }
    const first = focusable[0];
    const last = focusable.at(-1);
    const active = document.activeElement;
    if (!panel.contains(active)) {
      event.preventDefault();
      focusElement(event.shiftKey ? last : first);
      return true;
    }
    if (event.shiftKey && active === first) {
      event.preventDefault();
      focusElement(last);
      return true;
    }
    if (!event.shiftKey && active === last) {
      event.preventDefault();
      focusElement(first);
      return true;
    }
    return false;
  }

  function syncResponsiveState() {
    ["filterPanel", "insightsPanel"].forEach((id) => {
      const panel = $(id);
      const trigger = id === "filterPanel" ? $("filtersMobileBtn") : $("insightsMobileBtn");
      const drawer = panelUsesDrawer(id);
      if (!drawer) panel.classList.remove("mobile-open");
      const open = drawer && panel.classList.contains("mobile-open");
      panel.setAttribute("aria-hidden", String(drawer && !open));
      panel.setAttribute("role", drawer ? "dialog" : "region");
      if (drawer) panel.setAttribute("aria-modal", String(open));
      else panel.removeAttribute("aria-modal");
      panel.inert = drawer && !open;
      trigger.setAttribute("aria-expanded", String(open));
    });
    if ($("detailDrawer").classList.contains("open")) {
      $("insightsPanel").setAttribute("aria-hidden", "true");
      $("insightsPanel").inert = true;
    }
    const activeDrawer = openDrawerPanel();
    const drawerOpen = Boolean(activeDrawer);
    $("mobileScrim").classList.toggle("show", drawerOpen);
    $("mobileScrim").setAttribute("aria-hidden", String(!drawerOpen));
    syncModalIsolation(activeDrawer);
    if (!legendUserToggled) setLegendExpanded(!mobileLayout?.matches, false);
    setTimeout(() => map?.invalidateSize?.({ pan: false }), 0);
  }

  function openMobilePanel(id) {
    const panel = $(id);
    if (!panel) return;
    if ($("detailDrawer").classList.contains("open")) closeFacility(false);
    if (!panelUsesDrawer(id)) {
      focusElement(panel.querySelector("button, input, select, [tabindex='0']"));
      return;
    }
    const returnFocus = isFocusable(document.activeElement)
      ? document.activeElement
      : id === "filterPanel" ? $("filtersMobileBtn") : $("insightsMobileBtn");
    closeMobilePanels(false);
    mobilePanelReturnFocus = returnFocus;
    panel.classList.add("mobile-open");
    syncResponsiveState();
    setTimeout(() => focusElement(panel.querySelector("[data-close-panel], button, input, select")), 0);
  }

  function closeMobilePanels(restoreFocus = false) {
    const hadOpenPanel = Boolean(document.querySelector(".side-panel.mobile-open"));
    document.querySelectorAll(".side-panel.mobile-open").forEach((panel) => panel.classList.remove("mobile-open"));
    syncResponsiveState();
    if (restoreFocus && hadOpenPanel) focusElement(mobilePanelReturnFocus);
    if (hadOpenPanel) mobilePanelReturnFocus = null;
  }

  function initializeTabKeyboard() {
    const tabs = [
      ["overview", $("overviewTab")],
      ["facilities", $("facilitiesTab")],
      ["data", $("dataTab")],
    ];
    tabs.forEach(([key, tab], index) => {
      tab.tabIndex = key === currentTab ? 0 : -1;
      tab.addEventListener("keydown", (event) => {
        let targetIndex = null;
        if (event.key === "ArrowRight" || event.key === "ArrowDown") targetIndex = (index + 1) % tabs.length;
        if (event.key === "ArrowLeft" || event.key === "ArrowUp") targetIndex = (index - 1 + tabs.length) % tabs.length;
        if (event.key === "Home") targetIndex = 0;
        if (event.key === "End") targetIndex = tabs.length - 1;
        if (targetIndex === null) return;
        event.preventDefault();
        const [targetKey, targetTab] = tabs[targetIndex];
        setTab(targetKey);
        focusElement(targetTab);
      });
    });
  }

  function initializeMoreMenu() {
    const button = $("moreBtn");
    const menu = $("moreMenu");
    if (!button || !menu) return;
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", "false");
    if (menu.id) button.setAttribute("aria-controls", menu.id);
    menu.hidden = true;
    menu.setAttribute("aria-hidden", "true");
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      setMoreMenuOpen(!moreMenuOpen, moreMenuOpen);
    });
    button.addEventListener("keydown", (event) => {
      if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
      event.preventDefault();
      setMoreMenuOpen(true, false);
      const items = [...menu.querySelectorAll("[role='menuitem']")];
      setTimeout(() => focusElement(event.key === "ArrowUp" ? items.at(-1) : items[0]), 0);
    });
    menu.addEventListener("click", (event) => event.stopPropagation());
    menu.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeMoreMenu(true);
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const items = [...menu.querySelectorAll("[role='menuitem']")];
      const current = items.indexOf(document.activeElement);
      let next = current;
      if (event.key === "ArrowDown") next = (current + 1) % items.length;
      if (event.key === "ArrowUp") next = (current - 1 + items.length) % items.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = items.length - 1;
      event.preventDefault();
      focusElement(items[next]);
    });
    $("moreShareBtn")?.addEventListener("click", () => {
      closeMoreMenu(true);
      copyShareLink();
    });
    $("moreThemeBtn")?.addEventListener("click", () => {
      closeMoreMenu(true);
      toggleTheme();
    });
    $("moreBasemapBtn")?.addEventListener("click", () => {
      closeMoreMenu(true);
      toggleBasemap();
    });
    $("moreDataBtn")?.addEventListener("click", () => {
      closeMoreMenu(true);
      setTab("data");
      openMobilePanel("insightsPanel");
    });
  }

  function setMoreMenuOpen(open, restoreFocus = false) {
    const button = $("moreBtn");
    const menu = $("moreMenu");
    if (!button || !menu) return;
    moreMenuOpen = open;
    menu.hidden = !open;
    menu.classList.toggle("open", open);
    menu.setAttribute("aria-hidden", String(!open));
    button.setAttribute("aria-expanded", String(open));
    if (open) {
      document.querySelectorAll(".multi-select.open").forEach((element) => {
        element.classList.remove("open");
        element.querySelector(".multi-select-button")?.setAttribute("aria-expanded", "false");
        element.querySelector(".multi-select-menu")?.setAttribute("aria-hidden", "true");
      });
      setTimeout(() => focusElement(menu.querySelector("button, [href], [tabindex='0']")), 0);
    } else if (restoreFocus) focusElement(button);
  }

  function closeMoreMenu(restoreFocus = false) {
    if (!moreMenuOpen) return;
    setMoreMenuOpen(false, restoreFocus);
  }

  function updateZoomControls() {
    if (!map) return;
    const zoom = map.getZoom();
    const minimum = map.getMinZoom();
    const maximum = map.getMaxZoom();
    if ($("zoomInBtn")) $("zoomInBtn").disabled = zoom >= maximum;
    if ($("zoomOutBtn")) $("zoomOutBtn").disabled = zoom <= minimum;
  }

  function homeMapZoom() {
    return mobileLayout?.matches ? 3 : 4;
  }

  function resetMapExtent() {
    map?.setView([38.5, -97.5], homeMapZoom());
  }

  function syncStatusButtons() {
    const activeButton = $("activeStatusBtn");
    const retiredButton = $("retiredStatusBtn");
    activeButton.classList.toggle("active", filters.active);
    retiredButton.classList.toggle("active", filters.retired);
    activeButton.setAttribute("aria-pressed", String(filters.active));
    retiredButton.setAttribute("aria-pressed", String(filters.retired));
    $("statusSummary").textContent = filters.active && filters.retired ? "All generators" : filters.active ? "Active only" : "Retired only";
  }

  function syncTechnologyGroupButtons() {
    $("technologyGroups").querySelectorAll("[data-tech-group]").forEach((button) => {
      const group = button.dataset.techGroup;
      const groupItems = universe.technologies.filter((technology) => technologyGroup(technology) === group);
      const active = groupItems.length > 0 && groupItems.every((technology) => filters.technologies.has(technology)) && filters.technologies.size === groupItems.length;
      button.classList.toggle("active", active);
    });
  }

  function generatorPasses(generator) {
    const source = generator[G.SOURCE];
    if (source === 0 && !filters.active) return false;
    if (source === 1 && !filters.retired) return false;
    const technology = dictionaries.technologies[generator[G.TECH]] || "Unknown";
    if (!filters.technologies.has(technology)) return false;
    const year = generator[G.OP_YEAR];
    if (finite(year)) {
      if (year < filters.operatingYearMin || year > filters.operatingYearMax) return false;
    } else if (filters.operatingYearMin !== universe.operatingYearMin || filters.operatingYearMax !== universe.operatingYearMax) return false;
    return true;
  }

  function aggregateSelection() {
    const aggregate = {
      capacity: 0,
      generatorCount: 0,
      mappedCount: 0,
      entities: new Set(),
      states: new Set(),
      technologyMw: new Map(),
      stateMw: new Map(),
      operatingYearMw: new Map(),
      retirementYearMw: new Map(),
      retirementThrough2035: 0,
      activeGeneratorCount: 0,
      retiredGeneratorCount: 0,
    };
    const results = [];
    const resultMap = new Map();

    for (const facility of facilityModels) {
      if (!filters.states.has(facility.state) || !filters.sectors.has(facility.sector)) continue;
      if (filters.search && !facility.searchText.includes(filters.search)) continue;

      let capacity = 0;
      let activeMw = 0;
      let retiredMw = 0;
      let generatorCount = 0;
      let activeCount = 0;
      let retiredCount = 0;
      let firstYear = Infinity;
      let lastYear = -Infinity;
      let earliestRetirement = Infinity;
      const generatorIndexes = [];
      const technologyMw = new Map();
      const operatingYearMw = new Map();
      const retirementYearMw = new Map();

      for (let position = facility.start; position < facility.start + facility.count; position += 1) {
        const generator = rawGenerators[position];
        if (!generatorPasses(generator)) continue;
        const mw = finite(generator[G.NAMEPLATE]) ? generator[G.NAMEPLATE] : 0;
        const technology = dictionaries.technologies[generator[G.TECH]] || "Unknown";
        const operatingYear = generator[G.OP_YEAR];
        const retirementYear = generator[G.RET_YEAR];
        const source = generator[G.SOURCE];

        capacity += mw;
        generatorCount += 1;
        generatorIndexes.push(position);
        technologyMw.set(technology, (technologyMw.get(technology) || 0) + mw);
        if (source === 0) {
          activeMw += mw;
          activeCount += 1;
          if (finite(retirementYear)) {
            retirementYearMw.set(retirementYear, (retirementYearMw.get(retirementYear) || 0) + mw);
            earliestRetirement = Math.min(earliestRetirement, retirementYear);
          }
        } else {
          retiredMw += mw;
          retiredCount += 1;
        }
        if (finite(operatingYear)) {
          operatingYearMw.set(operatingYear, (operatingYearMw.get(operatingYear) || 0) + mw);
          firstYear = Math.min(firstYear, operatingYear);
          lastYear = Math.max(lastYear, operatingYear);
        }
      }

      if (!generatorCount) continue;
      if (capacity < filters.capacityMin || capacity > filters.capacityMax) continue;

      const dominantTechnology = topEntries(technologyMw, 1)[0]?.[0] || "Unknown";
      const selection = {
        facility,
        capacity,
        activeMw,
        retiredMw,
        generatorCount,
        activeCount,
        retiredCount,
        firstYear: Number.isFinite(firstYear) ? firstYear : null,
        lastYear: Number.isFinite(lastYear) ? lastYear : null,
        earliestRetirement: Number.isFinite(earliestRetirement) ? earliestRetirement : null,
        generatorIndexes,
        technologyMw,
        dominantTechnology,
      };
      results.push(selection);
      resultMap.set(facility.index, selection);

      aggregate.capacity += capacity;
      aggregate.generatorCount += generatorCount;
      aggregate.activeGeneratorCount += activeCount;
      aggregate.retiredGeneratorCount += retiredCount;
      if (finite(facility.lat) && finite(facility.lon)) aggregate.mappedCount += 1;
      aggregate.entities.add(facility.entity);
      aggregate.states.add(facility.state);
      sumMap(aggregate.technologyMw, technologyMw);
      aggregate.stateMw.set(facility.state, (aggregate.stateMw.get(facility.state) || 0) + capacity);
      sumMap(aggregate.operatingYearMw, operatingYearMw);
      sumMap(aggregate.retirementYearMw, retirementYearMw);
      for (const [year, mw] of retirementYearMw) {
        if (year >= APP_CONFIG.asOfYear && year <= APP_CONFIG.retirementKpiEndYear) aggregate.retirementThrough2035 += mw;
      }
    }

    visibleFacilities = results;
    visibleByIndex = resultMap;
    return aggregate;
  }

  function scheduleRender(resetPage = false) {
    if (resetPage) currentPage = 1;
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, 110);
  }

  function render() {
    const aggregate = aggregateSelection();
    lastAggregate = aggregate;
    mapLegendTechnologies = new Set(topEntries(aggregate.technologyMw, 7).map(([technology]) => technology));
    renderMap();
    renderKpis(aggregate);
    renderCharts(aggregate);
    renderFacilityList();
    renderLegend(aggregate);
    announceResults(aggregate);
    syncHashState();
    if (currentDetailIndex !== null) {
      if (visibleByIndex.has(currentDetailIndex)) renderFacilityDetail(visibleByIndex.get(currentDetailIndex));
      else closeFacility();
    }
  }

  function markerRadius(capacity) {
    if (!filters.scaleDots) return 4.2;
    const cap = Math.max(0, Math.min(capacity, 3000));
    return 2.6 + Math.sqrt(cap / 3000) * 13;
  }

  function mapMarkerColor(technology) {
    return mapLegendTechnologies.has(technology) ? technologyColor(technology) : OTHER_MAP_COLOR;
  }

  function mapUsesAggregation() {
    return Boolean(map && map.getZoom() <= 6 && visibleFacilities.length > 250);
  }

  function clusteredSelections() {
    const zoom = map.getZoom();
    const cellSize = zoom <= 4 ? 36 : zoom === 5 ? 32 : 28;
    const clusters = new Map();

    for (const selection of visibleFacilities) {
      const { facility } = selection;
      if (!finite(facility.lat) || !finite(facility.lon)) continue;
      const point = map.project([facility.lat, facility.lon], zoom);
      const key = `${Math.floor(point.x / cellSize)}:${Math.floor(point.y / cellSize)}`;
      let cluster = clusters.get(key);
      if (!cluster) {
        cluster = {
          activeCount: 0,
          bounds: L.latLngBounds([facility.lat, facility.lon], [facility.lat, facility.lon]),
          capacity: 0,
          count: 0,
          latSum: 0,
          lonSum: 0,
          retiredCount: 0,
          singleSelection: selection,
          technologyMw: new Map(),
        };
        clusters.set(key, cluster);
      } else {
        cluster.singleSelection = null;
        cluster.bounds.extend([facility.lat, facility.lon]);
      }
      cluster.count += 1;
      cluster.latSum += facility.lat;
      cluster.lonSum += facility.lon;
      cluster.capacity += selection.capacity;
      cluster.activeCount += selection.activeCount;
      cluster.retiredCount += selection.retiredCount;
      sumMap(cluster.technologyMw, selection.technologyMw);
    }

    return [...clusters.values()];
  }

  function renderAggregatedMarkers() {
    const clusters = clusteredSelections().map((cluster) => {
      const center = L.latLng(cluster.latSum / cluster.count, cluster.lonSum / cluster.count);
      const radius = Math.min(15, 4.5 + Math.sqrt(cluster.count) * 0.75);
      return {
        ...cluster,
        center,
        pixel: map.project(center, map.getZoom()),
        radius,
        showLabel: false,
      };
    });
    const labeledClusters = [];
    for (const cluster of [...clusters].sort((a, b) => b.count - a.count)) {
      if (cluster.count <= 1) continue;
      const overlaps = labeledClusters.some((labeled) => (
        cluster.pixel.distanceTo(labeled.pixel) < cluster.radius + labeled.radius + 4
      ));
      if (overlaps) continue;
      cluster.showLabel = true;
      labeledClusters.push(cluster);
    }

    for (const cluster of clusters) {
      const [dominantTechnology = "Unknown"] = topEntries(cluster.technologyMw, 1)[0] || [];
      const retiredOnly = cluster.retiredCount > 0 && cluster.activeCount === 0;
      const mixed = cluster.retiredCount > 0 && cluster.activeCount > 0;
      const marker = L.circleMarker(
        cluster.center,
        {
          renderer: markerRenderer,
          pane: "markerPaneCustom",
          radius: cluster.radius,
          color: retiredOnly ? "#ff9d5c" : mixed ? "#f4f7fb" : "rgba(255,255,255,.78)",
          weight: retiredOnly ? 1.8 : 1.2,
          fillColor: mapMarkerColor(dominantTechnology),
          fillOpacity: filters.heat ? 0.62 : 0.78,
        },
      );

      if (cluster.singleSelection) {
        marker._selection = cluster.singleSelection;
        marker.bindPopup((layer) => popupHtml(layer._selection), { maxWidth: 300, closeButton: true });
        marker.on("click", () => {
          currentDetailIndex = cluster.singleSelection.facility.index;
        });
      } else {
        marker.bindTooltip(
          `<strong>${fmt(cluster.count)} facilities</strong><br>${escapeHtml(dominantTechnology)} · ${fmtMw(cluster.capacity)}<br>Select to zoom in`,
          { direction: "top", opacity: 0.96 },
        );
        marker.on("click", () => {
          const targetZoom = Math.min(map.getZoom() + 2, 7);
          map.fitBounds(cluster.bounds, {
            animate: true,
            maxZoom: targetZoom,
            padding: [48, 48],
          });
        });
      }
      marker.addTo(markerLayer);
      if (cluster.showLabel) {
        L.marker(marker.getLatLng(), {
          interactive: false,
          keyboard: false,
          pane: "clusterLabelPane",
          icon: L.divIcon({
            className: "facility-cluster-count",
            html: `<span>${fmt(cluster.count)}</span>`,
            iconAnchor: [16, 16],
            iconSize: [32, 32],
          }),
        }).addTo(markerLayer);
      }
    }
  }

  function renderMap() {
    markerLayer.clearLayers();
    const heatPoints = [];
    let heatMax = 1;
    for (const selection of visibleFacilities) heatMax = Math.max(heatMax, selection.capacity);

    for (const selection of visibleFacilities) {
      const facility = selection.facility;
      if (!finite(facility.lat) || !finite(facility.lon)) continue;
      heatPoints.push([facility.lat, facility.lon, Math.log10(selection.capacity + 1) / Math.log10(heatMax + 1)]);
    }

    if (mapUsesAggregation()) {
      renderAggregatedMarkers();
    } else {
      for (const selection of visibleFacilities) {
        const facility = selection.facility;
        const marker = markers[facility.index];
        if (!marker) continue;
        const outline = selection.activeCount && selection.retiredCount ? "#f4f7fb" : selection.retiredCount ? "#ff9d5c" : "rgba(255,255,255,.78)";
        marker._selection = selection;
        marker.setRadius(markerRadius(selection.capacity));
        marker.setStyle({
          fillColor: mapMarkerColor(selection.dominantTechnology),
          color: outline,
          weight: selection.retiredCount && !selection.activeCount ? 1.7 : 1.1,
          fillOpacity: filters.heat ? 0.68 : 0.82,
        });
        marker.addTo(markerLayer);
      }
    }

    if (filters.heat && typeof L.heatLayer === "function") {
      try {
        if (!heatLayer) {
          heatLayer = L.heatLayer(heatPoints, { pane: "heatPane", radius: 25, blur: 19, maxZoom: 10 }).addTo(map);
        } else {
          heatLayer.setLatLngs(heatPoints);
          if (!map.hasLayer(heatLayer)) heatLayer.addTo(map);
        }
      } catch (error) {
        console.error("Heatmap could not be rendered", error);
        filters.heat = false;
        if ($("heatToggle")) $("heatToggle").checked = false;
        if (heatLayer && map.hasLayer(heatLayer)) map.removeLayer(heatLayer);
        showToast("The heatmap could not be rendered");
      }
    } else if (heatLayer && map.hasLayer(heatLayer)) {
      map.removeLayer(heatLayer);
    }
  }

  function popupHtml(selection) {
    if (!selection) return "";
    const { facility } = selection;
    return `<div class="map-popup">
      <h3>${escapeHtml(facility.name)}</h3>
      <p>${escapeHtml(facility.entity)} · ${escapeHtml(facility.state || "State unavailable")}</p>
      <div class="popup-stats">
        <div class="popup-stat"><span>Visible capacity</span><strong>${fmtMw(selection.capacity)}</strong></div>
        <div class="popup-stat"><span>Generators</span><strong>${fmt(selection.generatorCount)}</strong></div>
        <div class="popup-stat"><span>Technology</span><strong>${escapeHtml(selection.dominantTechnology)}</strong></div>
        <div class="popup-stat"><span>Operating years</span><strong>${selection.firstYear ? `${selection.firstYear}–${selection.lastYear}` : "—"}</strong></div>
      </div>
      <button class="popup-button" type="button" data-open-facility="${facility.index}">Open facility profile</button>
    </div>`;
  }

  function renderKpis(aggregate) {
    $("totalCapacityKpi").textContent = fmtMw(aggregate.capacity);
    $("facilityCountKpi").textContent = fmt(visibleFacilities.length);
    $("generatorCountKpi").textContent = fmt(aggregate.generatorCount);
    $("entityCountKpi").textContent = fmt(aggregate.entities.size);
    $("mappedContext").textContent = `${fmt(aggregate.mappedCount)} mapped`;
    $("statusContext").textContent = `${fmt(aggregate.activeGeneratorCount)} active · ${fmt(aggregate.retiredGeneratorCount)} retired`;
    $("stateCountContext").textContent = `${fmt(aggregate.states.size)} states / territories`;
    $("retirementOutlookKpi").textContent = fmtMw(aggregate.retirementThrough2035);
    $("capacityContext").textContent = visibleFacilities.length ? `${fmt(visibleFacilities.length)} facilities in current selection` : "No facilities match the current filters";
  }

  function chartTheme() {
    const style = getComputedStyle(document.documentElement);
    return {
      text: style.getPropertyValue("--muted").trim(),
      grid: style.getPropertyValue("--border").trim(),
      accent: style.getPropertyValue("--accent").trim(),
      cyan: style.getPropertyValue("--cyan").trim(),
      orange: style.getPropertyValue("--orange").trim(),
    };
  }

  function baseChartOptions({ horizontal = false, tooltipSuffix = " MW", onClick = null } = {}) {
    const theme = chartTheme();
    const valueAxis = {
      grid: { color: theme.grid },
      ticks: {
        color: theme.text,
        font: { size: 9 },
        maxTicksLimit: 5,
        callback: (value) => compactFormatter.format(Number(value)),
      },
      border: { display: false },
    };
    const categoryAxis = {
      grid: { display: !horizontal, color: theme.grid },
      ticks: {
        color: theme.text,
        font: { size: 9 },
        autoSkip: !horizontal,
        maxTicksLimit: horizontal ? 12 : 8,
        callback: function categoryLabel(value) {
          const label = String(this.getLabelForValue(value));
          if (!horizontal) return label;

          // Keep the plotting area useful in narrow drawers while preserving the
          // complete category in Chart.js' default tooltip title.
          const chartWidth = this.chart?.width || window.innerWidth;
          const maxLength = window.innerWidth <= 480
            ? (chartWidth < 360 ? 17 : 21)
            : window.innerWidth <= 760
              ? 28
              : 44;
          return label.length > maxLength ? `${label.slice(0, maxLength - 1).trimEnd()}…` : label;
        },
      },
      border: { display: false },
    };
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      indexAxis: horizontal ? "y" : "x",
      interaction: { mode: "nearest", intersect: true },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (context) => `${fmt(Number(context.raw), Number(context.raw) < 100 ? 1 : 0)}${tooltipSuffix}` } },
      },
      scales: horizontal ? { x: valueAxis, y: categoryAxis } : { x: categoryAxis, y: valueAxis },
      onClick,
    };
  }

  function ensureCharts() {
    if (charts.technology || chartFailureMessage) return;
    if (typeof Chart === "undefined") {
      chartFailureMessage = "Charts are unavailable because Chart.js could not be loaded.";
      ["technology", "state", "additions", "retirement"].forEach((name) => setChartEmptyState(name, true, chartFailureMessage));
      return;
    }
    const theme = chartTheme();
    try {
      charts.technology = new Chart($("technologyChart"), {
        type: "bar",
        data: { labels: [], datasets: [{ data: [], backgroundColor: [], borderWidth: 0, borderRadius: 4, barThickness: 13 }] },
        options: baseChartOptions({
          horizontal: true,
          onClick: (_, elements) => {
            if (!elements.length) return;
            const technology = charts.technology.data.labels[elements[0].index];
            controls.technology.setSelected(new Set([technology]));
            showToast(`Filtered to ${technology}`);
          },
        }),
      });
      charts.state = new Chart($("stateChart"), {
        type: "bar",
        data: { labels: [], datasets: [{ data: [], backgroundColor: theme.accent, borderWidth: 0, borderRadius: 4, barThickness: 12 }] },
        options: baseChartOptions({
          horizontal: true,
          onClick: (_, elements) => {
            if (!elements.length) return;
            const state = charts.state.data.labels[elements[0].index];
            controls.state.setSelected(new Set([state]));
            showToast(`Filtered to ${state}`);
          },
        }),
      });
      charts.additions = new Chart($("additionsChart"), {
        type: "line",
        data: { labels: [], datasets: [{ data: [], borderColor: theme.cyan, backgroundColor: `${theme.cyan}22`, borderWidth: 2, pointRadius: 0, pointHoverRadius: 3, tension: 0.2, fill: true }] },
        options: baseChartOptions(),
      });
      charts.retirement = new Chart($("retirementChart"), {
        type: "bar",
        data: { labels: [], datasets: [{ data: [], backgroundColor: theme.orange, borderWidth: 0, borderRadius: 3 }] },
        options: baseChartOptions(),
      });
    } catch (error) {
      console.error("Charts could not be initialized", error);
      destroyCharts();
      chartFailureMessage = "Charts could not be initialized.";
      ["technology", "state", "additions", "retirement"].forEach((name) => setChartEmptyState(name, true, chartFailureMessage));
      showToast(chartFailureMessage);
    }
  }

  function renderCharts(aggregate) {
    ensureCharts();
    if (!charts.technology) {
      if (chartFailureMessage) {
        ["technology", "state", "additions", "retirement"].forEach((name) => setChartEmptyState(name, true, chartFailureMessage));
      }
      return;
    }

    const technology = topEntries(aggregate.technologyMw, 11);
    setChartEmptyState("technology", technology.length === 0);
    charts.technology.data.labels = technology.map(([name]) => name);
    charts.technology.data.datasets[0].data = technology.map(([, value]) => value);
    charts.technology.data.datasets[0].backgroundColor = technology.map(([name]) => technologyColor(name));
    charts.technology.update("none");

    const states = topEntries(aggregate.stateMw, 10);
    setChartEmptyState("state", states.length === 0);
    charts.state.data.labels = states.map(([name]) => name);
    charts.state.data.datasets[0].data = states.map(([, value]) => value);
    charts.state.update("none");

    const operatingYears = [...aggregate.operatingYearMw.entries()].sort((a, b) => a[0] - b[0]);
    setChartEmptyState("additions", !operatingYears.some(([, value]) => value > 0));
    charts.additions.data.labels = operatingYears.map(([year]) => String(year));
    charts.additions.data.datasets[0].data = operatingYears.map(([, value]) => value);
    charts.additions.update("none");

    const retirementYears = [];
    for (let year = APP_CONFIG.asOfYear; year <= APP_CONFIG.retirementChartEndYear; year += 1) {
      retirementYears.push([year, aggregate.retirementYearMw.get(year) || 0]);
    }
    setChartEmptyState("retirement", !retirementYears.some(([, value]) => value > 0), "No reported retirements in this horizon");
    charts.retirement.data.labels = retirementYears.map(([year]) => String(year));
    charts.retirement.data.datasets[0].data = retirementYears.map(([, value]) => value);
    charts.retirement.update("none");
  }

  function renderLegend(aggregate) {
    const entries = topEntries(aggregate.technologyMw, 7);
    const represented = new Set(entries.map(([technology]) => technology));
    let otherCapacity = 0;
    let otherCount = 0;
    for (const [technology, capacity] of aggregate.technologyMw) {
      if (represented.has(technology)) continue;
      otherCapacity += capacity;
      otherCount += 1;
    }
    const technologyRows = entries.length ? entries.map(([technology, mw]) => `
      <div class="legend-row">
        <i class="legend-dot" style="--legend-color:${technologyColor(technology)}"></i>
        <span title="${escapeHtml(technology)}">${escapeHtml(technology)}</span>
        <small>${compactFormatter.format(mw)} MW</small>
      </div>`).join("") : '<div class="multi-empty">No visible facilities</div>';
    const otherRow = otherCount ? `
      <div class="legend-row">
        <i class="legend-dot" style="--legend-color:${OTHER_MAP_COLOR}"></i>
        <span title="${fmt(otherCount)} additional technologies">Other (${fmt(otherCount)})</span>
        <small>${compactFormatter.format(otherCapacity)} MW</small>
      </div>` : "";
    const legendSummary = aggregate.technologyMw.size
      ? `<p class="legend-summary">Top ${fmt(entries.length)} of ${fmt(aggregate.technologyMw.size)} technologies by filtered MW${otherCount ? "; all others use gray" : ""}.</p>`
      : "";
    const heatExplanation = filters.heat
      ? "<p><strong>Heat</strong><span>Brighter areas have more filtered MW</span></p>"
      : "";
    const sizeExplanation = mapUsesAggregation()
      ? "Facilities in each cluster"
      : filters.scaleDots ? "Filtered nameplate MW" : "Uniform markers (scaling off)";
    const displayExplanation = mapUsesAggregation()
      ? "Nearby facilities grouped at this zoom; select a cluster to zoom in"
      : "One marker per mapped facility";
    $("legendContent").innerHTML = `${legendSummary}${technologyRows}${otherRow}
      <div class="legend-explanations">
        <p><strong>Display</strong><span>${displayExplanation}</span></p>
        <p><strong>Size</strong><span>${sizeExplanation}</span></p>
        <p><strong>Outline</strong><span>Orange retired-only · bright mixed history</span></p>
        ${heatExplanation}
      </div>`;
  }

  function sortedVisibleFacilities() {
    const result = [...visibleFacilities];
    switch ($("facilitySort").value) {
      case "capacity-asc": result.sort((a, b) => a.capacity - b.capacity); break;
      case "name-asc": result.sort((a, b) => a.facility.name.localeCompare(b.facility.name)); break;
      case "year-desc": result.sort((a, b) => (b.lastYear || 0) - (a.lastYear || 0)); break;
      case "year-asc": result.sort((a, b) => (a.firstYear || 9999) - (b.firstYear || 9999)); break;
      default: result.sort((a, b) => b.capacity - a.capacity);
    }
    return result;
  }

  function facilitySortDescription() {
    const descriptions = {
      "capacity-desc": "Highest visible capacity first",
      "capacity-asc": "Lowest visible capacity first",
      "name-asc": "Facility name A to Z",
      "year-desc": "Newest operating year first",
      "year-asc": "Oldest operating year first",
    };
    return descriptions[$("facilitySort").value] || descriptions["capacity-desc"];
  }

  function renderFacilityList() {
    const pageSize = APP_CONFIG.facilityPageSize;
    const sorted = sortedVisibleFacilities();
    const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
    currentPage = Math.min(currentPage, pageCount);
    const page = sorted.slice((currentPage - 1) * pageSize, currentPage * pageSize);
    $("facilityListCount").textContent = `${fmt(sorted.length)} facilities`;
    const sortContext = $("facilitySortContext") || $("facilityListCount").parentElement?.querySelector("small");
    if (sortContext) sortContext.textContent = facilitySortDescription();
    $("pageLabel").textContent = `Page ${currentPage} of ${pageCount}`;
    $("previousPageBtn").disabled = currentPage <= 1;
    $("nextPageBtn").disabled = currentPage >= pageCount;
    $("facilityList").innerHTML = page.length ? page.map((selection) => {
      const { facility } = selection;
      const status = selection.activeCount && selection.retiredCount ? "Mixed history" : selection.activeCount ? "Active" : "Retired";
      return `<button class="facility-row" data-facility-index="${facility.index}" type="button" aria-label="Open ${escapeHtml(facility.name)} facility profile">
        <h3>${escapeHtml(facility.name)}</h3>
        <strong class="facility-mw">${fmtMw(selection.capacity)}</strong>
        <p>${escapeHtml(facility.entity)} · ${escapeHtml(facility.state)} · ${escapeHtml(selection.dominantTechnology)}</p>
        <div class="row-meta"><span class="tiny-tag">${fmt(selection.generatorCount)} gen.</span><span class="tiny-tag">${status}</span></div>
      </button>`;
    }).join("") : '<div class="multi-empty">No facilities match the current filters.</div>';
  }

  function setTab(tab) {
    const configuration = {
      overview: ["overviewTab", "overviewView"],
      facilities: ["facilitiesTab", "facilitiesView"],
      data: ["dataTab", "dataView"],
    };
    if (!configuration[tab]) return;
    currentTab = tab;
    Object.entries(configuration).forEach(([key, [tabId, viewId]]) => {
      const active = key === tab;
      $(tabId).classList.toggle("active", active);
      $(tabId).setAttribute("aria-selected", String(active));
      $(tabId).tabIndex = active ? 0 : -1;
      $(viewId).classList.toggle("active", active);
      $(viewId).hidden = !active;
    });
    if (tab === "overview") setTimeout(() => Object.values(charts).forEach((chart) => chart?.resize()), 0);
    syncHashState();
  }

  function openFacility(index) {
    const selection = visibleByIndex.get(index);
    if (!selection) return;
    const activeElement = isFocusable(document.activeElement) ? document.activeElement : null;
    const activePanel = activeElement?.closest(".side-panel");
    detailReturnFocus = activePanel && panelUsesDrawer(activePanel.id)
      ? activePanel.id === "filterPanel" ? $("filtersMobileBtn") : $("insightsMobileBtn")
      : activeElement;
    currentDetailIndex = index;
    renderFacilityDetail(selection);
    $("detailDrawer").classList.add("open");
    $("detailDrawer").setAttribute("aria-hidden", "false");
    $("detailDrawer").setAttribute("role", "dialog");
    $("detailDrawer").setAttribute("aria-labelledby", "facilityDetailTitle");
    app.classList.add("detail-active");
    if (finite(selection.facility.lat) && finite(selection.facility.lon)) map.panTo([selection.facility.lat, selection.facility.lon], { animate: true });
    closeMobilePanels(false);
    $("insightsPanel").setAttribute("aria-hidden", "true");
    $("insightsPanel").inert = true;
    setTimeout(() => focusElement($("detailCloseBtn")), 0);
  }

  function closeFacility(restoreFocus = false) {
    const wasOpen = $("detailDrawer").classList.contains("open");
    currentDetailIndex = null;
    $("detailDrawer").classList.remove("open");
    $("detailDrawer").setAttribute("aria-hidden", "true");
    app.classList.remove("detail-active");
    if (wasOpen) syncResponsiveState();
    if (restoreFocus && wasOpen) focusElement(detailReturnFocus);
    if (wasOpen) detailReturnFocus = null;
  }

  function detailGeneratorRows(selection) {
    return selection.generatorIndexes.map((position) => {
      const generator = rawGenerators[position];
      return {
        id: generator[G.ID] || "—",
        nameplate: generator[G.NAMEPLATE],
        summer: generator[G.SUMMER],
        winter: generator[G.WINTER],
        technology: dictionaries.technologies[generator[G.TECH]] || "Unknown",
        energy: dictionaries.energySources[generator[G.ENERGY]] || "—",
        prime: dictionaries.primeMovers[generator[G.PRIME]] || "—",
        operatingYear: generator[G.OP_YEAR],
        retirementYear: generator[G.RET_YEAR],
        status: dictionaries.statuses[generator[G.STATUS]] || sourceLabels[generator[G.SOURCE]],
        source: generator[G.SOURCE],
      };
    }).sort((a, b) => (b.nameplate || 0) - (a.nameplate || 0));
  }

  function renderFacilityDetail(selection) {
    const { facility } = selection;
    const generators = detailGeneratorRows(selection);
    const technologies = topEntries(selection.technologyMw, 20);
    const mapsUrl = finite(facility.lat) && finite(facility.lon)
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${facility.lat},${facility.lon}`)}`
      : null;
    $("detailContent").innerHTML = `
      <header class="detail-header">
        <p class="eyebrow">Plant ID ${escapeHtml(facility.id)}</p>
        <h2 id="facilityDetailTitle">${escapeHtml(facility.name)}</h2>
        <p>${escapeHtml(facility.entity)} · ${escapeHtml(facility.county ? `${facility.county} County, ` : "")}${escapeHtml(facility.state)} · ${escapeHtml(facility.sector)}</p>
        <div class="detail-actions">
          ${mapsUrl ? `<a href="${mapsUrl}" target="_blank" rel="noopener">Open in Google Maps</a>` : ""}
          <button type="button" data-copy-plant="${escapeHtml(facility.id)}">Copy plant ID</button>
          <button type="button" data-filter-entity="${escapeHtml(facility.entity)}">Search this entity</button>
        </div>
      </header>
      <div class="detail-grid">
        <div class="detail-metric"><span>Visible capacity</span><strong>${fmtMw(selection.capacity)}</strong></div>
        <div class="detail-metric"><span>Generators</span><strong>${fmt(selection.generatorCount)}</strong></div>
        <div class="detail-metric"><span>Operating years</span><strong>${selection.firstYear ? `${selection.firstYear}–${selection.lastYear}` : "—"}</strong></div>
        <div class="detail-metric"><span>Earliest retirement</span><strong>${selection.earliestRetirement || "—"}</strong></div>
      </div>
      <section class="detail-section">
        <h3>Technology mix</h3>
        <div class="tech-pills">${technologies.map(([technology, mw]) => `<span class="tech-pill"><i style="--tech-color:${technologyColor(technology)}"></i>${escapeHtml(technology)} · ${fmtMw(mw)}</span>`).join("")}</div>
      </section>
      <section class="detail-section">
        <h3 id="generatorTableTitle">Generators in current selection (${fmt(generators.length)} of ${fmt(facility.count)})</h3>
        <p class="table-scroll-hint" id="generatorTableHint"><span aria-hidden="true">↔</span> Scroll horizontally for capacity, dates, fuel, and prime mover</p>
        <div class="generator-table-wrap" role="region" aria-labelledby="generatorTableTitle" aria-describedby="generatorTableHint" tabindex="0">
          <table class="generator-table">
            <thead><tr><th>ID</th><th>Source</th><th>Detailed status</th><th>Technology</th><th class="number">MW</th><th class="number">Summer</th><th class="number">Winter</th><th>Online</th><th>Retirement</th><th>Fuel</th><th>Prime mover</th></tr></thead>
            <tbody>${generators.map((generator) => `<tr>
              <td>${escapeHtml(generator.id)}</td>
              <td><span class="status-badge" style="--status-color:${generator.source === 0 ? "var(--green)" : "var(--orange)"}" title="${escapeHtml(`${sourceLabels[generator.source]} source extract`)}">${escapeHtml(sourceLabels[generator.source])}</span></td>
              <td>${escapeHtml(generator.status)}</td>
              <td>${escapeHtml(generator.technology)}</td>
              <td class="number">${fmt(generator.nameplate, 1)}</td>
              <td class="number">${fmt(generator.summer, 1)}</td>
              <td class="number">${fmt(generator.winter, 1)}</td>
              <td>${generator.operatingYear || "—"}</td>
              <td>${generator.retirementYear || "—"}</td>
              <td>${escapeHtml(generator.energy)}</td>
              <td>${escapeHtml(generator.prime)}</td>
            </tr>`).join("")}</tbody>
          </table>
        </div>
      </section>`;

    $("detailContent").querySelector("[data-copy-plant]")?.addEventListener("click", async (event) => {
      await copyWithFeedback(event.currentTarget.dataset.copyPlant, "Plant ID copied");
    });
    $("detailContent").querySelector("[data-filter-entity]")?.addEventListener("click", (event) => {
      $("globalSearch").value = event.currentTarget.dataset.filterEntity;
      filters.search = normalize(event.currentTarget.dataset.filterEntity);
      closeFacility();
      scheduleRender(true);
      showToast("Searching by entity");
    });
  }

  function fitSelection() {
    const coordinates = visibleFacilities
      .filter((selection) => finite(selection.facility.lat) && finite(selection.facility.lon))
      .map((selection) => [selection.facility.lat, selection.facility.lon]);
    if (!coordinates.length) {
      showToast("No mapped facilities in the current selection");
      return;
    }
    map.fitBounds(L.latLngBounds(coordinates), { padding: [45, 45], maxZoom: 9 });
  }

  function resetFilters() {
    filters.active = true;
    filters.retired = true;
    filters.search = "";
    $("globalSearch").value = "";
    controls.technology.selectAll(false);
    controls.state.selectAll(false);
    controls.sector.selectAll(false);
    filters.technologies = new Set(universe.technologies);
    filters.states = new Set(universe.states);
    filters.sectors = new Set(universe.sectors);
    controls.operatingYear.setValues(universe.operatingYearMin, universe.operatingYearMax, false);
    controls.capacity.setValues(0, universe.capacityMax, false);
    filters.operatingYearMin = universe.operatingYearMin;
    filters.operatingYearMax = universe.operatingYearMax;
    filters.capacityMin = 0;
    filters.capacityMax = universe.capacityMax;
    filters.heat = false;
    filters.scaleDots = true;
    $("heatToggle").checked = false;
    $("scaleDotsToggle").checked = true;
    currentPage = 1;
    syncStatusButtons();
    syncTechnologyGroupButtons();
    closeFacility();
    resetMapExtent();
    replaceUrl(`${location.pathname}${location.search}`);
    lastHandledNavigationHash = "";
    render();
    showToast("Filters reset");
  }

  function toggleBasemap() {
    const next = activeTiles === darkTiles ? lightTiles : darkTiles;
    map.removeLayer(activeTiles);
    next.addTo(map);
    activeTiles = next;
    setBasemapStatus();
    showToast(next === darkTiles ? "Dark basemap" : "Light basemap");
  }

  function toggleTheme() {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    storageSet("generation-intelligence-theme", next);
    applyThemeMetadata(next);
    const desiredTiles = next === "dark" ? darkTiles : lightTiles;
    if (activeTiles !== desiredTiles) {
      map.removeLayer(activeTiles);
      desiredTiles.addTo(map);
      activeTiles = desiredTiles;
    }
    setBasemapStatus();
    destroyCharts();
    renderCharts(lastAggregate || aggregateSelection());
  }

  function destroyCharts() {
    Object.keys(charts).forEach((key) => {
      charts[key]?.destroy();
      charts[key] = null;
    });
  }

  function setLegendExpanded(expanded, userInitiated = false) {
    legendExpanded = expanded;
    if (userInitiated) legendUserToggled = true;
    $("legendContent").style.display = legendExpanded ? "grid" : "none";
    $("legendToggle").setAttribute("aria-expanded", String(legendExpanded));
    $("legendToggle").lastElementChild.textContent = legendExpanded ? "−" : "+";
  }

  function toggleLegend() {
    setLegendExpanded(!legendExpanded, true);
  }

  function csvEscape(value, neutralizeFormula = false) {
    let text = String(value ?? "");
    if (neutralizeFormula && /^[\t\r\n ]*[=+\-@]/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function exportFacilities() {
    if (!visibleFacilities.length) {
      showToast("No facilities to export");
      return;
    }
    const headers = [
      "Plant ID", "Facility Name", "Entity Name", "State", "County", "Sector",
      "Visible Nameplate MW", "Active MW", "Retired MW", "Visible Generators",
      "Technologies", "First Operating Year", "Latest Operating Year",
      "Earliest Reported Retirement Year", "Latitude", "Longitude",
    ];
    const rows = sortedVisibleFacilities().map((selection) => {
      const { facility } = selection;
      return [
        facility.id, facility.name, facility.entity, facility.state, facility.county, facility.sector,
        selection.capacity.toFixed(1), selection.activeMw.toFixed(1), selection.retiredMw.toFixed(1), selection.generatorCount,
        [...selection.technologyMw.keys()].join("; "), selection.firstYear || "", selection.lastYear || "",
        selection.earliestRetirement || "", facility.lat ?? "", facility.lon ?? "",
      ];
    });
    const formulaSafeTextColumns = new Set([0, 1, 2, 3, 4, 5, 10]);
    const csv = [headers.map((value) => csvEscape(value)), ...rows.map((row) => (
      row.map((value, index) => csvEscape(value, formulaSafeTextColumns.has(index)))
    ))].map((row) => row.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "us-generation-facilities-filtered.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(`${fmt(rows.length)} facilities exported`);
  }

  async function copyText(text) {
    let clipboardError = null;
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch (error) {
        clipboardError = error;
      }
    }
    const previousFocus = isFocusable(document.activeElement) ? document.activeElement : null;
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.readOnly = true;
    textarea.setAttribute("aria-hidden", "true");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    try {
      textarea.select();
      const copied = document.execCommand("copy");
      if (!copied) throw clipboardError || new Error("The browser denied clipboard access.");
    } finally {
      textarea.remove();
      focusElement(previousFocus);
    }
  }

  async function copyWithFeedback(text, successMessage) {
    try {
      await copyText(text);
      showToast(successMessage);
      return true;
    } catch (error) {
      console.error("Copy failed", error);
      showToast("Could not copy. Select and copy the value manually.");
      return false;
    }
  }

  async function copyShareLink() {
    syncHashState();
    await copyWithFeedback(location.href, "Share link copied");
  }

  function safelyDecodeHashValue(value, key) {
    try {
      return decodeURIComponent(value);
    } catch (_) {
      hashWarnings.add(`The shared ${key} filter contained malformed encoding and was ignored.`);
      return value;
    }
  }

  function setFromHashSet(params, key, universeValues) {
    if (!params.has(key)) return new Set(universeValues);
    const raw = params.get(key) || "";
    if (!raw) return new Set();
    const requested = raw.split("|").map((value) => safelyDecodeHashValue(value, key));
    const values = requested.filter((value) => universeValues.includes(value));
    if (!values.length && requested.length) {
      hashWarnings.add(`The shared ${key} filter no longer matches this dataset; all values were restored.`);
      return new Set(universeValues);
    }
    if (values.length !== requested.length) hashWarnings.add(`Some shared ${key} values are unavailable in this dataset.`);
    return new Set(values);
  }

  function rangeFromHash(params, key, minimum, maximum) {
    if (!params.has(key)) return null;
    const parts = (params.get(key) || "").split("-");
    if (parts.length !== 2) {
      hashWarnings.add(`The shared ${key} range was invalid and was ignored.`);
      return null;
    }
    let low = Number(parts[0]);
    let high = Number(parts[1]);
    if (!Number.isFinite(low) || !Number.isFinite(high)) {
      hashWarnings.add(`The shared ${key} range was invalid and was ignored.`);
      return null;
    }
    low = Math.max(minimum, Math.min(maximum, low));
    high = Math.max(minimum, Math.min(maximum, high));
    if (low > high) [low, high] = [high, low];
    return [low, high];
  }

  function applyHashState() {
    try {
      const params = new URLSearchParams(location.hash.length > 1 ? location.hash.slice(1) : "");
      filters.active = params.get("active") !== "0";
      filters.retired = params.get("retired") !== "0";
      if (!filters.active && !filters.retired) filters.active = true;
      filters.search = normalize(params.get("q") || "");
      $("globalSearch").value = params.get("q") || "";
      filters.technologies = setFromHashSet(params, "tech", universe.technologies);
      filters.states = setFromHashSet(params, "state", universe.states);
      filters.sectors = setFromHashSet(params, "sector", universe.sectors);
      controls.technology.setSelected(filters.technologies, false);
      controls.state.setSelected(filters.states, false);
      controls.sector.setSelected(filters.sectors, false);

      const operating = rangeFromHash(params, "year", universe.operatingYearMin, universe.operatingYearMax);
      const operatingRange = operating || [universe.operatingYearMin, universe.operatingYearMax];
      [filters.operatingYearMin, filters.operatingYearMax] = operatingRange;
      controls.operatingYear.setValues(...operatingRange, false);
      const capacity = rangeFromHash(params, "mw", 0, universe.capacityMax);
      const capacityRange = capacity || [0, universe.capacityMax];
      [filters.capacityMin, filters.capacityMax] = capacityRange;
      controls.capacity.setValues(...capacityRange, false);
      const heatRequested = params.get("heat") === "1";
      filters.heat = heatRequested && typeof L.heatLayer === "function";
      if (heatRequested && !filters.heat) hashWarnings.add("The shared heatmap setting is unavailable in this browser.");
      filters.scaleDots = params.get("scale") !== "0";
      $("heatToggle").checked = filters.heat;
      $("scaleDotsToggle").checked = filters.scaleDots;
      syncStatusButtons();
      syncTechnologyGroupButtons();
      const tab = params.get("tab");
      setTab(["overview", "facilities", "data"].includes(tab) ? tab : "overview");
    } catch (error) {
      console.warn("Shared view state could not be applied", error);
      hashWarnings.add("The shared view could not be fully restored; safe defaults were used.");
    }
  }

  function handleLocationStateChange() {
    if (location.hash === lastHandledNavigationHash) return;
    lastHandledNavigationHash = location.hash;
    hashWarnings.clear();
    applyHashState();
    currentPage = 1;
    render();
    if (hashWarnings.size) showToast([...hashWarnings][0]);
  }

  function syncHashState() {
    const params = new URLSearchParams();
    if (!filters.active) params.set("active", "0");
    if (!filters.retired) params.set("retired", "0");
    if (filters.search) params.set("q", $("globalSearch").value.trim());
    if (filters.technologies.size !== universe.technologies.length) params.set("tech", [...filters.technologies].map(encodeURIComponent).join("|"));
    if (filters.states.size !== universe.states.length) params.set("state", [...filters.states].map(encodeURIComponent).join("|"));
    if (filters.sectors.size !== universe.sectors.length) params.set("sector", [...filters.sectors].map(encodeURIComponent).join("|"));
    if (filters.operatingYearMin !== universe.operatingYearMin || filters.operatingYearMax !== universe.operatingYearMax) params.set("year", `${Math.round(filters.operatingYearMin)}-${Math.round(filters.operatingYearMax)}`);
    if (filters.capacityMin !== 0 || filters.capacityMax !== universe.capacityMax) params.set("mw", `${Math.round(filters.capacityMin)}-${Math.round(filters.capacityMax)}`);
    if (filters.heat) params.set("heat", "1");
    if (!filters.scaleDots) params.set("scale", "0");
    if (currentTab !== "overview") params.set("tab", currentTab);
    const hash = params.toString();
    const next = `${location.pathname}${location.search}${hash ? `#${hash}` : ""}`;
    replaceUrl(next);
    lastHandledNavigationHash = hash ? `#${hash}` : "";
  }

  function populateMetadata() {
    $("dataSnapshotTitle").textContent = `${metadata.snapshot || "Bundled"} snapshot`;
    $("metadataFacilities").textContent = fmt(metadata.facilityCount);
    $("metadataGenerators").textContent = fmt(metadata.generatorCount);
    const mappedPercent = metadata.facilityCount > 0 ? (metadata.mappedFacilityCount / metadata.facilityCount) * 100 : 0;
    $("metadataMapped").textContent = `${fmt(metadata.mappedFacilityCount)} (${mappedPercent.toFixed(1)}%)`;
    $("metadataGenerated").textContent = fmtDateTime(metadata.generatedAt);
    const retirementKpiLabel = $("retirementOutlookKpi").parentElement?.querySelector("span");
    if (retirementKpiLabel) retirementKpiLabel.textContent = `Reported retirements through ${APP_CONFIG.retirementKpiEndYear}`;
    const retirementHorizonLabel = $("retirementChart").closest(".chart-card")?.querySelector(".card-heading > span");
    if (retirementHorizonLabel) retirementHorizonLabel.textContent = `${APP_CONFIG.asOfYear}–${APP_CONFIG.retirementChartEndYear}`;
    const qualityLabels = {
      generatorRowsMissingCoordinates: "Generator rows missing valid coordinates",
      facilitiesMissingCoordinates: "Facilities unavailable on the map",
      generatorRowsMissingNameplate: "Generator rows missing nameplate capacity",
      generatorRowsMissingOperatingYear: "Generator rows missing operating year",
      generatorRowsRetirementBeforeOperation: "Retirement year before operating year",
    };
    const quality = metadata.quality || {};
    if (Object.prototype.hasOwnProperty.call(quality, "sourceRowsSkippedBlank")) {
      qualityLabels.sourceRowsSkippedBlank = "Blank source rows excluded";
    }
    $("qualityList").innerHTML = Object.entries(qualityLabels).map(([key, label]) => `
      <div class="quality-row"><span>${escapeHtml(label)}</span><strong>${fmt(quality[key] || 0)}</strong></div>`).join("");

    const sourceStats = Array.isArray(metadata.sourceStats)
      ? metadata.sourceStats
      : Object.entries(metadata.sourceStats || {}).map(([classification, value]) => ({ classification, ...(value || {}) }));
    const sourceHost = $("dataSnapshotTitle").closest(".data-card");
    if (sourceHost && sourceStats.length) {
      let sourceSection = sourceHost.querySelector("[data-source-stats]");
      if (!sourceSection) {
        sourceSection = document.createElement("div");
        sourceSection.dataset.sourceStats = "";
        sourceHost.appendChild(sourceSection);
      }
      sourceSection.innerHTML = `
        <p class="eyebrow">Source extracts</p>
        <dl class="metadata-list">${sourceStats.map((source) => {
          const file = source.file || source.filename || source.sourceFile || source.classification || "Source extract";
          const retained = finite(source.retainedRowCount) ? fmt(source.retainedRowCount) : "—";
          const input = finite(source.inputRowCount) ? fmt(source.inputRowCount) : "—";
          const classification = source.classification
            ? `${escapeHtml(String(source.classification).replace(/^\w/, (character) => character.toUpperCase()))} · `
            : "";
          const optionalCount = Array.isArray(source.missingOptionalColumns) ? source.missingOptionalColumns.length : 0;
          const optionalText = optionalCount ? ` · ${fmt(optionalCount)} optional field${optionalCount === 1 ? "" : "s"} unavailable` : "";
          return `<div><dt>${escapeHtml(file)}</dt><dd>${classification}${retained} of ${input} rows retained${optionalText}</dd></div>`;
        }).join("")}</dl>`;
    }
  }

  function initializeRetryControl() {
    const retryButton = $("retryBtn");
    if (!retryButton || retryButton.dataset.controllerBound === "true") return;
    retryButton.dataset.controllerBound = "true";
    retryButton.addEventListener("click", () => location.reload());
  }

  async function boot() {
    try {
      initializeRetryControl();
      if (!DATA || DATA.schemaVersion !== 1) throw new Error("The bundled generation data store is missing or incompatible.");
      if (typeof L === "undefined") throw new Error("Leaflet could not be loaded. Check the network connection or vendor the dependency locally.");

      const savedTheme = storageGet("generation-intelligence-theme");
      if (["dark", "light"].includes(savedTheme)) document.documentElement.dataset.theme = savedTheme;
      applyThemeMetadata(document.documentElement.dataset.theme);

      setLoading(18, "Indexing facilities and generator records…");
      await new Promise((resolve) => setTimeout(resolve, 30));
      const counts = prepareModels();

      setLoading(54, "Building the interactive map…");
      await new Promise((resolve) => setTimeout(resolve, 30));
      initializeMap();

      setLoading(76, "Preparing filters and analytics…");
      await new Promise((resolve) => setTimeout(resolve, 30));
      initializeControls(counts);
      render();

      setLoading(100, "Ready");
      await new Promise((resolve) => setTimeout(resolve, 180));
      loadingScreen.classList.add("hidden");
      app.setAttribute("aria-busy", "false");
      const notices = [];
      if (hashWarnings.size) notices.push([...hashWarnings][0]);
      if (chartFailureMessage) notices.push(chartFailureMessage);
      if (notices.length) showToast(notices.join(" "));
    } catch (error) {
      fail(error.message || "The application could not start.", error);
    }
  }

  window.GenerationApp = { openFacility };
  boot();
})();
