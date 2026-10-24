# Roadalyx

I built Roadalyx for the TransTech Lab coding assessment. It reads the supplied TxDOT CRIS export for the Lubbock District, calculates crash statistics, and serves them through a Python API on AWS.

- [Live application](https://i2swgeojg6x3hacixkymlgrei40hcxso.lambda-url.us-east-2.on.aws/)
- [API documentation](https://i2swgeojg6x3hacixkymlgrei40hcxso.lambda-url.us-east-2.on.aws/api/docs)
- [EDA notebook](notebooks/eda.ipynb)

## Where to review the required work

| Requirement | Where I implemented it |
|---|---|
| EDA, useful columns, data issues and cleaning decisions | [Notebook](notebooks/eda.ipynb) |
| CSV parsing and one record per crash | [cris.py](roadalyx/cris.py) |
| Severity counts, top five factors and time patterns | [metrics.py](roadalyx/metrics.py), [CLI](roadalyx/__main__.py) |
| REST API, filters and response formats | [api.py](roadalyx/api.py), [query.py](roadalyx/query.py), [schemas.py](roadalyx/schemas.py) |
| AWS deployment | [CloudFormation template](infra/template.yaml), [deployment script](scripts/deploy.sh) |
| Tests | [Pipeline tests](tests/test_pipeline.py), [API tests](tests/test_api.py) |

## Run locally

I use Python 3.13, matching the Lambda runtime. The raw CSV is not in the repository; put the supplied file at `data/raw/district_crashes.csv`.

```bash
python3.13 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

python -m roadalyx data/raw/district_crashes.csv
uvicorn roadalyx.api:app --reload
```

The processing command prints the three required metrics and writes `data/processed/crashes.json.gz`. Open `http://127.0.0.1:8000/api/docs` to query the API.

No environment variables are needed locally. `ROADALYX_DATA` can point to a different processed file, or to an `s3://bucket/key` URI on AWS. `ROADALYX_WEB` overrides the built frontend directory, which defaults to `roadalyx/web`.

Run the tests, or execute the notebook from the repository root:

```bash
pytest
jupyter nbconvert --to notebook --execute --inplace notebooks/eda.ipynb
```

The notebook also includes saved results so it can be read without running it.

## What I found in the data

The main problem was the unit of observation. The CSV has **67,906 person rows**, not 67,906 accidents. I found **24,261 distinct Crash IDs** and checked that the crash fields I keep agree within each ID.

I build a separate crash table with one record per ID. I keep the source person rows unchanged. The main cleaning choices are:

- I find the CSV header after the preliminary lines rather than assuming the file starts with data.
- I split contributing factors on `;`, trim spaces and remove repeats within each crash. One crash can contribute to several factor counts, but not twice to the same one.
- I keep `NONE` and `OTHER (EXPLAIN IN NARRATIVE)` in the records but exclude them from the factor ranking. I report crashes without a specific coded factor separately.
- I keep crashes with missing coordinates in the totals; they are absent only from the map.
- I treat unknown speed limits as missing, normalize yes/no labels, and read crash times as HHMM.
- I treat `UNKNOWN` and `NA` as missing street names. This affects 26 crashes, which stay in the totals.
- I reject missing or invalid Crash IDs and dates, and empty exports, before writing the processed file. I also check the export's declared counts and conflicting crash fields.
- I reject missing, non-numeric or negative death and injury counts instead of reporting them as zero.

I write the processed file to a temporary file first, then replace the previous one only when the write succeeds.

The supplied file contains K, A, B and C crashes from **1 January 2020 to 20 October 2026**. The results are:

| Severity | Crashes |
|---|---:|
| K — fatal | 624 |
| A — suspected serious injury | 1,546 |
| B — suspected minor injury | 7,224 |
| C — possible injury | 14,867 |

The most frequent factor is *Failed to control speed*, recorded in 5,559 crashes. The notebook shows the full top five and the time patterns. I mark 2026 as incomplete rather than presenting its lower count as a decline.

## Query the API

These three endpoints correspond to the required metrics:

```bash
curl 'http://127.0.0.1:8000/api/v1/severity'
curl 'http://127.0.0.1:8000/api/v1/factors?limit=5'
curl 'http://127.0.0.1:8000/api/v1/trends?by=year&county=lubbock'
```

I use the same calculation functions in the CLI and API. The metric and search endpoints share filters for county, severity, year range, road class, contributing factor and road-user involvement.

Those responses include the applied filters and matching crash count. An unknown county returns `422` with the valid choices. A valid selection with no matching crashes returns zero, not an error.

I added supporting endpoints for records, maps and breakdowns. The [OpenAPI documentation](https://i2swgeojg6x3hacixkymlgrei40hcxso.lambda-url.us-east-2.on.aws/api/docs) lists them. For a CSV export, use:

```bash
curl --compressed 'http://127.0.0.1:8000/api/v1/crashes?format=csv&county=lubbock'
```

## How I deployed it on AWS

I process the CSV locally and upload only the derived crash table. The API reads that table from private S3 storage on its first request in a new Lambda instance, then keeps it in memory.

```text
CSV -> Python processing -> compressed JSON in private S3
                                      |
                                      v
Client -> public HTTPS function URL -> Lambda / FastAPI
                                      |
                                      v
                                CloudWatch logs
```

| Service | Why I chose it |
|---|---|
| Lambda | The crash table is small enough to filter in memory. I did not need a database or a server running continuously. |
| Lambda function URL | It exposes the read-only API and frontend through one HTTPS address, without adding API Gateway. |
| S3 | It holds the processed data separately from the application package. The bucket blocks public access. |
| IAM | The function role can read the data object and write its logs. I do not put AWS credentials in the code. |
| CloudWatch Logs | It records request status and duration. I set retention to 14 days. |
| CloudFormation | It keeps the function, role, URL and log configuration in a reviewable template. |

A request reaches FastAPI through Mangum, the Lambda adapter. FastAPI validates the filters, selects the crashes and returns the computed result. The same function serves the optional frontend.

To deploy to an AWS account with an authenticated AWS CLI session:

```bash
scripts/deploy.sh
# After processing a replacement CSV, update only the dataset:
scripts/deploy.sh data
```

The script needs `aws`, `npm`, `zip`, `rsync` and the project virtual environment. It runs the Python tests, builds the frontend, packages the Linux dependencies, uploads to S3 and updates CloudFormation.

The default region is `us-east-2`; set `AWS_REGION` to change it. The deployment uses IAM permissions for credentials, private S3 storage, response security headers and validation of API parameters.


## Known limitations

- I only have injury crashes (K/A/B/C), not property-damage-only crashes. These are not all-crash totals.
- I report counts and severity shares, not road risk or crash rates. I do not have traffic volumes or vehicle miles traveled to calculate those rates.
- The data ends on 20 October 2026. Recent periods may also change as reports are added.
- The public function URL has no application-level rate limiting. Heavy use could consume the account's allowances or credits.
- The pipeline expects the supplied CRIS layout. I stop on invalid required fields rather than guessing values or silently dropping crashes.

Given more time, I would add a rate limit and a controlled way to refresh the dataset. I would not add more visual features before those safeguards.

## Optional frontend

I added a React frontend in [web](web/) as optional work, separate from the required pipeline and API. The Explorer lets an analyst filter the same data, view charts and a map, inspect crash records and download the selection.

Overview is an additional 3D view of located crashes. Its effects are visual, not measures of risk.

To run it locally, use Node 22.12+ and keep the API running on port 8000:

```bash
npm --prefix web ci
npm --prefix web run dev
npm --prefix web test
```

`npm --prefix web run build` writes the frontend to `roadalyx/web`, which FastAPI serves at `/`. The frontend is optional for running and reviewing the required API.

---

Data: TxDOT CRIS export supplied by TransTech Lab. County boundaries: US Census Bureau via `us-atlas`. Basemap: OpenFreeMap, OpenMapTiles and OpenStreetMap contributors.
