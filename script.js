(() => {
  "use strict";

  const body = document.body;
  const toggle = document.getElementById("menu-toggle");
  const panel = document.getElementById("mobile-menu");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const desktopLayout = window.matchMedia("(min-width: 641px)");
  let menuOpen = false;

  function setMenu(open, restoreFocus = false) {
    if (!toggle || !panel) return;
    menuOpen = open;
    body.classList.toggle("menu-open", open);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    panel.setAttribute("aria-hidden", String(!open));
    panel.inert = !open;
    if (open) {
      panel.querySelector("a")?.focus({ preventScroll: true });
    } else if (restoreFocus) {
      toggle.focus({ preventScroll: true });
    }
  }

  if (toggle && panel) {
    toggle.addEventListener("click", () => setMenu(!menuOpen));
    panel.querySelectorAll('a[href^="#"]').forEach((link) => {
      link.addEventListener("click", () => setMenu(false));
    });
    panel.addEventListener("click", (event) => {
      if (event.target === panel) setMenu(false, true);
    });
    document.addEventListener("keydown", (event) => {
      if (!menuOpen) return;
      if (event.key === "Escape") {
        event.preventDefault();
        setMenu(false, true);
        return;
      }
      if (event.key !== "Tab") return;
      const focusables = [toggle, ...panel.querySelectorAll("a")];
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    desktopLayout.addEventListener("change", (event) => {
      if (event.matches && menuOpen) setMenu(false);
    });
  }

  // Enhancement only: static content remains fully visible without JS or observers.
  if ("IntersectionObserver" in window && !reducedMotion.matches) {
    body.classList.add("js-motion");
    const sectionObserver = new IntersectionObserver(
      (entries, observer) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      },
      { threshold: 0.08, rootMargin: "0px 0px -24px 0px" }
    );
    document.querySelectorAll(".reveal").forEach((section) => sectionObserver.observe(section));
  }

  // A distinct, sequential two-line word reveal at the point the text is read.
  const tagline = document.querySelector(".tagline-copy");
  if (tagline) {
    const wordNodes = [];
    tagline.querySelectorAll("[data-word-line]").forEach((line) => {
      const words = line.textContent.trim().split(/\s+/);
      line.replaceChildren();
      words.forEach((word, index) => {
        const node = document.createElement("span");
        node.className = "word";
        node.textContent = word;
        line.appendChild(node);
        if (index < words.length - 1) line.appendChild(document.createTextNode(" "));
        wordNodes.push(node);
      });
    });

    if (reducedMotion.matches || !("IntersectionObserver" in window)) {
      wordNodes.forEach((word) => word.classList.add("is-lit"));
    } else {
      const waiting = new Set();
      let nextIndex = 0;
      let activeTimer = null;

      function illuminateInOrder() {
        if (activeTimer !== null || nextIndex >= wordNodes.length || !waiting.has(nextIndex)) return;
        const run = () => {
          if (!waiting.has(nextIndex)) {
            activeTimer = null;
            return;
          }
          wordNodes[nextIndex].classList.add("is-lit");
          waiting.delete(nextIndex);
          nextIndex += 1;
          activeTimer = nextIndex < wordNodes.length ? window.setTimeout(run, 85) : null;
        };
        run();
      }

      const wordObserver = new IntersectionObserver(
        (entries, observer) => {
          entries
            .filter((entry) => entry.isIntersecting)
            .sort((a, b) => wordNodes.indexOf(a.target) - wordNodes.indexOf(b.target))
            .forEach((entry) => {
              waiting.add(wordNodes.indexOf(entry.target));
              observer.unobserve(entry.target);
            });
          illuminateInOrder();
        },
        { threshold: 0.15, rootMargin: "0px 0px -18% 0px" }
      );
      wordNodes.forEach((word) => wordObserver.observe(word));

      reducedMotion.addEventListener("change", (event) => {
        if (!event.matches) return;
        if (activeTimer !== null) window.clearTimeout(activeTimer);
        wordObserver.disconnect();
        body.classList.remove("js-motion");
        wordNodes.forEach((word) => word.classList.add("is-lit"));
      });
    }
  }
})();
