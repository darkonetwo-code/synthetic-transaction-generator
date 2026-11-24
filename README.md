# Scotia-Synth

Synthetic Canadian bank transaction generator for demos, tests, and UI mockups.

This project is **not affiliated with Scotiabank or any other financial institution**. Every file it writes is fictional. Do not present the output as a real statement, proof of funds, or identity document.

The sample statement page is generic (`Date | Transactions | Withdrawn | Deposited | Balance`) and is always marked:

**SYNTHETIC SAMPLE – NOT A REAL STATEMENT**

No bank logos are included.

## What's in the box

| Path | Purpose |
| --- | --- |
| `catalog.json` | Shared merchant lists, payees, amount defaults, and type labels. Both the Python generator and the web UI read this file. |
| `generate.py` | Command-line generator (Python 3, standard library only). |
| `output/transactions.json` | Pre-generated bundled dataset (seed `20261123`). |
| `output/transactions.csv` | Same dataset as CSV. |
| `web/` | Self-contained Vite + vanilla JS app. Generator logic lives in `web/src/generator.js`. |
| `web/public/transactions.json` | Copy of the bundled dataset for **Load bundled dataset**. |
| `web-screenshot.png` | Headless screenshot of the running UI. |

The date window is always exactly **90 days** ending on the chosen end date, split into **three 30-day statement periods**. Dates are random but written in strict chronological order. Several transactions may land on the same day; identical duplicate rows are not emitted. Amounts are CAD. Running balances reconcile to each account's opening and closing figures.

## Python generator

```bash
cd /workspace/scotia-synth
python3 generate.py
```

Useful options:

```bash
python3 generate.py \
  --seed 20261123 \
  --account-type both \
  --accounts 2 \
  --starting-balance 3842.17 \
  --transactions 250 \
  --end-date 2026-11-23 \
  --out-dir output \
  --copy-web-public
```

- `--account-type` — `chequing`, `savings`, or `both`
- `--accounts` — 1 to 5
- `--min-amount` / `--max-amount` — optional overrides for spend-like amounts (POS, mobile pay, ABM, e-Transfer, and spend categories). Payroll, fees, interest, transfers, and bills keep their own ranges unless you only generate those types.
- `--categories` — comma-separated: `grocery,gas,retail,restaurants,coffee,pharmacy,online,utilities,telecom,insurance`
- `--types` — comma-separated: `interac_etransfer,pad,bill_payment,pos,abm,fee,interest,payroll,transfer,mobile_pay`
- `--copy-web-public` — copies `transactions.json` into `web/public/`

The command prints a short validation report (chronological dates, no duplicates, balances reconcile).

## Web UI

```bash
cd /workspace/scotia-synth/web
npm install
npm run dev
```

Then open the printed local URL (default `http://127.0.0.1:5173`).

```bash
npm run build      # production build in web/dist
npm run preview    # preview the production build
```

The UI can generate a new set from the same options as the CLI, preview it as a table, download CSV or JSON, and render one account / one month as a generic statement page. Set the **seed** field to reproduce a run. **Load bundled dataset** fetches the pre-generated `web/public/transactions.json`.

The JavaScript generator is a port of `generate.py`. It uses the same `catalog.json`, description conventions, and LCG, so the same options and seed are intended to produce the same ledger (except `meta.generated_at`).

## Dataset shape

JSON contains `meta`, `holder`, `accounts`, and a flat `transactions` array. Each transaction has `date`, `description`, `type`, `category`, `withdrawn`, `deposited`, `amount`, `balance`, `currency`, `period_id`, and `account_id`.

CSV columns: `id,account_id,account_type,account_name,account_number,date,description,type,category,withdrawn,deposited,amount,balance,currency,period_id`.

The bundled sample uses a fictional holder (Jordan Hale, Edmonton), transit `99999`, and obviously synthetic account numbers.
