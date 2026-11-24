/**
 * Port of generate.py. Shares catalog.json and the same description
 * conventions, LCG, and algorithm so a given seed can match the Python output.
 */
import catalog from "../../catalog.json" with { type: "json" };

export const CATALOG = catalog;
export const WINDOW_DAYS = 90;
export const TYPE_ORDER = [
  "interac_etransfer",
  "pad",
  "bill_payment",
  "pos",
  "abm",
  "fee",
  "interest",
  "payroll",
  "transfer",
  "mobile_pay",
];

export const CSV_FIELDS = [
  "id",
  "account_id",
  "account_type",
  "account_name",
  "account_number",
  "date",
  "description",
  "type",
  "category",
  "withdrawn",
  "deposited",
  "amount",
  "balance",
  "currency",
  "period_id",
];

const OVERDRAFT_FLOOR_CENTS = { chequing: -20000, savings: 0 };
const SPEND_TYPES = new Set(["pos", "mobile_pay", "abm", "interac_etransfer"]);

export function hashSeed(seed) {
  if (seed === null || seed === undefined || seed === "") {
    seed = 20261123;
  }
  if (typeof seed === "number" && Number.isFinite(seed)) {
    return seed >>> 0;
  }
  const text = String(seed);
  if (/^-?\d+$/.test(text)) {
    return Number(BigInt(text) & 0xffffffffn) >>> 0;
  }
  let h = 2166136261;
  const bytes = new TextEncoder().encode(text);
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export class LCG {
  constructor(seed) {
    this.state = seed >>> 0;
  }
  random() {
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
    return this.state / 4294967296;
  }
  randint(lo, hi) {
    if (hi < lo) {
      const t = lo;
      lo = hi;
      hi = t;
    }
    if (hi === lo) return lo;
    return lo + Math.trunc(this.random() * (hi - lo + 1));
  }
  choice(seq) {
    if (!seq.length) throw new Error("choice from empty sequence");
    return seq[Math.trunc(this.random() * seq.length)];
  }
  chance(p) {
    return this.random() < p;
  }
}

export function dollarsToCents(value) {
  return Math.round(Number(value) * 100 + 1e-9);
}

export function centsToDollars(cents) {
  return Number(cents) / 100;
}

export function moneyStr(cents) {
  const sign = cents < 0 ? "-" : "";
  cents = Math.abs(Number(cents));
  return `${sign}${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

export function formatCAD(value) {
  const cents = dollarsToCents(value);
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  const withCommas = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}${withCommas}.${frac}`;
}

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatLongDate(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  return `${d} ${MONTHS_SHORT[m - 1]} ${y}`;
}

function padRight(str, width) {
  const s = String(str);
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function padNum(n, width) {
  return String(n).padStart(width, "0");
}

function addDays(iso, days) {
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

function dayDiff(startIso, endIso) {
  const [ay, am, ad] = String(startIso).slice(0, 10).split("-").map(Number);
  const [by, bm, bd] = String(endIso).slice(0, 10).split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

function weekdayMon0(iso) {
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  const js = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return (js + 6) % 7;
}

export function periodsFromEndDate(end) {
  const endIso = String(end).slice(0, 10);
  const startIso = addDays(endIso, -(WINDOW_DAYS - 1));
  const periods = [];
  let cursor = startIso;
  for (let i = 0; i < 3; i++) {
    let periodEnd = addDays(cursor, 29);
    if (i === 2) periodEnd = endIso;
    periods.push({ id: i + 1, start: cursor, end: periodEnd });
    cursor = addDays(periodEnd, 1);
  }
  return { start: startIso, end: endIso, periods };
}

function periodIdFor(day, periods) {
  const iso = String(day).slice(0, 10);
  for (const p of periods) {
    if (p.start <= iso && iso <= p.end) return p.id;
  }
  return periods[periods.length - 1].id;
}

function formatMerchantName(merchant) {
  if (merchant.number) return `${merchant.name} #${merchant.number}`;
  return merchant.name;
}

function formatCardDescription(prefix, merchant) {
  const name = formatMerchantName(merchant);
  const city = merchant.city || "";
  const prov = merchant.province || "";
  return (padRight(prefix, 22) + padRight(name, 24) + padRight(city, 14) + prov).replace(/\s+$/, "");
}

function makeAccounts(opts) {
  const n = Number(opts.num_accounts);
  const kind = opts.account_type;
  let types;
  if (kind === "chequing") types = Array.from({ length: n }, () => "chequing");
  else if (kind === "savings") types = Array.from({ length: n }, () => "savings");
  else types = n === 1 ? ["chequing"] : ["chequing", "savings", ...Array.from({ length: n - 2 }, () => "chequing")];

  const opening = dollarsToCents(opts.starting_balance);
  const accounts = [];
  for (let i = 0; i < types.length; i++) {
    const t = types[i];
    let suffix = 1200000 + (i + 1) * 111;
    if (t === "savings") suffix += 5000000;
    const number = padNum(suffix, 7);
    let label = t === "chequing" ? "Everyday Chequing" : "High Interest Savings";
    const typeCount = types.filter((x) => x === t).length;
    if (typeCount > 1) {
      const nOfType = types.slice(0, i + 1).filter((x) => x === t).length;
      label = `${label} ${nOfType}`;
    }
    accounts.push({
      id: `ACC-${padNum(i + 1, 3)}`,
      type: t,
      name: label,
      transit: "99999",
      account_number: `99999-${number}`,
      holder_name: opts._catalog.holder.name,
      currency: "CAD",
      opening_balance_cents: opening,
    });
  }
  return accounts;
}

function amountCents(rng, key, opts, cat) {
  const ranges = cat.default_amount_ranges;
  const pair = ranges[key] || ranges.pos || [8, 160];
  let loC = dollarsToCents(pair[0]);
  let hiC = dollarsToCents(pair[1]);
  const spendLike = SPEND_TYPES.has(key) || cat.spend_categories.includes(key);
  if (spendLike && opts.min_amount != null) loC = dollarsToCents(opts.min_amount);
  if (spendLike && opts.max_amount != null) hiC = dollarsToCents(opts.max_amount);
  if (loC > hiC) {
    const t = loC;
    loC = hiC;
    hiC = t;
  }
  let value = rng.randint(loC, hiC);
  if (key === "abm") {
    const step = 2000;
    const loS = Math.max(step, Math.floor((loC + step - 1) / step) * step);
    const hiS = Math.floor(hiC / step) * step;
    if (hiS >= loS) {
      value = rng.randint(loS / step, hiS / step) * step;
    }
  }
  return Math.max(1, value);
}

function pickMerchant(rng, category, cat) {
  const merchants = cat.merchants[category] || cat.merchants.retail;
  return rng.choice(merchants);
}

function pickSpendCategory(rng, selected, cat) {
  let spend = selected.filter((c) => cat.spend_categories.includes(c));
  if (!spend.length) spend = [...cat.spend_categories];
  return rng.choice(spend);
}

function pickBillCategory(rng, selected, cat, preferred) {
  let bills = selected.filter((c) => cat.bill_categories.includes(c));
  if (preferred && bills.includes(preferred)) return preferred;
  if (!bills.length) bills = [...cat.bill_categories];
  return rng.choice(bills);
}

function randomDate(rng, start, end) {
  const span = dayDiff(start, end);
  return addDays(start, rng.randint(0, span));
}

function weekdayOnOrAfter(day, weekday) {
  const delta = (weekday - weekdayMon0(day) + 7) % 7;
  return addDays(day, delta);
}

function skeleton(account, day, typ, category, description, withdrawn, deposited, periods) {
  const iso = String(day).slice(0, 10);
  return {
    account_id: account.id,
    date: iso,
    type: typ,
    category,
    description,
    withdrawn_cents: withdrawn | 0,
    deposited_cents: deposited | 0,
    period_id: periodIdFor(iso, periods),
    _order: 0,
  };
}

function buildScheduled(rng, opts, cat, accounts, start, end, periods, enabled, selectedCategories) {
  const rows = [];
  const chequing = accounts.filter((a) => a.type === "chequing");
  const savings = accounts.filter((a) => a.type === "savings");

  if (enabled.has("payroll") && chequing.length) {
    const employer = rng.choice(cat.employers);
    let payDay = weekdayOnOrAfter(addDays(start, rng.randint(0, 6)), 4);
    while (payDay <= end) {
      const acct = rng.choice(chequing);
      const cents = amountCents(rng, "payroll", opts, cat);
      rows.push(
        skeleton(acct, payDay, "payroll", "payroll", padRight("PAYROLL DEPOSIT", 22) + employer, 0, cents, periods)
      );
      payDay = addDays(payDay, 14);
    }
  }

  if (enabled.has("fee") && chequing.length) {
    for (const period of periods) {
      const pEnd = period.end;
      for (const acct of chequing) {
        const cents = rng.chance(0.7) ? dollarsToCents(15.95) : amountCents(rng, "fee", opts, cat);
        rows.push(skeleton(acct, pEnd, "fee", "fee", "MONTHLY ACCOUNT FEE", cents, 0, periods));
      }
    }
  }

  if (enabled.has("interest") && savings.length) {
    for (const period of periods) {
      const pEnd = period.end;
      for (const acct of savings) {
        const cents = amountCents(rng, "interest", opts, cat);
        rows.push(skeleton(acct, pEnd, "interest", "interest", "CREDIT INTEREST", 0, cents, periods));
      }
    }
  }

  let billCats = selectedCategories.filter((c) => cat.bill_categories.includes(c));
  if (!billCats.length && (enabled.has("pad") || enabled.has("bill_payment"))) {
    billCats = [...cat.bill_categories];
  }
  if (billCats.length && (enabled.has("pad") || enabled.has("bill_payment")) && accounts.length) {
    const payerPool = chequing.length ? chequing : accounts;
    billCats.forEach((billCat, i) => {
      const payee = pickMerchant(rng, billCat, cat);
      let typ =
        enabled.has("pad") && (i % 2 === 0 || !enabled.has("bill_payment")) ? "pad" : "bill_payment";
      if (!enabled.has(typ)) typ = enabled.has("pad") ? "pad" : "bill_payment";
      const prefix = typ === "pad" ? "PRE-AUTHORIZED DEBIT" : "BILL PAYMENT";
      const offset = 4 + i * 5;
      for (const period of periods) {
        const span = dayDiff(period.start, period.end);
        const day = addDays(period.start, Math.min(offset, span));
        const acct = rng.choice(payerPool);
        const cents = amountCents(rng, billCat, opts, cat);
        const desc = padRight(prefix, 22) + payee.name;
        rows.push(skeleton(acct, day, typ, billCat, desc, cents, 0, periods));
      }
    });
  }
  return rows;
}

function weightedType(rng, weights) {
  const items = Object.entries(weights).filter(([, w]) => w > 0);
  const total = items.reduce((s, [, w]) => s + w, 0);
  if (total <= 0) return "pos";
  const r = rng.random() * total;
  let acc = 0;
  for (const [k, w] of items) {
    acc += w;
    if (r <= acc) return k;
  }
  return items[items.length - 1][0];
}

function fillTransaction(rng, typ, opts, cat, accounts, start, end, periods, selectedCategories) {
  const chequing = accounts.filter((a) => a.type === "chequing");
  const savings = accounts.filter((a) => a.type === "savings");
  const day = randomDate(rng, start, end);

  if (typ === "payroll") {
    const pool = chequing.length ? chequing : accounts;
    const acct = rng.choice(pool);
    const employer = rng.choice(cat.employers);
    const cents = amountCents(rng, "payroll", opts, cat);
    return [
      skeleton(acct, day, "payroll", "payroll", padRight("PAYROLL DEPOSIT", 22) + employer, 0, cents, periods),
    ];
  }
  if (typ === "interest") {
    const pool = savings.length ? savings : accounts;
    const acct = rng.choice(pool);
    const cents = amountCents(rng, "interest", opts, cat);
    return [skeleton(acct, day, "interest", "interest", "CREDIT INTEREST", 0, cents, periods)];
  }
  if (typ === "fee") {
    const pool = chequing.length ? chequing : accounts;
    const acct = rng.choice(pool);
    const desc = rng.choice(cat.fee_descriptions);
    let cents = amountCents(rng, "fee", opts, cat);
    if (desc === "MONTHLY ACCOUNT FEE") cents = dollarsToCents(15.95);
    return [skeleton(acct, day, "fee", "fee", desc, cents, 0, periods)];
  }
  if (typ === "transfer") {
    const amount = amountCents(rng, "transfer", opts, cat);
    if (accounts.length >= 2) {
      const src = rng.choice(accounts);
      const destPool = accounts.filter((a) => a.id !== src.id);
      const dest = rng.choice(destPool);
      const outDesc = padRight("ONLINE TRANSFER TO", 22) + dest.account_number;
      const inDesc = padRight("ONLINE TRANSFER FROM", 22) + src.account_number;
      return [
        skeleton(src, day, "transfer", "transfer", outDesc, amount, 0, periods),
        skeleton(dest, day, "transfer", "transfer", inDesc, 0, amount, periods),
      ];
    }
    const acct = accounts[0];
    const phantom = "99999-0000111";
    if (rng.chance(0.5)) {
      return [
        skeleton(
          acct,
          day,
          "transfer",
          "transfer",
          padRight("ONLINE TRANSFER TO", 22) + "ACCT " + phantom,
          amount,
          0,
          periods
        ),
      ];
    }
    return [
      skeleton(
        acct,
        day,
        "transfer",
        "transfer",
        padRight("ONLINE TRANSFER FROM", 22) + "ACCT " + phantom,
        0,
        amount,
        periods
      ),
    ];
  }
  if (typ === "interac_etransfer") {
    const pool = chequing.length ? chequing : accounts;
    const acct = rng.choice(pool);
    const contact = rng.choice(cat.etransfer_contacts);
    const cents = amountCents(rng, "interac_etransfer", opts, cat);
    if (rng.chance(0.45)) {
      return [
        skeleton(acct, day, typ, typ, `INTERAC E-TRANSFER REC'D - ${contact}`, 0, cents, periods),
      ];
    }
    return [skeleton(acct, day, typ, typ, `INTERAC E-TRANSFER SENT - ${contact}`, cents, 0, periods)];
  }
  if (typ === "pad" || typ === "bill_payment") {
    const pool = chequing.length ? chequing : accounts;
    const acct = rng.choice(pool);
    const billCat = pickBillCategory(rng, selectedCategories, cat);
    const payee = pickMerchant(rng, billCat, cat);
    const cents = amountCents(rng, billCat, opts, cat);
    const prefix = typ === "pad" ? "PRE-AUTHORIZED DEBIT" : "BILL PAYMENT";
    return [skeleton(acct, day, typ, billCat, padRight(prefix, 22) + payee.name, cents, 0, periods)];
  }
  if (typ === "abm") {
    const pool = chequing.length ? chequing : accounts;
    const acct = rng.choice(pool);
    const loc = rng.choice(cat.abm_locations);
    const cents = amountCents(rng, "abm", opts, cat);
    if (rng.chance(0.15)) {
      return [skeleton(acct, day, typ, typ, formatCardDescription("ABM DEPOSIT", loc), 0, cents, periods)];
    }
    return [skeleton(acct, day, typ, typ, formatCardDescription("ABM WITHDRAWAL", loc), cents, 0, periods)];
  }
  const prefix = typ === "mobile_pay" ? "MOBILE PAYMENT" : "POS PURCHASE";
  const pool = chequing.length ? chequing : accounts;
  const acct = rng.choice(pool);
  const spendCat = pickSpendCategory(rng, selectedCategories, cat);
  const merchant = pickMerchant(rng, spendCat, cat);
  const cents = amountCents(rng, spendCat, opts, cat);
  return [skeleton(acct, day, typ, spendCat, formatCardDescription(prefix, merchant), cents, 0, periods)];
}

function uniquenessKey(row) {
  return [row.account_id, row.date, row.description, row.withdrawn_cents, row.deposited_cents, row.type].join("\x1f");
}

function ensureUnique(rng, row, reserved) {
  let key = uniquenessKey(row);
  let tries = 0;
  while (reserved.has(key) && tries < 20) {
    if (row.withdrawn_cents) row.withdrawn_cents += 1;
    else if (row.deposited_cents) row.deposited_cents += 1;
    else row.description = `${row.description} REF ${rng.randint(1000, 9999)}`;
    key = uniquenessKey(row);
    tries += 1;
  }
  if (reserved.has(key)) {
    row.description = `${row.description} REF ${rng.randint(1000, 9999)}`;
    key = uniquenessKey(row);
  }
  reserved.add(key);
  return row;
}

function assignOrder(rng, rows) {
  for (const row of rows) row._order = rng.randint(0, 1_000_000);
}

function applyBalances(accounts, rows) {
  const byAcct = {};
  for (const a of accounts) byAcct[a.id] = [];
  for (const row of rows) byAcct[row.account_id].push(row);
  for (const acct of accounts) {
    let bal = acct.opening_balance_cents;
    const floor = OVERDRAFT_FLOOR_CENTS[acct.type];
    for (const row of byAcct[acct.id]) {
      let withdrawn = row.withdrawn_cents;
      let deposited = row.deposited_cents;
      const projected = bal - withdrawn + deposited;
      if (projected < floor && withdrawn > 0) {
        const maxWithdraw = bal + deposited - floor;
        if (maxWithdraw < 1) {
          row.withdrawn_cents = 0;
          row.deposited_cents = Math.max(1, deposited);
          withdrawn = 0;
          deposited = row.deposited_cents;
        } else {
          row.withdrawn_cents = maxWithdraw;
          withdrawn = maxWithdraw;
        }
      }
      bal = bal - withdrawn + deposited;
      row.balance_cents = bal;
    }
    acct.closing_balance_cents = bal;
  }
}

function finalizeRows(rows) {
  return rows.map((row, i) => {
    const withdrawn = row.withdrawn_cents;
    const deposited = row.deposited_cents;
    const amount = deposited - withdrawn;
    return {
      id: `TXN-${padNum(i + 1, 6)}`,
      account_id: row.account_id,
      date: row.date,
      description: row.description.replace(/\s+$/, ""),
      type: row.type,
      category: row.category,
      withdrawn: withdrawn ? centsToDollars(withdrawn) : 0.0,
      deposited: deposited ? centsToDollars(deposited) : 0.0,
      amount: centsToDollars(amount),
      balance: centsToDollars(row.balance_cents),
      currency: "CAD",
      period_id: row.period_id,
    };
  });
}

export function validate(dataset) {
  const errors = [];
  const seen = new Set();
  const byAcct = {};
  for (const tx of dataset.transactions) {
    const key = [tx.account_id, tx.date, tx.description, tx.withdrawn, tx.deposited, tx.type].join("\x1f");
    if (seen.has(key)) errors.push(`duplicate row: ${key}`);
    seen.add(key);
    (byAcct[tx.account_id] ||= []).push(tx);
  }
  const acctMap = Object.fromEntries(dataset.accounts.map((a) => [a.id, a]));
  for (const [acctId, txs] of Object.entries(byAcct)) {
    const dates = txs.map((t) => t.date);
    const sorted = [...dates].sort();
    if (dates.some((d, i) => d !== sorted[i])) errors.push(`${acctId}: dates are not chronological`);
    const acct = acctMap[acctId];
    let bal = dollarsToCents(acct.opening_balance);
    for (const t of txs) {
      bal = bal - dollarsToCents(t.withdrawn) + dollarsToCents(t.deposited);
      if (dollarsToCents(t.balance) !== bal) {
        errors.push(`${t.id} balance mismatch: row=${t.balance} expected=${centsToDollars(bal)}`);
      }
    }
    if (dollarsToCents(acct.closing_balance) !== bal) {
      errors.push(`${acctId}: closing balance mismatch`);
    }
  }
  return errors;
}

export function generate(opts, cat = catalog) {
  opts = { ...opts, _catalog: cat };
  const rng = new LCG(hashSeed(opts.seed ?? 20261123));
  const { start, end, periods } = periodsFromEndDate(opts.end_date || "2026-11-23");
  const selectedCategories = opts.categories?.length
    ? [...opts.categories]
    : Object.keys(cat.category_labels);

  const weights = { ...cat.default_type_weights };
  const userWeights = opts.type_weights || {};
  const enabledTypes = opts.types;
  let enabled;
  if (enabledTypes != null) {
    enabled = new Set(enabledTypes);
    for (const k of Object.keys(weights)) {
      if (!enabled.has(k)) weights[k] = 0;
    }
  } else {
    enabled = new Set(Object.entries(weights).filter(([, w]) => w > 0).map(([k]) => k));
  }
  for (const [k, w] of Object.entries(userWeights)) {
    if (k in weights) {
      weights[k] = Number(w);
      if (Number(w) > 0) enabled.add(k);
      else enabled.delete(k);
    }
  }

  const accounts = makeAccounts(opts);
  const target = Number(opts.num_transactions || 250);
  let rows = buildScheduled(rng, opts, cat, accounts, start, end, periods, enabled, selectedCategories);
  if (rows.length > target) rows = rows.slice(0, target);

  const reservedUnused = new Set();
  assignOrder(rng, rows);

  const fillWeights = { ...weights };
  for (const scheduledType of ["payroll", "interest"]) fillWeights[scheduledType] = 0;
  const fillSum = Object.values(fillWeights).reduce((s, w) => s + w, 0);
  const usedFill = fillSum <= 0 ? { ...weights } : fillWeights;

  let safety = 0;
  while (rows.length < target && safety < target * 8) {
    safety += 1;
    const typ = weightedType(rng, usedFill);
    const created = fillTransaction(
      rng,
      typ,
      opts,
      cat,
      accounts,
      start,
      end,
      periods,
      selectedCategories,
      reservedUnused
    );
    if (rows.length + created.length > target) {
      if (created.length > 1) continue;
    }
    for (const row of created) rows.push(row);
    if (rows.length >= target) {
      rows = rows.slice(0, target);
      break;
    }
  }

  assignOrder(rng, rows);
  rows.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a._order !== b._order) return a._order - b._order;
    if (a.account_id !== b.account_id) return a.account_id < b.account_id ? -1 : 1;
    if (a.description !== b.description) return a.description < b.description ? -1 : 1;
    return 0;
  });

  const reserved = new Set();
  rows = rows.map((row) => ensureUnique(rng, row, reserved));
  applyBalances(accounts, rows);
  const transactions = finalizeRows(rows);

  const outAccounts = accounts.map((a) => {
    const acctTx = transactions.filter((t) => t.account_id === a.id);
    const withdrawn = acctTx.reduce((s, t) => s + dollarsToCents(t.withdrawn), 0);
    const deposited = acctTx.reduce((s, t) => s + dollarsToCents(t.deposited), 0);
    return {
      id: a.id,
      type: a.type,
      name: a.name,
      transit: a.transit,
      account_number: a.account_number,
      holder_name: a.holder_name,
      currency: "CAD",
      opening_balance: centsToDollars(a.opening_balance_cents),
      total_withdrawn: centsToDollars(withdrawn),
      total_deposited: centsToDollars(deposited),
      closing_balance: centsToDollars(a.closing_balance_cents),
      transaction_count: acctTx.length,
    };
  });

  return {
    meta: {
      synthetic: true,
      disclaimer: cat.disclaimer,
      currency: "CAD",
      seed: opts.seed ?? 20261123,
      generated_at: opts.generated_at || new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      date_start: start,
      date_end: end,
      window_days: WINDOW_DAYS,
      statement_periods: periods,
      num_transactions_requested: target,
    },
    holder: cat.holder,
    accounts: outAccounts,
    transactions,
  };
}

export function toCsvRows(dataset) {
  const acct = Object.fromEntries(dataset.accounts.map((a) => [a.id, a]));
  return dataset.transactions.map((t) => {
    const a = acct[t.account_id];
    return {
      id: t.id,
      account_id: t.account_id,
      account_type: a.type,
      account_name: a.name,
      account_number: a.account_number,
      date: t.date,
      description: t.description,
      type: t.type,
      category: t.category,
      withdrawn: t.withdrawn ? t.withdrawn.toFixed(2) : "",
      deposited: t.deposited ? t.deposited.toFixed(2) : "",
      amount: t.amount.toFixed(2),
      balance: t.balance.toFixed(2),
      currency: t.currency,
      period_id: t.period_id,
    };
  });
}

function csvEscape(value) {
  const s = String(value ?? "");
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsvString(dataset) {
  const rows = toCsvRows(dataset);
  const lines = [CSV_FIELDS.join(",")];
  for (const row of rows) {
    lines.push(CSV_FIELDS.map((f) => csvEscape(row[f])).join(","));
  }
  return lines.join("\n") + "\n";
}

export function statementSlice(dataset, accountId, periodId) {
  const account = dataset.accounts.find((a) => a.id === accountId);
  const period = dataset.meta.statement_periods.find((p) => Number(p.id) === Number(periodId));
  if (!account || !period) return null;
  const all = dataset.transactions.filter((t) => t.account_id === accountId);
  const txs = all.filter((t) => t.period_id === period.id);
  let opening = account.opening_balance;
  const priorProper = all.filter((t) => t.date < period.start);
  if (priorProper.length) opening = priorProper[priorProper.length - 1].balance;
  let closing = opening;
  if (txs.length) {
    const first = txs[0];
    opening = dollarsToCents(first.balance) - dollarsToCents(first.deposited) + dollarsToCents(first.withdrawn);
    opening = centsToDollars(opening);
    closing = txs[txs.length - 1].balance;
  }
  const withdrawn = txs.reduce((s, t) => s + dollarsToCents(t.withdrawn), 0);
  const deposited = txs.reduce((s, t) => s + dollarsToCents(t.deposited), 0);
  return {
    account,
    period,
    holder: dataset.holder,
    transactions: txs,
    opening_balance: opening,
    closing_balance: closing,
    total_withdrawn: centsToDollars(withdrawn),
    total_deposited: centsToDollars(deposited),
    disclaimer: dataset.meta.disclaimer,
  };
}

export function windowLabel(endDate) {
  const { start, end, periods } = periodsFromEndDate(endDate);
  return {
    start,
    end,
    periods,
    text: `${formatLongDate(start)} – ${formatLongDate(end)} (90 days, 3 monthly periods)`,
  };
}
