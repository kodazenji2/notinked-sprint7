/**
 * NotInked embeddable risk badge.
 *
 * Usage on any site (Tydro, Nado, or anyone else):
 *
 *   <div data-notinked-address="0x..."></div>
 *   <script src="https://YOUR_DEPLOYED_DOMAIN/widget.js"></script>
 *
 * Finds every element with a data-notinked-address attribute, calls the
 * public risk-check API, and renders a small inline badge. No build step,
 * no framework dependency — works on any site.
 */
(function () {
  var API_BASE = document.currentScript?.src
    ? new URL(document.currentScript.src).origin
    : "";

  var STYLES = {
    red: { bg: "#FF5C5C1a", border: "#FF5C5C66", color: "#FF5C5C", label: "⚠ Flagged" },
    yellow: { bg: "#F5C4511a", border: "#F5C45166", color: "#F5C451", label: "⚠ Caution" },
    green: { bg: "#7C83941a", border: "#7C839466", color: "#7C8394", label: "✓ Not flagged" },
  };

  function renderBadge(el, risk, reasons) {
    var style = STYLES[risk] || STYLES.green;
    el.style.display = "inline-flex";
    el.style.alignItems = "center";
    el.style.gap = "4px";
    el.style.padding = "3px 8px";
    el.style.borderRadius = "6px";
    el.style.fontSize = "11px";
    el.style.fontFamily = "monospace";
    el.style.fontWeight = "600";
    el.style.background = style.bg;
    el.style.border = "1px solid " + style.border;
    el.style.color = style.color;
    el.textContent = style.label;
    el.title = Array.isArray(reasons) ? reasons.join(" · ") : "Checked via NotInked";
  }

  function checkAddress(el) {
    var address = el.getAttribute("data-notinked-address");
    if (!address) return;

    el.textContent = "…";
    el.style.opacity = "0.6";

    fetch(API_BASE + "/api/public/risk-check?address=" + address)
      .then(function (res) {
        return res.json();
      })
      .then(function (data) {
        el.style.opacity = "1";
        renderBadge(el, data.risk, data.reasons);
      })
      .catch(function () {
        el.style.opacity = "1";
        el.textContent = "risk check unavailable";
      });
  }

  function init() {
    var elements = document.querySelectorAll("[data-notinked-address]");
    elements.forEach(checkAddress);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
