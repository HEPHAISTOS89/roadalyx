<p align="center">
  <img src="docs/assets/roadalyx-mark.svg" width="72" height="72" alt="Roadalyx logo">
</p>
<h1 align="center">Roadalyx</h1>
<p align="center">Crash analytics for the Lubbock District</p>
<p align="center">
  <a href="https://i2swgeojg6x3hacixkymlgrei40hcxso.lambda-url.us-east-2.on.aws/">Live application</a> ·
  <a href="https://i2swgeojg6x3hacixkymlgrei40hcxso.lambda-url.us-east-2.on.aws/api/docs">API documentation</a> ·
  <a href="notebooks/eda.ipynb">EDA notebook</a>
</p>

I built Roadalyx for the TransTech Lab coding assessment. It turns the supplied TxDOT CRIS export into crash statistics, a Python API and an analyst portal, deployed together on AWS.

## Where to look

| Required work | Files |
|---|---|
| EDA, relevant columns and cleaning decisions | [EDA notebook](notebooks/eda.ipynb) |
| Read, check and clean the CSV | [cris.py](roadalyx/cris.py), [processing command](roadalyx/__main__.py) |
| Severity counts, top five factors and time patterns | [metrics.py](roadalyx/metrics.py) |
| API, shared filters and response formats | [api.py](roadalyx/api.py), [query.py](roadalyx/query.py), [schemas.py](roadalyx/schemas.py) |
| AWS resources and deployment | [template.yaml](infra/template.yaml), [deploy.sh](scripts/deploy.sh) |
| Cleaning and API tests | [test_pipeline.py](tests/test_pipeline.py), [test_api.py](tests/test_api.py) |

## Run locally

I use Python 3.13, matching Lambda. Put the supplied CSV at `data/raw/district_crashes.csv` and run these commands from the repository root:

```bash
python3.13 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

python -m roadalyx data/raw/district_crashes.csv
uvicorn roadalyx.api:app --reload
```

The processing command prints the three required results and writes `data/processed/crashes.json.gz`. The API is then available at `http://127.0.0.1:8000/api/docs`.

The raw CSV and processed data are not committed. No environment variables are needed for the commands above.

| Variable | Use |
|---|---|
| `ROADALYX_DATA` | Override the local processed file path; on AWS, CloudFormation supplies the S3 URI |
| `ROADALYX_WEB` | Override `roadalyx/web`, the built frontend directory |
| `AWS_REGION` | Choose the deployment region; the script defaults to `us-east-2` |

### Tests and EDA

```bash
python -m pytest
python -m nbconvert --to notebook --execute --inplace \
  notebooks/eda.ipynb
```

The notebook includes saved tables and charts, so it can also be read on GitHub without running it.

## What I found and changed

The CSV has **67,906 person rows but 24,261 crashes**. I checked that the crash fields agree across rows with the same Crash ID, then built one record per accident. I leave the source person rows unchanged.

My other cleaning choices:

- I locate the header after the 11 introductory lines.
- I split factor lists on `;`, normalize spaces and case, and count each distinct factor once per crash.
- I keep `NONE` and `OTHER (EXPLAIN IN NARRATIVE)` in records, but leave them out of the ranking of specific factors.
- I keep the 849 crashes without coordinates in the statistics, but not on the map.
- I treat 191 speed limits coded `-1` as unknown, read times as HHMM, and normalize the different yes/no spellings.
- I treat `UNKNOWN` and `NA` as missing street names for 26 crashes.
- I reject empty exports and invalid IDs, dates or victim counts. By default, I also stop on inconsistent export totals or conflicting crash fields.

I write the processed file to a temporary file first. It replaces the previous file only after the write succeeds.

The export covers **1 January 2020 to 20 October 2026**:

| Severity | Crashes |
|---|---:|
| K: fatal injury | 624 |
| A: suspected serious injury | 1,546 |
| B: suspected minor injury | 7,224 |
| C: possible injury | 14,867 |

The most frequently recorded factor is *Failed to control speed*, cited in **5,559 crashes**. The [EDA](notebooks/eda.ipynb) shows the full top five and the yearly counts. I mark 2026 as partial in both the API and charts.

## Query the API

The three required results have their own endpoints:

| Endpoint | Result |
|---|---|
| `GET /api/v1/severity` | Crash counts and shares for K, A, B and C, plus victim totals |
| `GET /api/v1/factors?limit=5` | The five most frequently recorded contributing factors |
| `GET /api/v1/trends?by=year` | Crash counts over time, split by severity |

For example, to get fatal and serious-injury crashes in Lubbock County during 2024–2025:

```bash
curl --get 'http://127.0.0.1:8000/api/v1/severity' \
  --data-urlencode 'county=lubbock' \
  --data-urlencode 'severity=K,A' \
  --data-urlencode 'year_from=2024' \
  --data-urlencode 'year_to=2025'
```

The metric and search endpoints share `county`, `severity`, `year_from`, `year_to`, `road_class`, `factor` and `vru` filters. Their JSON responses include the applied filters and matching crash count. An unknown county returns `422` with valid choices; a valid selection with no crashes returns zero.

The processing command and API use the same metric functions. The [API documentation](https://i2swgeojg6x3hacixkymlgrei40hcxso.lambda-url.us-east-2.on.aws/api/docs) also covers crash records, map points, breakdowns and the day/hour grid.

To download every matching crash as CSV:

```bash
curl --get --compressed --output selection.csv \
  'http://127.0.0.1:8000/api/v1/crashes' \
  --data-urlencode 'format=csv' \
  --data-urlencode 'county=lubbock'
```

## AWS deployment

I kept the app to one Lambda function and one private S3 bucket. The 24,261-crash table fits in memory, so I did not need a database or an always-on server.

I clean the CSV locally and upload `crashes.json.gz` to S3. The first request that needs crash data loads it into the Lambda instance; later requests in that instance reuse it.

![Architecture: local Python cleaning uploads processed data to private S3. An analyst reaches Lambda through its HTTPS Function URL. Lambda reads the data and writes CloudWatch logs.](docs/assets/architecture.svg)

[View the architecture at full size](docs/assets/architecture.svg)

| Service | Why I use it |
|---|---|
| Lambda | Run on demand and filter the small crash table in memory |
| Function URL | Serve the API and frontend at one HTTPS address without API Gateway |
| S3 | Keep the dataset separate from the code, with private storage for both data and deployment packages |
| IAM | Limit the function to reading its data object and writing its own logs |
| CloudWatch Logs | Inspect request status and duration; expire logs after 14 days |
| CloudFormation | Recreate the function, role, URL and log configuration from a reviewable template |

When a request reaches the function URL, Mangum passes it to FastAPI. FastAPI validates the filters, selects the matching crashes and returns JSON or CSV. The same function serves the frontend files, so the portal and API share one address.

I chose services with Free Tier allowances. Request volume, storage and logs still need to stay within the account's allowances to avoid charges.

### Deploy or update the data

Deployment needs Node 22.12+, npm, AWS CLI, `zip`, `rsync` and the project virtual environment. Authenticate the AWS CLI before running the script. I use that session for deployment and an IAM role at runtime; no credentials are stored in the code.

```bash
scripts/deploy.sh
```

The script runs the Python tests, builds the frontend, packages Lambda's Linux dependencies, uploads the code and data to S3, and updates CloudFormation. It prints the public URL and checks `/api/health` at the end.

After processing a replacement CSV, I can update only the dataset:

```bash
python -m roadalyx data/raw/district_crashes.csv
scripts/deploy.sh data
```

This also updates the function configuration so new Lambda instances load the replacement data.

## Limits and next steps

- The export contains injury crashes only (K/A/B/C), not property-damage-only crashes.
- Without traffic volumes or vehicle miles traveled, I can compare counts and severity shares, not crash rates.
- The data ends on 20 October 2026. Recent counts may change as more reports are added.
- The pipeline expects the supplied CRIS layout.
- The public URL has no application-level rate limiting, so heavy traffic can consume the account's allowances or credits.

Given more time, I would add request throttling and a validated data-refresh workflow.

## Frontend (bonus)

I built a React frontend in [web](web/) on top of the same API. In Explorer, an analyst can filter the data, inspect severity and time charts, expand the map, open individual crash records and download the selection. The filters stay in the URL so a view can be bookmarked or shared.

[![Explorer showing the county and severity filters, crash totals, map and severity chart.](docs/assets/explorer.jpg)](https://i2swgeojg6x3hacixkymlgrei40hcxso.lambda-url.us-east-2.on.aws/explorer)

Overview provides a 3D view of the located crashes over time. Its visual effects are not measures of road risk.

To run the frontend locally, use Node 22.12+ and keep the API running on port 8000:

```bash
npm --prefix web ci
npm --prefix web run dev
npm --prefix web test
```

Vite prints the local URL. `npm --prefix web run build` writes the frontend to `roadalyx/web`, which FastAPI serves at `/`.

---

Data: TxDOT CRIS export supplied by TransTech Lab. County boundaries: US Census Bureau via `us-atlas`. Basemap: OpenFreeMap, OpenMapTiles and OpenStreetMap contributors.
