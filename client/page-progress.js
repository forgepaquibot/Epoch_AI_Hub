/* ============================================================
   EPOCH — MINIMAL TIMELINE PROGRESS RAIL
   Clickable nodes, connecting lines, visible section labels,
   and active-section tracking.
   Styling is maintained separately in page-progress_style.css.
   ============================================================ */

(() => {
  'use strict';

  function initializePageProgressRail() {
    const sections = Array.from(
      document.querySelectorAll('[data-progress-section][id]')
    );

    if (!sections.length) {
      return;
    }

    // Prevent duplicate initialization.
    if (document.getElementById('epoch-page-progress-rail')) {
      return;
    }

    const reducedMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)'
    ).matches;

    // Build the timeline navigation.
    const rail = document.createElement('nav');
    rail.id = 'epoch-page-progress-rail';
    rail.setAttribute('aria-label', 'Page section navigation');

    const list = document.createElement('ol');
    list.className = 'epoch-progress-list';

    const items = [];

    sections.forEach((section, index) => {
      const heading = section.querySelector('h1, h2, h3');

      const label =
        section.dataset.progressLabel ||
        heading?.textContent.trim() ||
        `Section ${index + 1}`;

      const item = document.createElement('li');
      item.className = 'epoch-progress-item';

      const link = document.createElement('a');
      link.className = 'epoch-progress-link';
      link.href = `#${section.id}`;
      link.title = label;
      link.setAttribute('aria-label', `Go to ${label}`);

      // Visible label positioned beside the timeline node.
      const visibleLabel = document.createElement('span');
      visibleLabel.className = 'epoch-progress-label';
      visibleLabel.textContent = label;

      link.appendChild(visibleLabel);

      link.addEventListener('click', (event) => {
        // Preserve standard browser behavior for modified clicks.
        if (
          event.button !== 0 ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }

        event.preventDefault();

        section.scrollIntoView({
          behavior: reducedMotion ? 'auto' : 'smooth',
          block: 'start'
        });

        const targetUrl =
          window.location.pathname +
          window.location.search +
          '#' +
          encodeURIComponent(section.id);

        window.history.replaceState(
          window.history.state,
          '',
          targetUrl
        );

        setActiveSection(index);
      });

      item.appendChild(link);
      list.appendChild(item);

      items.push({ section, item, link });
    });

    rail.appendChild(list);
    document.body.appendChild(rail);

    // Update node, connector, and label states.
    function setActiveSection(activeIndex) {
      items.forEach(({ item, link }, index) => {
        const isActive = index === activeIndex;
        const isComplete = index < activeIndex;

        item.classList.toggle('is-active', isActive);
        item.classList.toggle('is-complete', isComplete);

        link.classList.toggle('is-active', isActive);
        link.classList.toggle('is-complete', isComplete);

        if (isActive) {
          link.setAttribute('aria-current', 'location');
        } else {
          link.removeAttribute('aria-current');
        }
      });
    }

    let scheduledFrame = null;

    function updateActiveSection() {
      scheduledFrame = null;

      const scrollPosition =
        window.scrollY + window.innerHeight;

      const documentHeight =
        document.documentElement.scrollHeight;

      // Mark the final section active when the user reaches
      // the bottom of the page.
      if (scrollPosition >= documentHeight - 4) {
        setActiveSection(sections.length - 1);
        return;
      }

      const referenceLine = Math.min(
        window.innerHeight * 0.3,
        220
      );

      let activeIndex = 0;

      sections.forEach((section, index) => {
        if (
          section.getBoundingClientRect().top <= referenceLine
        ) {
          activeIndex = index;
        }
      });

      setActiveSection(activeIndex);
    }

    function scheduleUpdate() {
      if (scheduledFrame !== null) {
        return;
      }

      scheduledFrame = window.requestAnimationFrame(
        updateActiveSection
      );
    }

    window.addEventListener(
      'scroll',
      scheduleUpdate,
      { passive: true }
    );

    window.addEventListener(
      'resize',
      scheduleUpdate
    );

    // Respect an existing URL hash on page load.
    let initialIndex = 0;

    if (window.location.hash) {
      let targetId = '';

      try {
        targetId = decodeURIComponent(
          window.location.hash.slice(1)
        );
      } catch {
        targetId = window.location.hash.slice(1);
      }

      const hashIndex = sections.findIndex(
        section => section.id === targetId
      );

      if (hashIndex >= 0) {
        initialIndex = hashIndex;
      }
    }

    setActiveSection(initialIndex);
    scheduleUpdate();
  }

  if (document.readyState === 'loading') {
    document.addEventListener(
      'DOMContentLoaded',
      initializePageProgressRail,
      { once: true }
    );
  } else {
    initializePageProgressRail();
  }
})();