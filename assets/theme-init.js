(() => {
  "use strict";

  const themeKey = "generation-intelligence-theme";
  let theme = document.documentElement.dataset.theme || "dark";

  try {
    const savedTheme = window.localStorage.getItem(themeKey);
    if (savedTheme === "dark" || savedTheme === "light") theme = savedTheme;
  } catch (_) {
    // Storage can be unavailable in hardened or opaque browser contexts.
  }

  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute(
    "content",
    theme === "light" ? "#f4f7fb" : "#0a1220",
  );
})();
