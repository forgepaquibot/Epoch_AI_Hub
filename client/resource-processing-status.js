/* ============================================================
   EPOCH — RESOURCE PROCESSING STATUS
   Polls resource jobs only for authenticated users on pages
   that display the global panel or processing history table.
   ============================================================ */

(() => {
  'use strict';

  const panel = document.getElementById(
    'global-resource-jobs-panel'
  );

  const list = document.getElementById(
    'global-resource-jobs-list'
  );

  const historyBody = document.getElementById(
    'resource-processing-history-body'
  );

  const historyEmpty = document.getElementById(
    'resource-processing-history-empty'
  );

  // Do nothing on pages that do not display job information.
  if ((!panel || !list) && !historyBody) {
    return;
  }

  // The shared layout displays this link only for logged-in users.
  // Do not make background requests from the public landing page.
  const logoutLink = document.querySelector(
    'a.nav-logout[href="/logout"]'
  );

  if (!logoutLink) {
    if (panel) {
      panel.hidden = true;
    }

    return;
  }

  const POLL_INTERVAL = 2000;

  let requestInProgress = false;
  let pollTimeoutId = null;
  let stopped = false;

  function addTextElement(parent, tag, className, text) {
    const element = document.createElement(tag);

    if (className) {
      element.className = className;
    }

    // Treat resource titles and errors as text, not HTML.
    element.textContent = text ?? '';

    parent.appendChild(element);
    return element;
  }

  function formatStatus(status) {
    const labels = {
      pending: 'Queued',
      running: 'Indexing',
      done: 'Completed',
      failed: 'Failed',
      cancelled: 'Cancelled'
    };

    return labels[status] || status || 'Unknown';
  }

  function stopPolling() {
    stopped = true;

    if (pollTimeoutId !== null) {
      window.clearTimeout(pollTimeoutId);
      pollTimeoutId = null;
    }

    if (panel) {
      panel.hidden = true;
    }
  }

  function scheduleNextRefresh() {
    if (stopped || pollTimeoutId !== null) {
      return;
    }

    pollTimeoutId = window.setTimeout(() => {
      pollTimeoutId = null;
      refreshJobs();
    }, POLL_INTERVAL);
  }

  function createJobItem(job) {
    const item = document.createElement('li');
    item.className = 'resource-job-item';

    const heading = document.createElement('div');
    heading.className = 'resource-job-heading';

    addTextElement(
      heading,
      'strong',
      'resource-job-title',
      job.resource_title || `Resource ${job.resource_id ?? ''}`
    );

    addTextElement(
      heading,
      'span',
      `resource-job-status status-${job.status}`,
      formatStatus(job.status)
    );

    item.appendChild(heading);

    if (job.status === 'pending' || job.status === 'running') {
      const progress = document.createElement('progress');

      const progressValue = Math.min(
        100,
        Math.max(0, Number(job.progress_percent) || 0)
      );

      progress.className = 'resource-job-progress-meter';
      progress.max = 100;
      progress.value = progressValue;

      progress.setAttribute(
        'aria-label',
        `Indexing progress for ${
          job.resource_title || 'resource'
        }`
      );

      item.appendChild(progress);

      addTextElement(
        item,
        'p',
        'resource-job-progress',
        `${progressValue}% complete`
      );
    } else if (job.status === 'failed' && job.error_message) {
      addTextElement(
        item,
        'p',
        'resource-job-error',
        job.error_message
      );
    }

    addTextElement(
      item,
      'p',
      'resource-job-meta',
      job.operation === 'index'
        ? 'Resource indexing'
        : job.operation || ''
    );

    return item;
  }

  function renderGlobalPanel(jobs) {
    if (!panel || !list) {
      return;
    }

    const activeJobs = jobs.filter(job =>
      ['pending', 'running'].includes(
        String(job.status || '').toLowerCase()
      )
    );

    list.replaceChildren();

    for (const job of activeJobs) {
      list.appendChild(createJobItem(job));
    }

    panel.hidden = activeJobs.length === 0;
  }

  function renderHistoryTable(jobs) {
    if (!historyBody) {
      return;
    }

    historyBody.replaceChildren();

    for (const job of jobs) {
      const row = document.createElement('tr');

      addTextElement(
        row,
        'td',
        '',
        job.resource_title || `Resource ${job.resource_id ?? ''}`
      );

      addTextElement(
        row,
        'td',
        '',
        job.operation || '—'
      );

      const statusCell = document.createElement('td');

      addTextElement(
        statusCell,
        'span',
        `status status-${job.status}`,
        formatStatus(job.status)
      );

      row.appendChild(statusCell);

      addTextElement(
        row,
        'td',
        '',
        `${Math.min(
          100,
          Math.max(0, Number(job.progress_percent) || 0)
        )}%`
      );

      addTextElement(
        row,
        'td',
        '',
        job.started_at || job.created_at || '—'
      );

      historyBody.appendChild(row);
    }

    if (historyEmpty) {
      historyEmpty.hidden = jobs.length > 0;
    }
  }

  async function refreshJobs() {
    if (stopped || requestInProgress) {
      return;
    }

    requestInProgress = true;

    try {
      const response = await fetch('/resource-processing/jobs', {
        method: 'GET',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json'
        },
        cache: 'no-store',
        redirect: 'follow'
      });

      // Stop if the session has expired or access is denied.
      if (response.status === 401 || response.status === 403) {
        stopPolling();
        return;
      }

      // Fetch follows redirects by default. A login redirect may
      // therefore produce a successful HTML response instead.
      if (response.redirected) {
        stopPolling();
        return;
      }

      if (!response.ok) {
        throw new Error(
          `Status request failed: ${response.status}`
        );
      }

      const contentType = response.headers.get('content-type') || '';

      // Avoid attempting to parse a login page or error page as JSON.
      if (!contentType.includes('application/json')) {
        stopPolling();
        return;
      }

      const data = await response.json();

      if (!data || !Array.isArray(data.jobs)) {
        throw new Error('Unexpected resource-status response format.');
      }

      renderGlobalPanel(data.jobs);
      renderHistoryTable(data.jobs);
    } catch (err) {
      if (!stopped) {
        console.error(
          'Could not refresh indexing status:',
          err
        );
      }
    } finally {
      requestInProgress = false;

      // Retry after a delay unless polling has been stopped.
      // Scheduling here avoids overlapping requests.
      scheduleNextRefresh();
    }
  }

  // Refresh immediately, then schedule subsequent requests.
  refreshJobs();

  // Stop future polling if the page is being unloaded.
  window.addEventListener(
    'pagehide',
    stopPolling,
    { once: true }
  );
})();