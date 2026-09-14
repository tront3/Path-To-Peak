// ---------- Storage ----------
const STORAGE_KEYS = { metrics: 'ptp_metrics_v2', entries: 'ptp_entries_v2' };
const MONO_FONT = "ui-monospace, 'Roboto Mono', 'SF Mono', Consolas, monospace";
const DAY_MS = 86400000;

function loadMetrics() { try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.metrics)) || []; } catch (e) { return []; } }
function loadEntries() { try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.entries)) || []; } catch (e) { return []; } }
function saveMetrics(m) { localStorage.setItem(STORAGE_KEYS.metrics, JSON.stringify(m)); }
function saveEntries(e) { localStorage.setItem(STORAGE_KEYS.entries, JSON.stringify(e)); }

let metrics = loadMetrics();
let entries = loadEntries();
let currentMetricId = null;
let currentRange = 'all';
let editingMetricId = null;
let metricUnitType = 'custom';
let metricDirection = 'higher';
let goalEnabled = false;
let editingEntryId = null;
let chartInstance = null;

// ---------- Small helpers ----------
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function round(n) { return Math.round(n * 100) / 100; }
function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; }
function todayIso() { return new Date().toISOString().slice(0, 10); }
function toDayMs(iso) { return Date.parse(iso + 'T00:00:00'); }
function addDaysIso(baseIso, days) { const d = new Date(baseIso + 'T00:00:00'); d.setDate(d.getDate() + Math.round(days)); return d.toISOString().slice(0, 10); }
function formatDate(iso) { const d = new Date(iso + 'T00:00:00'); return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
function metricEntries(id) { return entries.filter(e => e.metricId === id).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)); }

// dir: 'higher' or 'lower'. Returns 'up' (improvement), 'down' (decline), or 'flat'.
function improvementDirection(dir, curr, prev) {
  if (prev == null || curr === prev) return 'flat';
  if (dir === 'higher') return curr > prev ? 'up' : 'down';
  return curr < prev ? 'up' : 'down';
}

// ---------- Unit handling (custom text unit, or feet & inches) ----------
function ftInToInches(feet, inches) { return (parseFloat(feet) || 0) * 12 + (parseFloat(inches) || 0); }
function inchesToFtInParts(totalInches) {
  const t = Math.round(totalInches * 10) / 10;
  let feet = Math.floor(t / 12);
  let inches = Math.round((t - feet * 12) * 10) / 10;
  if (inches >= 12) { feet += 1; inches -= 12; }
  return { feet, inches };
}
function unitSuffix(m) { return m.unitType === 'ft_in' ? 'in' : (m.unit || ''); }
function formatValue(m, value) {
  if (value == null || isNaN(value)) return '—';
  if (m.unitType === 'ft_in') {
    const { feet, inches } = inchesToFtInParts(value);
    const inchesStr = Number.isInteger(inches) ? inches : inches.toFixed(1);
    return `${feet}' ${inchesStr}"`;
  }
  return `${round(value)}${m.unit ? ' ' + m.unit : ''}`;
}
function formatDeltaText(m, diff) {
  const sign = diff > 0 ? '+' : '';
  if (m.unitType === 'ft_in') return `${sign}${round(diff)} in`;
  return `${sign}${round(diff)}${m.unit ? ' ' + m.unit : ''}`;
}

// ---------- Stats ----------
function linearRegression(points) {
  const n = points.length;
  const sumX = points.reduce((s, p) => s + p.x, 0);
  const sumY = points.reduce((s, p) => s + p.y, 0);
  const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
  const sumXX = points.reduce((s, p) => s + p.x * p.x, 0);
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return { slope: 0, intercept: sumY / n };
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

function computeStats(m, filtered) {
  if (filtered.length === 0) return null;
  const values = filtered.map(e => e.value);
  const average = values.reduce((a, b) => a + b, 0) / values.length;
  const best = m.direction === 'higher' ? Math.max(...values) : Math.min(...values);
  const worst = m.direction === 'higher' ? Math.min(...values) : Math.max(...values);

  let rate = null;
  if (filtered.length >= 2) {
    const base = toDayMs(filtered[0].date);
    const points = filtered.map(e => ({ x: (toDayMs(e.date) - base) / DAY_MS, y: e.value }));
    const { slope } = linearRegression(points);
    const slopePerMonth = slope * 30.4368;
    const adjusted = m.direction === 'higher' ? slopePerMonth : -slopePerMonth;
    const firstVal = filtered[0].value;
    const percent = firstVal !== 0 ? (adjusted / Math.abs(firstVal)) * 100 : null;
    rate = { adjusted, percent };
  }

  let consistency = null;
  if (filtered.length >= 3) {
    const gaps = [];
    for (let i = 1; i < filtered.length; i++) gaps.push((toDayMs(filtered[i].date) - toDayMs(filtered[i - 1].date)) / DAY_MS);
    const meanGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const variance = gaps.reduce((s, g) => s + Math.pow(g - meanGap, 2), 0) / gaps.length;
    const stdDev = Math.sqrt(variance);
    const cv = meanGap > 0 ? stdDev / meanGap : 0;
    consistency = Math.round(100 * (1 - Math.min(1, cv)));
  }

  return { average, best, worst, rate, consistency };
}

// ---------- Goal math ----------
function computeGoalInfo(m, all, filteredForRate) {
  if (!m.goal || all.length === 0) return null;
  const baseline = all[0];
  const current = all[all.length - 1];
  const goalValue = m.goal.value;
  const span = goalValue - baseline.value;

  const reached = m.direction === 'higher' ? current.value >= goalValue : current.value <= goalValue;
  let fraction = span !== 0 ? (current.value - baseline.value) / span : 1;
  if (reached) fraction = Math.max(fraction, 1);
  fraction = Math.max(0, fraction);

  const remaining = m.direction === 'higher' ? (goalValue - current.value) : (current.value - goalValue);

  let status = null, projectedDate = null;
  const hasDate = !!m.goal.date;

  if (hasDate) {
    const baseDate = toDayMs(baseline.date);
    const goalDate = toDayMs(m.goal.date);
    const today = toDayMs(todayIso());
    const totalDays = (goalDate - baseDate) / DAY_MS;

    if (totalDays > 0) {
      const elapsedDays = (today - baseDate) / DAY_MS;
      const paceFraction = Math.max(0, Math.min(1.5, elapsedDays / totalDays));
      const paceExpectedToday = baseline.value + paceFraction * span;
      const diffFromPace = m.direction === 'higher' ? (current.value - paceExpectedToday) : (paceExpectedToday - current.value);
      const tolerance = Math.abs(span) * 0.05 || 0.0001;
      if (reached) status = 'reached';
      else if (diffFromPace > tolerance) status = 'ahead';
      else if (diffFromPace < -tolerance) status = 'behind';
      else status = 'on_track';
    }

    if (!reached) {
      const trendSource = filteredForRate.length >= 2 ? filteredForRate : all;
      if (trendSource.length >= 2) {
        const base = toDayMs(trendSource[0].date);
        const points = trendSource.map(e => ({ x: (toDayMs(e.date) - base) / DAY_MS, y: e.value }));
        const { slope, intercept } = linearRegression(points);
        const movingTowardGoal = m.direction === 'higher' ? slope > 0.0001 : slope < -0.0001;
        if (movingTowardGoal) {
          const xAtGoal = (goalValue - intercept) / slope;
          const projMs = base + xAtGoal * DAY_MS;
          projectedDate = projMs <= today ? 'soon' : new Date(projMs).toISOString().slice(0, 10);
        }
      }
    }
  }

  return { baseline, current, goalValue, fraction, remaining, reached, status, projectedDate, hasDate };
}

const STATUS_LABEL = { ahead: 'Ahead of pace', on_track: 'On track', behind: 'Behind pace', reached: 'Goal reached' };
const STATUS_CLASS = { ahead: 'positive', on_track: 'neutral-goal', behind: 'negative', reached: 'positive' };

// ---------- View switching ----------
function showView(view) {
  document.getElementById('view-home').classList.toggle('hidden', view !== 'home');
  document.getElementById('view-detail').classList.toggle('hidden', view !== 'detail');
  document.getElementById('btn-back').classList.toggle('hidden', view !== 'detail');
  document.getElementById('btn-menu').classList.toggle('hidden', view !== 'home');
  document.getElementById('btn-edit-metric').classList.toggle('hidden', view !== 'detail');
  const m = view === 'detail' ? metrics.find(x => x.id === currentMetricId) : null;
  document.getElementById('topbar-title').textContent = m ? m.name : 'Path to Peak';
}

// ---------- Home ----------
function renderHome() {
  const list = document.getElementById('metrics-list');
  const empty = document.getElementById('empty-state');
  list.innerHTML = '';
  if (metrics.length === 0) { empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');

  [...metrics].sort((a, b) => a.name.localeCompare(b.name)).forEach(m => {
    const es = metricEntries(m.id);
    const last = es[es.length - 1];
    const prev = es[es.length - 2];

    let deltaHtml = '<span class="delta-badge neutral">No data yet</span>';
    if (last && prev) {
      const dir = improvementDirection(m.direction, last.value, prev.value);
      const cls = dir === 'up' ? 'positive' : dir === 'down' ? 'negative' : 'neutral';
      deltaHtml = `<span class="delta-badge ${cls}">${formatDeltaText(m, last.value - prev.value)}</span>`;
    } else if (last) {
      deltaHtml = '<span class="delta-badge neutral">First entry</span>';
    }

    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'metric-card';
    card.innerHTML = `
      <span class="metric-card-accent"></span>
      <span class="metric-card-main">
        <span class="metric-card-name">${escapeHtml(m.name)}</span>
        <span class="metric-card-value">${last ? formatValue(m, last.value) : '—'}</span>
      </span>
      ${deltaHtml}
    `;
    card.addEventListener('click', () => openDetail(m.id));
    list.appendChild(card);
  });
}

// ---------- Detail ----------
function openDetail(id) {
  currentMetricId = id;
  currentRange = 'all';
  document.querySelectorAll('#range-tabs button').forEach(b => b.classList.toggle('active', b.dataset.range === 'all'));
  showView('detail');
  renderDetail();
}

function rangeStartDate(range) {
  if (range === 'all') return null;
  const d = new Date();
  if (range === '1m') d.setMonth(d.getMonth() - 1);
  if (range === '3m') d.setMonth(d.getMonth() - 3);
  if (range === '6m') d.setMonth(d.getMonth() - 6);
  if (range === '1y') d.setFullYear(d.getFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

function renderDetail() {
  const m = metrics.find(x => x.id === currentMetricId);
  if (!m) { showView('home'); renderHome(); return; }

  const all = metricEntries(m.id);
  const start = rangeStartDate(currentRange);
  const filtered = start ? all.filter(e => e.date >= start) : all;

  const last = all[all.length - 1];
  const prev = all[all.length - 2];
  document.getElementById('detail-value').textContent = last ? formatValue(m, last.value) : '—';

  const deltaEl = document.getElementById('detail-delta');
  if (last && prev) {
    const dir = improvementDirection(m.direction, last.value, prev.value);
    deltaEl.textContent = `${formatDeltaText(m, last.value - prev.value)} vs last entry`;
    deltaEl.className = 'delta ' + (dir === 'up' ? 'positive' : dir === 'down' ? 'negative' : 'neutral');
  } else if (last) {
    deltaEl.textContent = 'First entry logged';
    deltaEl.className = 'delta neutral';
  } else {
    deltaEl.textContent = 'No entries yet';
    deltaEl.className = 'delta neutral';
  }

  renderGoalCard(m, computeGoalInfo(m, all, filtered));
  renderChart(m, filtered, all);
  renderStats(m, computeStats(m, filtered));
  renderHistory(m, filtered, all);
}

function renderGoalCard(m, info) {
  const wrap = document.getElementById('goal-card');
  if (!m.goal || !info) { wrap.classList.add('hidden'); wrap.innerHTML = ''; return; }
  wrap.classList.remove('hidden');

  const pct = Math.round(Math.min(1, info.fraction) * 100);
  const targetLine = info.hasDate
    ? `Target ${formatValue(m, info.goalValue)} by ${formatDate(m.goal.date)}`
    : `Target ${formatValue(m, info.goalValue)}`;

  let remainingLine;
  if (info.reached) {
    const over = Math.abs(info.remaining);
    remainingLine = over > 0.01 ? `Goal reached — ${round(over)}${unitSuffix(m) ? ' ' + unitSuffix(m) : ''} past target` : 'Goal reached';
  } else {
    remainingLine = `${formatValue(m, Math.abs(info.remaining))} to go`;
  }

  let statusHtml = '';
  if (info.hasDate && info.status) statusHtml = `<span class="status-chip ${STATUS_CLASS[info.status]}">${STATUS_LABEL[info.status]}</span>`;

  let projectedHtml = '';
  if (info.hasDate && !info.reached) {
    if (info.projectedDate === 'soon') projectedHtml = `<div class="goal-projected">Projected: any day now at this rate</div>`;
    else if (info.projectedDate) projectedHtml = `<div class="goal-projected">Projected: ${formatDate(info.projectedDate)}</div>`;
    else projectedHtml = `<div class="goal-projected muted">Not on pace to reach this at the current rate</div>`;
  }

  wrap.innerHTML = `
    <div class="goal-card-header">
      <span class="goal-target">${escapeHtml(targetLine)}</span>
      ${statusHtml}
    </div>
    <div class="goal-progress-track"><div class="goal-progress-fill" style="width:${pct}%"></div></div>
    <div class="goal-remaining">${remainingLine}</div>
    ${projectedHtml}
  `;
}

function renderStats(m, stats) {
  const grid = document.getElementById('stats-grid');
  if (!stats) { grid.innerHTML = '<p class="muted" style="padding:8px 0;">No entries in this range yet.</p>'; return; }

  const rateHtml = stats.rate
    ? `<span class="${stats.rate.adjusted > 0 ? 'positive' : stats.rate.adjusted < 0 ? 'negative' : ''}">${stats.rate.adjusted > 0 ? '+' : ''}${round(stats.rate.adjusted)}${unitSuffix(m) ? ' ' + unitSuffix(m) : ''}/mo${stats.rate.percent != null ? ` (${stats.rate.percent > 0 ? '+' : ''}${round(stats.rate.percent)}%/mo)` : ''}</span>`
    : '—';
  const consistencyHtml = stats.consistency != null ? `${stats.consistency}%` : '—';

  grid.innerHTML = `
    <div class="stat-tile"><span class="stat-label">Average</span><span class="stat-value">${formatValue(m, stats.average)}</span></div>
    <div class="stat-tile"><span class="stat-label">Best</span><span class="stat-value">${formatValue(m, stats.best)}</span></div>
    <div class="stat-tile"><span class="stat-label">Worst</span><span class="stat-value">${formatValue(m, stats.worst)}</span></div>
    <div class="stat-tile"><span class="stat-label">Improvement</span><span class="stat-value stat-value-small">${rateHtml}</span></div>
    <div class="stat-tile"><span class="stat-label">Consistency</span><span class="stat-value">${consistencyHtml}</span></div>
  `;
}

function renderChart(m, filtered, all) {
  const canvas = document.getElementById('chart-canvas');
  const emptyMsg = document.getElementById('chart-empty');
  if (chartInstance) { chartInstance.destroy(); chartInstance = null; }

  if (filtered.length === 0) {
    canvas.classList.add('hidden');
    emptyMsg.classList.remove('hidden');
    emptyMsg.textContent = all.length === 0 ? 'No entries yet — add one to see your trend.' : 'No entries in this range — try a wider range.';
    return;
  }
  canvas.classList.remove('hidden');
  emptyMsg.classList.add('hidden');

  const styles = getComputedStyle(document.documentElement);
  const accent = styles.getPropertyValue('--accent').trim();
  const goalColor = styles.getPropertyValue('--goal').trim();
  const positive = styles.getPropertyValue('--positive').trim();
  const negative = styles.getPropertyValue('--negative').trim();
  const gridColor = styles.getPropertyValue('--border').trim();
  const textMuted = styles.getPropertyValue('--text-muted').trim();

  const baseline = all[0];
  const toOffset = (iso) => (toDayMs(iso) - toDayMs(baseline.date)) / DAY_MS;

  const dataPoints = filtered.map(e => ({ x: toOffset(e.date), y: e.value }));
  const pointColors = filtered.map((e, i) => {
    if (i === 0) return accent;
    const dir = improvementDirection(m.direction, e.value, filtered[i - 1].value);
    return dir === 'up' ? positive : dir === 'down' ? negative : accent;
  });

  const datasets = [{
    label: 'Actual',
    data: dataPoints,
    borderColor: accent,
    backgroundColor: accent,
    pointBackgroundColor: pointColors,
    pointBorderColor: pointColors,
    pointRadius: 4,
    pointHoverRadius: 6,
    tension: 0.25,
    borderWidth: 2,
  }];

  let allXs = dataPoints.map(p => p.x);
  let allYs = dataPoints.map(p => p.y);

  if (m.goal && m.goal.date) {
    const goalOffset = toOffset(m.goal.date);
    const paceData = [{ x: 0, y: baseline.value }, { x: goalOffset, y: m.goal.value }];
    datasets.push({
      label: 'Goal pace',
      data: paceData,
      borderColor: goalColor,
      backgroundColor: goalColor,
      borderDash: [6, 4],
      pointRadius: 0,
      borderWidth: 2,
      tension: 0,
      fill: false,
    });
    allXs = allXs.concat(paceData.map(p => p.x));
    allYs = allYs.concat(paceData.map(p => p.y));
  }

  const minXraw = Math.min(0, ...allXs), maxXraw = Math.max(1, ...allXs);
  const padX = Math.max(1, (maxXraw - minXraw) * 0.08);
  const minYraw = Math.min(...allYs), maxYraw = Math.max(...allYs);
  const padY = (maxYraw - minYraw) * 0.15 || Math.abs(maxYraw) * 0.1 || 1;

  chartInstance = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 400 },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => formatDate(addDaysIso(baseline.date, items[0].parsed.x)),
            label: (ctx) => ctx.dataset.label === 'Goal pace' ? `Pace: ${formatValue(m, ctx.parsed.y)}` : formatValue(m, ctx.parsed.y),
          }
        }
      },
      scales: {
        x: {
          type: 'linear',
          min: minXraw - padX,
          max: maxXraw + padX,
          ticks: {
            color: textMuted, maxRotation: 0, maxTicksLimit: 5, font: { family: MONO_FONT, size: 10 },
            callback: (val) => formatDate(addDaysIso(baseline.date, val)).replace(/, \d{4}$/, ''),
          },
          grid: { color: gridColor },
        },
        y: {
          min: minYraw - padY,
          max: maxYraw + padY,
          ticks: { color: textMuted, font: { family: MONO_FONT, size: 10 } },
          grid: { color: gridColor },
        }
      }
    }
  });
}

function renderHistory(m, filtered, all) {
  const list = document.getElementById('history-list');
  list.innerHTML = '';
  if (filtered.length === 0) {
    list.innerHTML = '<p class="muted" style="padding:16px 0;">No entries in this range yet.</p>';
    return;
  }

  let runningBest = null;
  const prSet = new Set();
  all.forEach(e => {
    if (runningBest === null) { runningBest = e.value; prSet.add(e.id); }
    else {
      const better = m.direction === 'higher' ? e.value > runningBest : e.value < runningBest;
      if (better) { runningBest = e.value; prSet.add(e.id); }
    }
  });

  [...filtered].reverse().forEach(e => {
    const chronoIndex = all.findIndex(x => x.id === e.id);
    const prevEntry = chronoIndex > 0 ? all[chronoIndex - 1] : null;

    let deltaHtml = '<span class="delta-badge neutral">First</span>';
    if (prevEntry) {
      const dir = improvementDirection(m.direction, e.value, prevEntry.value);
      const cls = dir === 'up' ? 'positive' : dir === 'down' ? 'negative' : 'neutral';
      deltaHtml = `<span class="delta-badge ${cls}">${formatDeltaText(m, e.value - prevEntry.value)}</span>`;
    }

    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'history-row';
    row.innerHTML = `
      <span class="history-date">${formatDate(e.date)}</span>
      <span class="history-value">${formatValue(m, e.value)}${prSet.has(e.id) ? ' <span class="pr-star" title="Personal record">★</span>' : ''}</span>
      ${deltaHtml}
      ${e.note ? `<span class="history-note">${escapeHtml(e.note)}</span>` : ''}
    `;
    row.addEventListener('click', () => openEntryModal(m.id, e.id));
    list.appendChild(row);
  });
}

// ---------- Modal open/close ----------
function showModal(modal) { modal.classList.remove('hidden'); requestAnimationFrame(() => modal.classList.add('open')); }
function closeModal(modal) { modal.classList.remove('open'); setTimeout(() => modal.classList.add('hidden'), 200); }

let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.classList.add('hidden'), 200);
  }, 1600);
}

document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) closeModal(overlay); });
});

// ---------- Metric modal ----------
function updateUnitTypeUI() {
  document.querySelectorAll('#metric-unittype button').forEach(b => b.classList.toggle('active', b.dataset.unittype === metricUnitType));
  document.getElementById('metric-unit-wrap').classList.toggle('hidden', metricUnitType === 'ft_in');
  document.getElementById('goal-value-ftin').classList.toggle('hidden', metricUnitType !== 'ft_in');
  document.getElementById('goal-value').classList.toggle('hidden', metricUnitType === 'ft_in');
}
function updateDirectionButtons() {
  document.querySelectorAll('#metric-direction button').forEach(b => b.classList.toggle('active', b.dataset.dir === metricDirection));
}
function updateGoalUI() {
  document.getElementById('goal-fields').classList.toggle('hidden', !goalEnabled);
  document.getElementById('goal-toggle').textContent = goalEnabled ? '− Remove goal fields' : '+ Add a goal';
}

function openMetricModal(id) {
  editingMetricId = id;
  const nameInput = document.getElementById('metric-name');
  const unitInput = document.getElementById('metric-unit');
  const deleteBtn = document.getElementById('metric-delete');
  const goalValueInput = document.getElementById('goal-value');
  const goalFeetInput = document.getElementById('goal-value-feet');
  const goalInchesInput = document.getElementById('goal-value-inches');
  const goalDateInput = document.getElementById('goal-date');
  const goalRemoveBtn = document.getElementById('goal-remove');

  if (id) {
    const m = metrics.find(x => x.id === id);
    document.getElementById('metric-modal-title').textContent = 'Edit metric';
    nameInput.value = m.name;
    unitInput.value = m.unit || '';
    metricUnitType = m.unitType || 'custom';
    metricDirection = m.direction;
    deleteBtn.classList.remove('hidden');

    if (m.goal) {
      goalEnabled = true;
      goalDateInput.value = m.goal.date || '';
      if (metricUnitType === 'ft_in') {
        const parts = inchesToFtInParts(m.goal.value);
        goalFeetInput.value = parts.feet;
        goalInchesInput.value = parts.inches;
        goalValueInput.value = '';
      } else {
        goalValueInput.value = m.goal.value;
        goalFeetInput.value = ''; goalInchesInput.value = '';
      }
      goalRemoveBtn.classList.remove('hidden');
    } else {
      goalEnabled = false;
      goalValueInput.value = ''; goalFeetInput.value = ''; goalInchesInput.value = ''; goalDateInput.value = '';
      goalRemoveBtn.classList.add('hidden');
    }
  } else {
    document.getElementById('metric-modal-title').textContent = 'New metric';
    nameInput.value = '';
    unitInput.value = '';
    metricUnitType = 'custom';
    metricDirection = 'higher';
    deleteBtn.classList.add('hidden');
    goalEnabled = false;
    goalValueInput.value = ''; goalFeetInput.value = ''; goalInchesInput.value = ''; goalDateInput.value = '';
    goalRemoveBtn.classList.add('hidden');
  }

  updateUnitTypeUI();
  updateDirectionButtons();
  updateGoalUI();
  showModal(document.getElementById('modal-metric'));
  setTimeout(() => nameInput.focus(), 50);
}

document.getElementById('metric-unittype').addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-unittype]');
  if (!btn) return;
  metricUnitType = btn.dataset.unittype;
  updateUnitTypeUI();
});

document.getElementById('metric-direction').addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-dir]');
  if (!btn) return;
  metricDirection = btn.dataset.dir;
  updateDirectionButtons();
});

document.getElementById('goal-toggle').addEventListener('click', () => {
  goalEnabled = !goalEnabled;
  updateGoalUI();
});

document.getElementById('goal-remove').addEventListener('click', () => {
  goalEnabled = false;
  document.getElementById('goal-value').value = '';
  document.getElementById('goal-value-feet').value = '';
  document.getElementById('goal-value-inches').value = '';
  document.getElementById('goal-date').value = '';
  updateGoalUI();
});

document.getElementById('metric-save').addEventListener('click', () => {
  const name = document.getElementById('metric-name').value.trim();
  const unit = document.getElementById('metric-unit').value.trim();
  if (!name) { toast('Give it a name first'); return; }

  let goal = null;
  if (goalEnabled) {
    let goalValue;
    if (metricUnitType === 'ft_in') {
      const feet = document.getElementById('goal-value-feet').value;
      const inches = document.getElementById('goal-value-inches').value;
      if (feet !== '' || inches !== '') goalValue = ftInToInches(feet, inches);
    } else {
      const v = parseFloat(document.getElementById('goal-value').value);
      if (!isNaN(v)) goalValue = v;
    }
    if (goalValue != null) {
      const date = document.getElementById('goal-date').value;
      goal = { value: goalValue, date: date || null };
    }
  }

  if (editingMetricId) {
    const m = metrics.find(x => x.id === editingMetricId);
    m.name = name; m.unitType = metricUnitType; m.unit = metricUnitType === 'ft_in' ? 'ft/in' : (unit || '—'); m.direction = metricDirection; m.goal = goal;
  } else {
    metrics.push({ id: uid(), name, unitType: metricUnitType, unit: metricUnitType === 'ft_in' ? 'ft/in' : (unit || '—'), direction: metricDirection, goal, createdAt: new Date().toISOString() });
  }
  saveMetrics(metrics);
  closeModal(document.getElementById('modal-metric'));
  renderHome();
  toast('Saved');
});

document.getElementById('metric-cancel').addEventListener('click', () => closeModal(document.getElementById('modal-metric')));

document.getElementById('metric-delete').addEventListener('click', () => {
  if (!editingMetricId) return;
  if (!confirm("Delete this metric and all its history? This can't be undone.")) return;
  const id = editingMetricId;
  metrics = metrics.filter(m => m.id !== id);
  entries = entries.filter(e => e.metricId !== id);
  saveMetrics(metrics); saveEntries(entries);
  closeModal(document.getElementById('modal-metric'));
  showView('home');
  renderHome();
  toast('Metric deleted');
});

// ---------- Entry modal ----------
function openEntryModal(metricId, entryId) {
  editingEntryId = entryId;
  currentMetricId = metricId;
  const m = metrics.find(x => x.id === metricId);
  const isFtIn = m.unitType === 'ft_in';

  document.getElementById('entry-value-standard-wrap').classList.toggle('hidden', isFtIn);
  document.getElementById('entry-value-ftin-wrap').classList.toggle('hidden', !isFtIn);
  document.getElementById('entry-unit-label').textContent = m.unit;

  const dateInput = document.getElementById('entry-date');
  const valueInput = document.getElementById('entry-value');
  const feetInput = document.getElementById('entry-value-feet');
  const inchesInput = document.getElementById('entry-value-inches');
  const noteInput = document.getElementById('entry-note');
  const deleteBtn = document.getElementById('entry-delete');

  if (entryId) {
    const e = entries.find(x => x.id === entryId);
    document.getElementById('entry-modal-title').textContent = 'Edit entry';
    dateInput.value = e.date;
    if (isFtIn) { const parts = inchesToFtInParts(e.value); feetInput.value = parts.feet; inchesInput.value = parts.inches; }
    else valueInput.value = e.value;
    noteInput.value = e.note || '';
    deleteBtn.classList.remove('hidden');
  } else {
    document.getElementById('entry-modal-title').textContent = 'Add entry';
    dateInput.value = todayIso();
    valueInput.value = ''; feetInput.value = ''; inchesInput.value = '';
    noteInput.value = '';
    deleteBtn.classList.add('hidden');
  }
  showModal(document.getElementById('modal-entry'));
  setTimeout(() => (isFtIn ? feetInput : valueInput).focus(), 50);
}

document.getElementById('entry-save').addEventListener('click', () => {
  const m = metrics.find(x => x.id === currentMetricId);
  const date = document.getElementById('entry-date').value;
  const note = document.getElementById('entry-note').value.trim();
  if (!date) { toast('Pick a date'); return; }

  let value;
  if (m.unitType === 'ft_in') {
    const feet = document.getElementById('entry-value-feet').value;
    const inches = document.getElementById('entry-value-inches').value;
    if (feet === '' && inches === '') { toast('Enter feet and/or inches'); return; }
    value = ftInToInches(feet, inches);
  } else {
    value = parseFloat(document.getElementById('entry-value').value);
    if (isNaN(value)) { toast('Enter a number'); return; }
  }

  if (editingEntryId) {
    const e = entries.find(x => x.id === editingEntryId);
    e.date = date; e.value = value; e.note = note;
  } else {
    entries.push({ id: uid(), metricId: currentMetricId, date, value, note });
  }
  saveEntries(entries);
  closeModal(document.getElementById('modal-entry'));
  renderDetail();
  toast('Saved');
});

document.getElementById('entry-cancel').addEventListener('click', () => closeModal(document.getElementById('modal-entry')));

document.getElementById('entry-delete').addEventListener('click', () => {
  if (!editingEntryId) return;
  if (!confirm('Delete this entry?')) return;
  entries = entries.filter(e => e.id !== editingEntryId);
  saveEntries(entries);
  closeModal(document.getElementById('modal-entry'));
  renderDetail();
  toast('Entry deleted');
});

// ---------- Range tabs ----------
document.getElementById('range-tabs').addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-range]');
  if (!btn) return;
  currentRange = btn.dataset.range;
  document.querySelectorAll('#range-tabs button').forEach(b => b.classList.toggle('active', b === btn));
  renderDetail();
});

// ---------- Nav / FAB ----------
document.getElementById('btn-back').addEventListener('click', () => { showView('home'); renderHome(); });

document.getElementById('btn-edit-metric').addEventListener('click', () => openMetricModal(currentMetricId));

document.getElementById('fab').addEventListener('click', () => {
  const onDetail = !document.getElementById('view-detail').classList.contains('hidden');
  if (onDetail) openEntryModal(currentMetricId, null);
  else openMetricModal(null);
});

// ---------- Backup / restore ----------
document.getElementById('btn-menu').addEventListener('click', () => {
  document.getElementById('data-textarea').value = '';
  showModal(document.getElementById('modal-data'));
});

document.getElementById('data-export').addEventListener('click', async () => {
  const payload = JSON.stringify({ metrics, entries }, null, 2);
  const ta = document.getElementById('data-textarea');
  ta.value = payload;
  try {
    await navigator.clipboard.writeText(payload);
    toast('Copied to clipboard');
  } catch (e) {
    ta.focus();
    ta.select();
    toast('Select the text above and copy it');
  }
});

document.getElementById('data-import').addEventListener('click', () => {
  const raw = document.getElementById('data-textarea').value.trim();
  if (!raw) { toast('Paste your backup text first'); return; }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.metrics) || !Array.isArray(parsed.entries)) throw new Error('bad shape');
    if (!confirm('This replaces all current data with the pasted backup. Continue?')) return;
    metrics = parsed.metrics; entries = parsed.entries;
    saveMetrics(metrics); saveEntries(entries);
    closeModal(document.getElementById('modal-data'));
    renderHome();
    toast('Data restored');
  } catch (e) {
    toast("That doesn't look like valid backup text");
  }
});

document.getElementById('data-close').addEventListener('click', () => closeModal(document.getElementById('modal-data')));

// ---------- Splash ----------
function initSplash() {
  const splash = document.getElementById('splash');
  const reduce = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : false;
  if (reduce) { splash.remove(); return; }
  setTimeout(() => {
    splash.classList.add('fade-out');
    setTimeout(() => splash.remove(), 450);
  }, 1750);
}

// ---------- Init ----------
showView('home');
renderHome();
initSplash();
