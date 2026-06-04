const $ = (sel) => document.querySelector(sel);

const ERROR_LABELS = {
  rate_limit: "限流 429",
  server_overload: "过载 503",
  timeout: "超时",
  auth_failed: "认证失败",
  network_error: "网络错误",
  model_unavailable: "模型不可用",
  context_too_long: "上下文过长",
  unknown: "未知",
};

let refreshTimer = null;

function formatMs(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 2500);
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function renderMetrics(overview) {
  const today = overview.today;
  const hour = overview.hour;
  const el = $("#metrics");
  if (!today) {
    el.innerHTML = '<p class="empty">暂无今日数据，等待 API 调用记录…</p>';
    return;
  }
  const rateClass = today.successRate >= 95 ? "ok" : "bad";
  el.innerHTML = `
    <div class="metric"><div class="label">今日调用</div><div class="value">${today.totalCalls}</div></div>
    <div class="metric"><div class="label">今日失败</div><div class="value bad">${today.failedCalls}</div></div>
    <div class="metric"><div class="label">今日成功率</div><div class="value ${rateClass}">${today.successRate}%</div></div>
    <div class="metric"><div class="label">本小时失败</div><div class="value">${hour?.failedCalls ?? 0}</div></div>
    <div class="metric"><div class="label">活跃重试</div><div class="value">${Object.keys(overview.activeRetries || {}).length}</div></div>
    <div class="metric"><div class="label">待恢复任务</div><div class="value">${overview.failedTasks ?? 0}</div></div>
  `;
}

function renderErrorChart(today) {
  const el = $("#errorChart");
  if (!today?.errorsByType) {
    el.innerHTML = '<p class="empty">无错误</p>';
    return;
  }
  const entries = Object.entries(today.errorsByType)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    el.innerHTML = '<p class="empty">今日无错误 ✅</p>';
    return;
  }
  const max = Math.max(...entries.map(([, n]) => n));
  el.innerHTML = entries
    .map(([type, count]) => {
      const pct = Math.round((count / max) * 100);
      return `
        <div class="bar-row">
          <span>${ERROR_LABELS[type] || type}</span>
          <div class="bar-track"><div class="bar-fill danger" style="width:${pct}%"></div></div>
          <span>${count}</span>
        </div>`;
    })
    .join("");
}

function renderActiveRetries(activeRetries) {
  const el = $("#activeRetries");
  const keys = Object.keys(activeRetries || {});
  if (keys.length === 0) {
    el.innerHTML = '<li class="empty">无进行中的重试</li>';
    return;
  }
  el.innerHTML = keys
    .map((k) => {
      const s = activeRetries[k];
      return `<li><strong>${k.slice(0, 24)}…</strong><br/>第 ${s.attempt} 次 · ${s.strategyName}<br/><small>${s.nextRetryAt}</small></li>`;
    })
    .join("");
}

function renderRecentErrors(errors) {
  const el = $("#recentErrors");
  if (!errors?.length) {
    el.innerHTML = '<li class="empty">无最近错误</li>';
    return;
  }
  el.innerHTML = errors
    .map((e) => {
      const t = new Date(e.timestamp).toLocaleTimeString();
      return `<li>[${t}] ${e.errorLabel || e.errorType}: ${(e.errorMessage || "").slice(0, 60)}</li>`;
    })
    .join("");
}

async function renderModels() {
  const { models } = await api("/api/models");
  const tbody = $("#modelTable tbody");
  const entries = Object.values(models || {});
  if (entries.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">暂无模型数据</td></tr>';
    return;
  }
  tbody.innerHTML = entries
    .sort((a, b) => b.failedCalls - a.failedCalls)
    .map(
      (m) => `
      <tr>
        <td>${m.model}</td>
        <td>${m.totalCalls}</td>
        <td>${m.failedCalls}</td>
        <td>${m.successRate}%</td>
        <td>${formatMs(m.avgDurationMs)}</td>
      </tr>`
    )
    .join("");
}

async function renderStrategies() {
  const { strategies, defaultStrategy } = await api("/api/strategies");
  const el = $("#strategies");
  if (!strategies?.length) {
    el.innerHTML = '<p class="empty">无策略配置</p>';
    return;
  }
  el.innerHTML = strategies
    .map((s) => {
      const isDef = s.name === defaultStrategy || s.isDefault;
      const intervals =
        s.type === "fixed"
          ? formatMs(s.intervals[0] || 0)
          : (s.intervals || []).map(formatMs).join(" → ");
      return `
        <article class="strategy ${isDef ? "default" : ""}" data-name="${s.name}">
          <h3>${s.name} ${isDef ? '<span class="badge">默认</span>' : ""}</h3>
          <dl>
            <div>类型: ${s.type} · 最多 ${s.maxRetries} 次</div>
            <div>间隔: ${intervals}</div>
            <div>触发: ${(s.retryOn || []).map((t) => ERROR_LABELS[t] || t).join(", ")}</div>
            <div>冷却: ${formatMs(s.cooldownMs)}</div>
          </dl>
          <div class="actions">
            <button type="button" class="btn" data-action="default">设为默认</button>
            <button type="button" class="btn ghost" data-action="bump-retries">+1 重试次数</button>
          </div>
        </article>`;
    })
    .join("");

  el.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const card = btn.closest(".strategy");
      const name = card.dataset.name;
      if (btn.dataset.action === "default") {
        await api("/api/strategies/default", {
          method: "POST",
          body: JSON.stringify({ name }),
        });
        toast(`已将「${name}」设为默认策略`);
      } else {
        const { strategies: list } = await api("/api/strategies");
        const s = list.find((x) => x.name === name);
        await api(`/api/strategies/${encodeURIComponent(name)}`, {
          method: "PUT",
          body: JSON.stringify({ maxRetries: (s?.maxRetries ?? 3) + 1 }),
        });
        toast(`已增加「${name}」最大重试次数`);
      }
      await renderStrategies();
    });
  });
}

async function refreshAll() {
  try {
    const overview = await api("/api/overview");
    renderMetrics(overview);
    renderErrorChart(overview.today);
    renderActiveRetries(overview.activeRetries);
    renderRecentErrors(overview.recentErrors);
    await renderModels();
    await renderStrategies();
    $("#lastSync").textContent = `更新于 ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    $("#lastSync").textContent = `连接失败: ${err.message}`;
    toast("无法连接 API，请确认 OpenClaw Gateway 已启动");
  }
}

function setupRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  const ms = Number($("#refreshInterval").value);
  if (ms > 0) refreshTimer = setInterval(refreshAll, ms);
}

$("#refreshInterval").addEventListener("change", setupRefresh);
$("#btnRefresh").addEventListener("click", refreshAll);
$("#btnResetStrategies").addEventListener("click", async () => {
  if (!confirm("确定恢复为默认重试策略？")) return;
  await api("/api/strategies/reset", { method: "POST" });
  toast("已恢复默认策略");
  await renderStrategies();
});

setupRefresh();
refreshAll();