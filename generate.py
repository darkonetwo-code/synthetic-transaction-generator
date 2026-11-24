#!/usr/bin/env python3
"""Synthetic Canadian bank transaction generator (demo data only).

Not affiliated with any financial institution. Output is fictional and must
not be presented as a real statement.
"""

from __future__ import annotations

import argparse
import csv
import json
import shutil
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CATALOG_PATH = ROOT / "catalog.json"
WINDOW_DAYS = 90
OVERDRAFT_FLOOR_CENTS = {
    "chequing": -20000,
    "savings": 0,
}

TYPE_ORDER = [
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
]

SPEND_TYPES = {"pos", "mobile_pay", "abm", "interac_etransfer"}


def load_catalog(path: Path | None = None) -> dict:
    with open(path or CATALOG_PATH, encoding="utf-8") as f:
        return json.load(f)


def hash_seed(seed) -> int:
    if seed is None or seed == "":
        seed = 20261123
    if isinstance(seed, int):
        return seed & 0xFFFFFFFF
    text = str(seed)
    if text.startswith("-") and text[1:].isdigit():
        return int(text) & 0xFFFFFFFF
    if text.isdigit():
        return int(text) & 0xFFFFFFFF
    h = 2166136261
    for b in text.encode("utf-8"):
        h ^= b
        h = (h * 16777619) & 0xFFFFFFFF
    return h


class LCG:
    """Numerical Recipes LCG; identical to the JS implementation."""

    def __init__(self, seed: int):
        self.state = seed & 0xFFFFFFFF

    def random(self) -> float:
        self.state = (self.state * 1664525 + 1013904223) & 0xFFFFFFFF
        return self.state / 4294967296

    def randint(self, lo: int, hi: int) -> int:
        if hi < lo:
            lo, hi = hi, lo
        if hi == lo:
            return lo
        return lo + int(self.random() * (hi - lo + 1))

    def choice(self, seq):
        if not seq:
            raise ValueError("choice from empty sequence")
        return seq[int(self.random() * len(seq))]

    def chance(self, p: float) -> bool:
        return self.random() < p


def dollars_to_cents(value) -> int:
    return int(round(float(value) * 100 + 1e-9))


def cents_to_dollars(cents: int) -> float:
    return int(cents) / 100.0


def money_str(cents: int) -> str:
    sign = "-" if cents < 0 else ""
    cents = abs(int(cents))
    return f"{sign}{cents // 100}.{cents % 100:02d}"


def parse_iso_date(value) -> date:
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    return date.fromisoformat(str(value)[:10])


def periods_from_end_date(end: date | str):
    end = parse_iso_date(end)
    start = end - timedelta(days=WINDOW_DAYS - 1)
    periods = []
    cursor = start
    for i in range(3):
        period_end = cursor + timedelta(days=29)
        if i == 2:
            period_end = end
        periods.append(
            {
                "id": i + 1,
                "start": cursor.isoformat(),
                "end": period_end.isoformat(),
            }
        )
        cursor = period_end + timedelta(days=1)
    return start, end, periods


def period_id_for(day: date, periods: list[dict]) -> int:
    iso = day.isoformat()
    for p in periods:
        if p["start"] <= iso <= p["end"]:
            return p["id"]
    return periods[-1]["id"]


def iter_days(start: date, end: date):
    cur = start
    while cur <= end:
        yield cur
        cur += timedelta(days=1)


def format_merchant_name(merchant: dict) -> str:
    if merchant.get("number"):
        return f"{merchant['name']} #{merchant['number']}"
    return merchant["name"]


def format_card_description(prefix: str, merchant: dict) -> str:
    name = format_merchant_name(merchant)
    city = merchant.get("city") or ""
    prov = merchant.get("province") or ""
    return f"{prefix:<22}{name:<24}{city:<14}{prov}".rstrip()


def make_accounts(opts: dict) -> list[dict]:
    n = int(opts["num_accounts"])
    kind = opts["account_type"]
    if kind == "chequing":
        types = ["chequing"] * n
    elif kind == "savings":
        types = ["savings"] * n
    else:
        if n == 1:
            types = ["chequing"]
        else:
            types = ["chequing", "savings"] + ["chequing"] * (n - 2)

    opening = dollars_to_cents(opts["starting_balance"])
    accounts = []
    for i, t in enumerate(types):
        suffix = 1200000 + (i + 1) * 111
        if t == "savings":
            suffix += 5000000
        number = f"{suffix:07d}"
        label = "Everyday Chequing" if t == "chequing" else "High Interest Savings"
        if types.count(t) > 1:
            label = f"{label} {sum(1 for x in types[: i + 1] if x == t)}"
        accounts.append(
            {
                "id": f"ACC-{i + 1:03d}",
                "type": t,
                "name": label,
                "transit": "99999",
                "account_number": f"99999-{number}",
                "holder_name": opts["_catalog"]["holder"]["name"],
                "currency": "CAD",
                "opening_balance_cents": opening,
            }
        )
    return accounts


def amount_cents(rng: LCG, key: str, opts: dict, catalog: dict) -> int:
    ranges = catalog["default_amount_ranges"]
    lo, hi = ranges.get(key, ranges.get("pos", [8, 160]))
    lo_c = dollars_to_cents(lo)
    hi_c = dollars_to_cents(hi)
    spend_like = key in SPEND_TYPES or key in catalog["spend_categories"]
    if spend_like and opts.get("min_amount") is not None:
        lo_c = dollars_to_cents(opts["min_amount"])
    if spend_like and opts.get("max_amount") is not None:
        hi_c = dollars_to_cents(opts["max_amount"])
    if lo_c > hi_c:
        lo_c, hi_c = hi_c, lo_c
    value = rng.randint(lo_c, hi_c)
    if key == "abm":
        # Typical ABM withdrawals in $20 increments, still inside the range.
        step = 2000
        lo_s = max(step, (lo_c + step - 1) // step * step)
        hi_s = (hi_c // step) * step
        if hi_s >= lo_s:
            value = rng.randint(lo_s // step, hi_s // step) * step
    return max(1, value)


def pick_merchant(rng: LCG, category: str, catalog: dict) -> dict:
    merchants = catalog["merchants"].get(category) or catalog["merchants"]["retail"]
    return rng.choice(merchants)


def pick_spend_category(rng: LCG, selected: list[str], catalog: dict) -> str:
    spend = [c for c in selected if c in catalog["spend_categories"]]
    if not spend:
        spend = list(catalog["spend_categories"])
    return rng.choice(spend)


def pick_bill_category(rng: LCG, selected: list[str], catalog: dict, preferred=None) -> str:
    bills = [c for c in selected if c in catalog["bill_categories"]]
    if preferred and preferred in bills:
        return preferred
    if not bills:
        bills = list(catalog["bill_categories"])
    return rng.choice(bills)


def random_date(rng: LCG, start: date, end: date) -> date:
    span = (end - start).days
    return start + timedelta(days=rng.randint(0, span))


def weekday_on_or_after(day: date, weekday: int) -> date:
    delta = (weekday - day.weekday()) % 7
    return day + timedelta(days=delta)


def build_scheduled(
    rng: LCG,
    opts: dict,
    catalog: dict,
    accounts: list[dict],
    start: date,
    end: date,
    periods: list[dict],
    enabled: set[str],
    selected_categories: list[str],
) -> list[dict]:
    rows = []
    chequing = [a for a in accounts if a["type"] == "chequing"]
    savings = [a for a in accounts if a["type"] == "savings"]

    if "payroll" in enabled and chequing:
        employer = rng.choice(catalog["employers"])
        pay_day = weekday_on_or_after(start + timedelta(days=rng.randint(0, 6)), 4)  # Friday
        while pay_day <= end:
            acct = rng.choice(chequing)
            cents = amount_cents(rng, "payroll", opts, catalog)
            rows.append(
                skeleton(
                    acct,
                    pay_day,
                    "payroll",
                    "payroll",
                    f"{'PAYROLL DEPOSIT':<22}{employer}",
                    0,
                    cents,
                    periods,
                )
            )
            pay_day += timedelta(days=14)

    if "fee" in enabled and chequing:
        for period in periods:
            p_end = parse_iso_date(period["end"])
            for acct in chequing:
                cents = dollars_to_cents(15.95) if rng.chance(0.7) else amount_cents(rng, "fee", opts, catalog)
                desc = "MONTHLY ACCOUNT FEE"
                rows.append(skeleton(acct, p_end, "fee", "fee", desc, cents, 0, periods))

    if "interest" in enabled and savings:
        for period in periods:
            p_end = parse_iso_date(period["end"])
            for acct in savings:
                cents = amount_cents(rng, "interest", opts, catalog)
                rows.append(
                    skeleton(
                        acct,
                        p_end,
                        "interest",
                        "interest",
                        "CREDIT INTEREST",
                        0,
                        cents,
                        periods,
                    )
                )

    bill_cats = [c for c in selected_categories if c in catalog["bill_categories"]]
    if not bill_cats and ("pad" in enabled or "bill_payment" in enabled):
        bill_cats = list(catalog["bill_categories"])
    if bill_cats and ("pad" in enabled or "bill_payment" in enabled) and accounts:
        payer_pool = chequing or accounts
        for i, cat in enumerate(bill_cats):
            payee = pick_merchant(rng, cat, catalog)
            typ = "pad" if "pad" in enabled and (i % 2 == 0 or "bill_payment" not in enabled) else "bill_payment"
            if typ not in enabled:
                typ = "pad" if "pad" in enabled else "bill_payment"
            prefix = "PRE-AUTHORIZED DEBIT" if typ == "pad" else "BILL PAYMENT"
            offset = 4 + i * 5
            for period in periods:
                p_start = parse_iso_date(period["start"])
                p_end = parse_iso_date(period["end"])
                day = p_start + timedelta(days=min(offset, (p_end - p_start).days))
                acct = rng.choice(payer_pool)
                cents = amount_cents(rng, cat, opts, catalog)
                desc = f"{prefix:<22}{payee['name']}"
                rows.append(skeleton(acct, day, typ, cat, desc, cents, 0, periods))

    return rows


def skeleton(account, day, typ, category, description, withdrawn, deposited, periods):
    return {
        "account_id": account["id"],
        "date": day.isoformat() if isinstance(day, date) else day,
        "type": typ,
        "category": category,
        "description": description,
        "withdrawn_cents": int(withdrawn),
        "deposited_cents": int(deposited),
        "period_id": period_id_for(parse_iso_date(day), periods),
        "_order": 0,
    }


def weighted_type(rng: LCG, weights: dict[str, float]) -> str:
    items = [(k, w) for k, w in weights.items() if w > 0]
    total = sum(w for _, w in items)
    if total <= 0:
        return "pos"
    r = rng.random() * total
    acc = 0.0
    for k, w in items:
        acc += w
        if r <= acc:
            return k
    return items[-1][0]


def fill_transaction(
    rng: LCG,
    typ: str,
    opts: dict,
    catalog: dict,
    accounts: list[dict],
    start: date,
    end: date,
    periods: list[dict],
    selected_categories: list[str],
    reserved: set,
) -> list[dict]:
    chequing = [a for a in accounts if a["type"] == "chequing"]
    savings = [a for a in accounts if a["type"] == "savings"]
    day = random_date(rng, start, end)

    if typ == "payroll":
        pool = chequing or accounts
        acct = rng.choice(pool)
        employer = rng.choice(catalog["employers"])
        cents = amount_cents(rng, "payroll", opts, catalog)
        return [
            skeleton(
                acct,
                day,
                "payroll",
                "payroll",
                f"{'PAYROLL DEPOSIT':<22}{employer}",
                0,
                cents,
                periods,
            )
        ]

    if typ == "interest":
        pool = savings or accounts
        acct = rng.choice(pool)
        cents = amount_cents(rng, "interest", opts, catalog)
        return [skeleton(acct, day, "interest", "interest", "CREDIT INTEREST", 0, cents, periods)]

    if typ == "fee":
        pool = chequing or accounts
        acct = rng.choice(pool)
        desc = rng.choice(catalog["fee_descriptions"])
        cents = amount_cents(rng, "fee", opts, catalog)
        if desc == "MONTHLY ACCOUNT FEE":
            cents = dollars_to_cents(15.95)
        return [skeleton(acct, day, "fee", "fee", desc, cents, 0, periods)]

    if typ == "transfer":
        amount = amount_cents(rng, "transfer", opts, catalog)
        if len(accounts) >= 2:
            src = rng.choice(accounts)
            dest_pool = [a for a in accounts if a["id"] != src["id"]]
            dest = rng.choice(dest_pool)
            out_desc = f"{'ONLINE TRANSFER TO':<22}{dest['account_number']}"
            in_desc = f"{'ONLINE TRANSFER FROM':<22}{src['account_number']}"
            return [
                skeleton(src, day, "transfer", "transfer", out_desc, amount, 0, periods),
                skeleton(dest, day, "transfer", "transfer", in_desc, 0, amount, periods),
            ]
        acct = accounts[0]
        phantom = "99999-0000111"
        if rng.chance(0.5):
            desc = f"{'ONLINE TRANSFER TO':<22}ACCT {phantom}"
            return [skeleton(acct, day, "transfer", "transfer", desc, amount, 0, periods)]
        desc = f"{'ONLINE TRANSFER FROM':<22}ACCT {phantom}"
        return [skeleton(acct, day, "transfer", "transfer", desc, 0, amount, periods)]

    if typ == "interac_etransfer":
        pool = chequing or accounts
        acct = rng.choice(pool)
        contact = rng.choice(catalog["etransfer_contacts"])
        cents = amount_cents(rng, "interac_etransfer", opts, catalog)
        if rng.chance(0.45):
            desc = f"INTERAC E-TRANSFER REC'D - {contact}"
            return [skeleton(acct, day, typ, typ, desc, 0, cents, periods)]
        desc = f"INTERAC E-TRANSFER SENT - {contact}"
        return [skeleton(acct, day, typ, typ, desc, cents, 0, periods)]

    if typ in ("pad", "bill_payment"):
        pool = chequing or accounts
        acct = rng.choice(pool)
        cat = pick_bill_category(rng, selected_categories, catalog)
        payee = pick_merchant(rng, cat, catalog)
        cents = amount_cents(rng, cat, opts, catalog)
        prefix = "PRE-AUTHORIZED DEBIT" if typ == "pad" else "BILL PAYMENT"
        desc = f"{prefix:<22}{payee['name']}"
        return [skeleton(acct, day, typ, cat, desc, cents, 0, periods)]

    if typ == "abm":
        pool = chequing or accounts
        acct = rng.choice(pool)
        loc = rng.choice(catalog["abm_locations"])
        cents = amount_cents(rng, "abm", opts, catalog)
        if rng.chance(0.15):
            desc = format_card_description("ABM DEPOSIT", loc)
            return [skeleton(acct, day, typ, typ, desc, 0, cents, periods)]
        desc = format_card_description("ABM WITHDRAWAL", loc)
        return [skeleton(acct, day, typ, typ, desc, cents, 0, periods)]

    # POS or mobile pay
    prefix = "MOBILE PAYMENT" if typ == "mobile_pay" else "POS PURCHASE"
    pool = chequing or accounts
    acct = rng.choice(pool)
    cat = pick_spend_category(rng, selected_categories, catalog)
    merchant = pick_merchant(rng, cat, catalog)
    cents = amount_cents(rng, cat, opts, catalog)
    desc = format_card_description(prefix, merchant)
    return [skeleton(acct, day, typ, cat, desc, cents, 0, periods)]


def uniqueness_key(row: dict) -> tuple:
    return (
        row["account_id"],
        row["date"],
        row["description"],
        row["withdrawn_cents"],
        row["deposited_cents"],
        row["type"],
    )


def ensure_unique(rng: LCG, row: dict, reserved: set) -> dict:
    key = uniqueness_key(row)
    tries = 0
    while key in reserved and tries < 20:
        if row["withdrawn_cents"]:
            row["withdrawn_cents"] += 1
        elif row["deposited_cents"]:
            row["deposited_cents"] += 1
        else:
            row["description"] = f"{row['description']} REF {rng.randint(1000, 9999)}"
        key = uniqueness_key(row)
        tries += 1
    if key in reserved:
        row["description"] = f"{row['description']} REF {rng.randint(1000, 9999)}"
        key = uniqueness_key(row)
    reserved.add(key)
    return row


def assign_order(rng: LCG, rows: list[dict]) -> None:
    for row in rows:
        row["_order"] = rng.randint(0, 1_000_000)


def apply_balances(accounts: list[dict], rows: list[dict]) -> None:
    by_acct = {a["id"]: [] for a in accounts}
    for row in rows:
        by_acct[row["account_id"]].append(row)
    floors = {}
    openings = {}
    for a in accounts:
        floors[a["id"]] = OVERDRAFT_FLOOR_CENTS[a["type"]]
        openings[a["id"]] = a["opening_balance_cents"]

    for acct in accounts:
        bal = openings[acct["id"]]
        floor = floors[acct["id"]]
        for row in by_acct[acct["id"]]:
            withdrawn = row["withdrawn_cents"]
            deposited = row["deposited_cents"]
            projected = bal - withdrawn + deposited
            if projected < floor and withdrawn > 0:
                max_withdraw = bal + deposited - floor
                if max_withdraw < 1:
                    # Flip a tiny residual debit into a $1.00 floor-safe no-op shrink:
                    # convert to a $0.01 credit so the row stays and the floor holds.
                    row["withdrawn_cents"] = 0
                    row["deposited_cents"] = max(1, deposited)
                    withdrawn = 0
                    deposited = row["deposited_cents"]
                else:
                    row["withdrawn_cents"] = max_withdraw
                    withdrawn = max_withdraw
            bal = bal - withdrawn + deposited
            row["balance_cents"] = bal
        acct["closing_balance_cents"] = bal


def finalize_rows(rows: list[dict]) -> list[dict]:
    final = []
    for i, row in enumerate(rows, start=1):
        withdrawn = row["withdrawn_cents"]
        deposited = row["deposited_cents"]
        amount = deposited - withdrawn
        final.append(
            {
                "id": f"TXN-{i:06d}",
                "account_id": row["account_id"],
                "date": row["date"],
                "description": row["description"].rstrip(),
                "type": row["type"],
                "category": row["category"],
                "withdrawn": cents_to_dollars(withdrawn) if withdrawn else 0.0,
                "deposited": cents_to_dollars(deposited) if deposited else 0.0,
                "amount": cents_to_dollars(amount),
                "balance": cents_to_dollars(row["balance_cents"]),
                "currency": "CAD",
                "period_id": row["period_id"],
            }
        )
    return final


def validate(dataset: dict) -> list[str]:
    errors = []
    seen = set()
    by_acct_dates = {}
    for tx in dataset["transactions"]:
        key = (
            tx["account_id"],
            tx["date"],
            tx["description"],
            tx["withdrawn"],
            tx["deposited"],
            tx["type"],
        )
        if key in seen:
            errors.append(f"duplicate row: {key}")
        seen.add(key)
        by_acct_dates.setdefault(tx["account_id"], []).append(tx)

    acct_map = {a["id"]: a for a in dataset["accounts"]}
    for acct_id, txs in by_acct_dates.items():
        dates = [t["date"] for t in txs]
        if dates != sorted(dates):
            errors.append(f"{acct_id}: dates are not chronological")
        acct = acct_map[acct_id]
        bal = dollars_to_cents(acct["opening_balance"])
        for t in txs:
            bal = bal - dollars_to_cents(t["withdrawn"]) + dollars_to_cents(t["deposited"])
            if dollars_to_cents(t["balance"]) != bal:
                errors.append(
                    f"{t['id']} balance mismatch: row={t['balance']} expected={cents_to_dollars(bal)}"
                )
        if dollars_to_cents(acct["closing_balance"]) != bal:
            errors.append(f"{acct_id}: closing balance mismatch")
    return errors


def generate(opts: dict, catalog: dict | None = None) -> dict:
    catalog = catalog or load_catalog()
    opts = dict(opts)
    opts["_catalog"] = catalog
    rng = LCG(hash_seed(opts.get("seed", 20261123)))
    end = parse_iso_date(opts.get("end_date") or date(2026, 11, 23))
    start, end, periods = periods_from_end_date(end)

    selected_categories = list(opts.get("categories") or list(catalog["category_labels"].keys()))
    weights = dict(catalog["default_type_weights"])
    user_weights = opts.get("type_weights") or {}
    enabled_types = opts.get("types")
    if enabled_types is not None:
        enabled = set(enabled_types)
        for k in list(weights):
            if k not in enabled:
                weights[k] = 0
    else:
        enabled = {k for k, w in weights.items() if w > 0}
    for k, w in user_weights.items():
        if k in weights:
            weights[k] = float(w)
            if float(w) > 0:
                enabled.add(k)
            else:
                enabled.discard(k)

    accounts = make_accounts(opts)
    target = int(opts.get("num_transactions") or 250)

    rows = build_scheduled(
        rng, opts, catalog, accounts, start, end, periods, enabled, selected_categories
    )
    # If scheduled already exceeds target, keep earlier (higher-priority) rows.
    if len(rows) > target:
        rows = rows[:target]

    reserved: set = set()
    assign_order(rng, rows)

    fill_weights = dict(weights)
    # Payroll and interest are injected on a schedule so random fill does not
    # stack large credits and inflate running balances.
    for scheduled_type in ("payroll", "interest"):
        fill_weights[scheduled_type] = 0
    if sum(fill_weights.values()) <= 0:
        fill_weights = dict(weights)

    safety = 0
    while len(rows) < target and safety < target * 8:
        safety += 1
        typ = weighted_type(rng, fill_weights)
        created = fill_transaction(
            rng, typ, opts, catalog, accounts, start, end, periods, selected_categories, reserved
        )
        # A transfer pair may overflow the target by one; allow it only if we have room
        # for both, otherwise request a single-leg type.
        if len(rows) + len(created) > target:
            if len(created) > 1:
                continue
        for row in created:
            rows.append(row)
        if len(rows) >= target:
            rows = rows[:target]
            break

    assign_order(rng, rows)
    rows.sort(key=lambda r: (r["date"], r["_order"], r["account_id"], r["description"]))

    reserved = set()
    unique_rows = []
    for row in rows:
        unique_rows.append(ensure_unique(rng, row, reserved))
    rows = unique_rows

    apply_balances(accounts, rows)
    transactions = finalize_rows(rows)

    out_accounts = []
    for a in accounts:
        acct_tx = [t for t in transactions if t["account_id"] == a["id"]]
        withdrawn = sum(dollars_to_cents(t["withdrawn"]) for t in acct_tx)
        deposited = sum(dollars_to_cents(t["deposited"]) for t in acct_tx)
        out_accounts.append(
            {
                "id": a["id"],
                "type": a["type"],
                "name": a["name"],
                "transit": a["transit"],
                "account_number": a["account_number"],
                "holder_name": a["holder_name"],
                "currency": "CAD",
                "opening_balance": cents_to_dollars(a["opening_balance_cents"]),
                "total_withdrawn": cents_to_dollars(withdrawn),
                "total_deposited": cents_to_dollars(deposited),
                "closing_balance": cents_to_dollars(a["closing_balance_cents"]),
                "transaction_count": len(acct_tx),
            }
        )

    dataset = {
        "meta": {
            "synthetic": True,
            "disclaimer": catalog["disclaimer"],
            "currency": "CAD",
            "seed": opts.get("seed", 20261123),
            "generated_at": opts.get("generated_at")
            or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "date_start": start.isoformat(),
            "date_end": end.isoformat(),
            "window_days": WINDOW_DAYS,
            "statement_periods": periods,
            "num_transactions_requested": target,
        },
        "holder": catalog["holder"],
        "accounts": out_accounts,
        "transactions": transactions,
    }
    return dataset


CSV_FIELDS = [
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
]


def to_csv_rows(dataset: dict) -> list[dict]:
    acct = {a["id"]: a for a in dataset["accounts"]}
    rows = []
    for t in dataset["transactions"]:
        a = acct[t["account_id"]]
        rows.append(
            {
                "id": t["id"],
                "account_id": t["account_id"],
                "account_type": a["type"],
                "account_name": a["name"],
                "account_number": a["account_number"],
                "date": t["date"],
                "description": t["description"],
                "type": t["type"],
                "category": t["category"],
                "withdrawn": f"{t['withdrawn']:.2f}" if t["withdrawn"] else "",
                "deposited": f"{t['deposited']:.2f}" if t["deposited"] else "",
                "amount": f"{t['amount']:.2f}",
                "balance": f"{t['balance']:.2f}",
                "currency": t["currency"],
                "period_id": t["period_id"],
            }
        )
    return rows


def write_csv(dataset: dict, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        writer.writeheader()
        writer.writerows(to_csv_rows(dataset))


def write_json(dataset: dict, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(dataset, f, indent=2)
        f.write("\n")


def default_opts_from_args(args) -> dict:
    categories = args.categories
    if categories:
        categories = [c.strip() for c in categories.split(",") if c.strip()]
    types = args.types
    if types:
        types = [t.strip() for t in types.split(",") if t.strip()]
    return {
        "seed": args.seed,
        "account_type": args.account_type,
        "num_accounts": args.accounts,
        "starting_balance": args.starting_balance,
        "num_transactions": args.transactions,
        "end_date": args.end_date,
        "min_amount": args.min_amount,
        "max_amount": args.max_amount,
        "categories": categories,
        "types": types,
        "type_weights": None,
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="Generate synthetic Canadian bank transactions (demo data only)."
    )
    parser.add_argument("--seed", default="20261123", help="Reproducibility seed")
    parser.add_argument(
        "--account-type",
        choices=["chequing", "savings", "both"],
        default="both",
    )
    parser.add_argument("--accounts", type=int, default=2, help="Number of accounts (1-5)")
    parser.add_argument("--starting-balance", type=float, default=3842.17)
    parser.add_argument("--transactions", type=int, default=250)
    parser.add_argument("--end-date", default="2026-11-23", help="End of the 90-day window")
    parser.add_argument("--min-amount", type=float, default=None)
    parser.add_argument("--max-amount", type=float, default=None)
    parser.add_argument(
        "--categories",
        default=None,
        help="Comma-separated merchant categories (default: all)",
    )
    parser.add_argument(
        "--types",
        default=None,
        help="Comma-separated transaction types (default: all)",
    )
    parser.add_argument(
        "--out-dir",
        default=str(ROOT / "output"),
        help="Directory for transactions.csv and transactions.json",
    )
    parser.add_argument(
        "--copy-web-public",
        action="store_true",
        help="Copy transactions.json to web/public for the bundled dataset",
    )
    args = parser.parse_args(argv)

    if not 1 <= args.accounts <= 5:
        parser.error("--accounts must be between 1 and 5")

    catalog = load_catalog()
    opts = default_opts_from_args(args)
    dataset = generate(opts, catalog)
    errors = validate(dataset)
    out_dir = Path(args.out_dir)
    write_json(dataset, out_dir / "transactions.json")
    write_csv(dataset, out_dir / "transactions.csv")
    if args.copy_web_public:
        public = ROOT / "web" / "public"
        public.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(out_dir / "transactions.json", public / "transactions.json")

    meta = dataset["meta"]
    print(f"Wrote {len(dataset['transactions'])} transactions for {len(dataset['accounts'])} account(s)")
    print(f"Window: {meta['date_start']} to {meta['date_end']} ({WINDOW_DAYS} days, 3 periods)")
    print(f"Seed: {meta['seed']}")
    print(f"JSON: {out_dir / 'transactions.json'}")
    print(f"CSV:  {out_dir / 'transactions.csv'}")
    if errors:
        print("VALIDATION ERRORS:", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        return 1
    print("Validation: balances reconcile, dates chronological, no duplicate rows.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
