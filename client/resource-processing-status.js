(() => {
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

  // Continue if either the global panel or the history table exists.
  if ((!panel || !list) && !historyBody) return;

  let requestInProgress = false;

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

  function parseTimestamp(value) {
    if (!value) return NaN;

    // SQLite CURRENT_TIMESTAMP normally looks like:
    // 2026-10-25 14:30:00 (UTC)
    // Also support ISO timestamps that already include a timezone.
    const normalized = String(value).trim().replace(' ', 'T');

    const hasTimezone =
      /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized);

    return Date.parse(
      hasTimezone ? normalized : `${normalized}Z`
    );
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
      job.resource_title || `Resource ${job.resource_id}`
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
        : job.operation
    );

    return item;
  }

  function renderGlobalPanel(jobs) {
    // The history table can still update without the global panel.
    if (!panel || !list) return;

    // Show only jobs that are waiting or actively processing.
    const activeJobs = jobs.filter(job =>
      ['pending', 'running'].includes(
        String(job.status || '').toLowerCase()
      )
    );

    list.replaceChildren();

    for (const job of activeJobs) {
      list.appendChild(createJobItem(job));
    }

    // Hide the entire panel when no active jobs remain.
    panel.hidden = activeJobs.length === 0;
  }

  function renderHistoryTable(jobs) {
    if (!historyBody) return;

    historyBody.replaceChildren();

    for (const job of jobs) {
      const row = document.createElement('tr');

      addTextElement(
        row,
        'td',
        '',
        job.resource_title || `Resource ${job.resource_id}`
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
    if (requestInProgress) return;

    requestInProgress = true;

    try {
      const response = await fetch('/resource-processing/jobs', {
        method: 'GET',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json'
        },
        cache: 'no-store'
      });

      if (response.status === 401) {
        if (panel) {
          panel.hidden = true;
        }

        return;
      }

      if (!response.ok) {
        throw new Error(
          `Status request failed: ${response.status}`
        );
      }

      const data = await response.json();
      const jobs = Array.isArray(data.jobs)
        ? data.jobs
        : [];

      renderGlobalPanel(jobs);
      renderHistoryTable(jobs);
    } catch (err) {
      console.error(
        'Could not refresh indexing status:',
        err
      );
    } finally {
      requestInProgress = false;
    }
  }

  // Refresh immediately, then poll while this page is open.
  refreshJobs();

  window.setInterval(refreshJobs, 2000);
})();