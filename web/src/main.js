import "./style.css";
import {
  CATALOG,
  TYPE_ORDER,
  generate,
  validate,
  toCsvString,
  statementSlice,
  windowLabel,
  formatCAD,
  formatLongDate,
} from "./generator.js";

const $ = (id) => document.getElementById(id);

let dataset = null;

function initLists() {
  const catBox = $("category-list");
  catBox.innerHTML = "";
  for (const [key, label] of Object.entries(CATALOG.category_labels)) {
    const el = document.createElement("label");
    el.innerHTML = `<input type="checkbox" name="category" value="${key}" checked /> ${label}`;
    catBox.appendChild(el);
  }

  const typeBox = $("type-list");
  typeBox.innerHTML = "";
  for (const key of TYPE_ORDER) {
    const label = CATALOG.type_labels[key];
    const weight = CATALOG.default_type_weights[key];
    const row = document.createElement("label");
    row.className = "type-row";
    row.innerHTML = `
      <input type="checkbox" name="type" value="${key}" checked />
      <span>${label}</span>
      <input type="number" min="0" step="1" name="weight-${key}" value="${weight}" aria-label="${label} weight" />
    `;
    typeBox.appendChild(row);
  }
}

function updateWindowLabel() {
  const end = $("end-date").value || "2026-11-23";
  const info = windowLabel(end);
  $("window-label").textContent = `Date window: ${info.text}`;
}

function readOptions() {
  const categories = [...document.querySelectorAll('input[name="category"]:checked')].map((el) => el.value);
  const types = [...document.querySelectorAll('input[name="type"]:checked')].map((el) => el.value);
  const typeWeights = {};
  for (const key of TYPE_ORDER) {
    const box = document.querySelector(`input[name="type"][value="${key}"]`);
    const weightInput = document.querySelector(`input[name="weight-${key}"]`);
    const raw = Number(weightInput.value);
    typeWeights[key] = box.checked ? (Number.isFinite(raw) ? raw : 0) : 0;
  }
  const minRaw = $("min-amount").value;
  const maxRaw = $("max-amount").value;
  return {
    seed: $("seed").value.trim() || "20261123",
    account_type: $("account-type").value,
    num_accounts: Number($("num-accounts").value),
    starting_balance: Number($("starting-balance").value || 0),
    num_transactions: Number($("num-transactions").value),
    end_date: $("end-date").value || "2026-11-23",
    min_amount: minRaw === "" ? null : Number(minRaw),
    max_amount: maxRaw === "" ? null : Number(maxRaw),
    categories,
    types,
    type_weights: typeWeights,
  };
}

function setStatus(message, isError = false) {
  const bar = $("status-bar");
  bar.hidden = !message;
  bar.textContent = message || "";
  bar.classList.toggle("is-error", Boolean(isError));
}

function renderPreview(data, sourceLabel) {
  const errors = validate(data);
  const n = data.transactions.length;
  const a = data.accounts.length;
  const windowText = `${formatLongDate(data.meta.date_start)} – ${formatLongDate(data.meta.date_end)}`;
  const ok = errors.length === 0;
  $("preview-meta").textContent = `${n} transactions · ${a} account${a === 1 ? "" : "s"} · ${windowText} · seed ${data.meta.seed}${sourceLabel ? " · " + sourceLabel : ""}`;
  setStatus(
    ok
      ? "Balances reconcile. Dates are chronological. No identical duplicate rows."
      : `Validation failed: ${errors[0]}`,
    !ok
  );

  const acctName = Object.fromEntries(data.accounts.map((acct) => [acct.id, acct.name]));
  const body = document.querySelector("#preview-table tbody");
  const rows = data.transactions
    .map((t) => {
      const withdrawn = t.withdrawn ? formatCAD(t.withdrawn) : "";
      const deposited = t.deposited ? formatCAD(t.deposited) : "";
      return `<tr>
        <td>${t.date}</td>
        <td>${acctName[t.account_id] || t.account_id}</td>
        <td class="desc" title="${escapeHtml(t.description)}">${escapeHtml(t.description.replace(/\s+/g, " ").trim())}</td>
        <td>${escapeHtml(CATALOG.type_labels[t.type] || t.type)}</td>
        <td class="num withdrawn">${withdrawn}</td>
        <td class="num deposited">${deposited}</td>
        <td class="num">${formatCAD(t.balance)}</td>
      </tr>`;
    })
    .join("");
  body.innerHTML = rows || `<tr><td colspan="7" class="muted">No transactions.</td></tr>`;

  $("btn-csv").disabled = n === 0;
  $("btn-json").disabled = n === 0;
  fillStatementSelectors(data);
  renderStatement();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fillStatementSelectors(data) {
  const acctSel = $("statement-account");
  const periodSel = $("statement-period");
  const prevAcct = acctSel.value;
  const prevPeriod = periodSel.value;
  acctSel.innerHTML = data.accounts
    .map((a) => `<option value="${a.id}">${escapeHtml(a.name)} · ${a.account_number}</option>`)
    .join("");
  periodSel.innerHTML = data.meta.statement_periods
    .map(
      (p) =>
        `<option value="${p.id}">Period ${p.id}: ${formatLongDate(p.start)} – ${formatLongDate(p.end)}</option>`
    )
    .join("");
  if ([...acctSel.options].some((o) => o.value === prevAcct)) acctSel.value = prevAcct;
  if ([...periodSel.options].some((o) => o.value === prevPeriod)) periodSel.value = prevPeriod;
}

function renderStatement() {
  const root = $("statement-root");
  if (!dataset) {
    root.innerHTML = `<p class="muted">Generate or load a dataset to render a sample statement.</p>`;
    return;
  }
  const slice = statementSlice(dataset, $("statement-account").value, Number($("statement-period").value));
  if (!slice) {
    root.innerHTML = `<p class="muted">Select an account and period.</p>`;
    return;
  }
  const { account, period, holder, transactions, opening_balance, closing_balance } = slice;
  const addr = (holder.address_lines || []).map((line) => escapeHtml(line)).join("<br />");
  const rows = [
    `<tr class="open-close"><td>${formatLongDate(period.start)}</td><td>Opening balance</td><td></td><td></td><td class="num">${formatCAD(opening_balance)}</td></tr>`,
    ...transactions.map(
      (t) => `<tr>
        <td>${formatLongDate(t.date)}</td>
        <td class="desc">${escapeHtml(t.description)}</td>
        <td class="num withdrawn">${t.withdrawn ? formatCAD(t.withdrawn) : ""}</td>
        <td class="num deposited">${t.deposited ? formatCAD(t.deposited) : ""}</td>
        <td class="num">${formatCAD(t.balance)}</td>
      </tr>`
    ),
    `<tr class="open-close"><td>${formatLongDate(period.end)}</td><td>Closing balance</td><td></td><td></td><td class="num">${formatCAD(closing_balance)}</td></tr>`,
  ].join("");

  root.innerHTML = `
    <article class="statement-page">
      <div class="synth-banner">SYNTHETIC SAMPLE – NOT A REAL STATEMENT</div>
      <div class="statement-inner">
        <p class="statement-kicker">Personal account statement</p>
        <h2>${escapeHtml(CATALOG.institution_label)}</h2>
        <div class="statement-top">
          <div>
            <p class="holder-name">${escapeHtml(holder.name)}</p>
            <p class="holder-address">${addr}</p>
            <p class="acct-meta">Customer no. ${escapeHtml(holder.customer_number)}</p>
          </div>
          <div>
            <p class="holder-name">${escapeHtml(account.name)}</p>
            <p class="acct-meta">Account ${escapeHtml(account.account_number)}</p>
            <p class="acct-meta">Transit ${escapeHtml(account.transit)}</p>
            <p class="acct-meta">Period ${formatLongDate(period.start)} – ${formatLongDate(period.end)}</p>
            <p class="acct-meta">Currency CAD</p>
          </div>
        </div>
        <div class="summary">
          <div><span>Opening balance</span><strong>${formatCAD(opening_balance)}</strong></div>
          <div><span>Total withdrawn</span><strong>${formatCAD(slice.total_withdrawn)}</strong></div>
          <div><span>Total deposited</span><strong>${formatCAD(slice.total_deposited)}</strong></div>
          <div><span>Closing balance</span><strong>${formatCAD(closing_balance)}</strong></div>
        </div>
        <table class="statement-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Transactions</th>
              <th class="num">Withdrawn</th>
              <th class="num">Deposited</th>
              <th class="num">Balance</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p class="statement-footer">
        This page is a fabricated sample for software testing and education.
        It is not issued by a bank, does not describe a real account, and must
        not be used as proof of funds or identity. No financial-institution logos
        are used.
      </p>
    </article>
  `;
}

function runGenerate() {
  const categories = [...document.querySelectorAll('input[name="category"]:checked')];
  const types = [...document.querySelectorAll('input[name="type"]:checked')];
  if (!categories.length) {
    setStatus("Select at least one merchant category.", true);
    return;
  }
  if (!types.length) {
    setStatus("Select at least one transaction type.", true);
    return;
  }
  dataset = generate(readOptions());
  renderPreview(dataset, "generated");
}

async function loadBundled() {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}transactions.json`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    dataset = data;
    renderPreview(dataset, "bundled dataset");
  } catch (err) {
    setStatus(`Could not load bundled dataset: ${err.message}`, true);
  }
}

function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function switchTab(name) {
  document.querySelectorAll(".tab").forEach((tab) => {
    const on = tab.dataset.tab === name;
    tab.classList.toggle("is-active", on);
    tab.setAttribute("aria-selected", on ? "true" : "false");
  });
  document.querySelectorAll(".panel").forEach((panel) => {
    const on = panel.id === `panel-${name}`;
    panel.classList.toggle("is-active", on);
    panel.hidden = !on;
  });
}

function bind() {
  initLists();
  updateWindowLabel();

  $("end-date").addEventListener("change", updateWindowLabel);
  $("btn-generate").addEventListener("click", runGenerate);
  $("btn-load").addEventListener("click", loadBundled);
  $("btn-random-seed").addEventListener("click", () => {
    $("seed").value = String(Math.floor(Math.random() * 1_000_000_000));
  });
  $("cats-all").addEventListener("click", () => {
    document.querySelectorAll('input[name="category"]').forEach((el) => (el.checked = true));
  });
  $("cats-none").addEventListener("click", () => {
    document.querySelectorAll('input[name="category"]').forEach((el) => (el.checked = false));
  });
  $("btn-csv").addEventListener("click", () => {
    if (!dataset) return;
    download("transactions.csv", toCsvString(dataset), "text/csv;charset=utf-8");
  });
  $("btn-json").addEventListener("click", () => {
    if (!dataset) return;
    download("transactions.json", JSON.stringify(dataset, null, 2) + "\n", "application/json");
  });
  $("statement-account").addEventListener("change", renderStatement);
  $("statement-period").addEventListener("change", renderStatement);
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  });
  $("controls").addEventListener("submit", (e) => {
    e.preventDefault();
    runGenerate();
  });

  runGenerate();
}

bind();
