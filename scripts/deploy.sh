#!/usr/bin/env bash
# Build, test and deploy Roadalyx to AWS with the AWS CLI only.
#
#   scripts/deploy.sh            full deploy: tests, portal build, data, code, stack
#   scripts/deploy.sh data       re-publish the dataset only (after re-running the pipeline)
#
# Credentials come from your AWS CLI session (aws login / SSO / a profile); nothing is stored
# in the repository. Region defaults to us-east-2; override with AWS_REGION.
#
# Full deploy, in order:
#   1. run the Python tests (a failing test stops everything)
#   2. build the React portal into roadalyx/web
#   3. package the API with Linux ARM64 wheels into build/lambda.zip
#   4. make sure the private bucket exists and is locked down
#   5. upload the code package and the processed dataset to S3
#   6. deploy the CloudFormation stack (Lambda, Function URL, IAM role, log group)
#   7. keep the last two code packages, then call /api/health on the live URL

# Stop at the first failing command, unset variable or failed pipe: never deploy half a release.
set -euo pipefail

cd "$(dirname "$0")/.."
REGION="${AWS_REGION:-us-east-2}"
STACK=roadalyx
# The account comes from the current CLI session, so the bucket name is unique without hardcoding it.
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
BUCKET="roadalyx-${ACCOUNT}-${REGION}"
DATA=data/processed/crashes.json.gz
DATA_KEY=data/crashes.json.gz
PY=.venv/bin/python
export AWS_REGION="$REGION"

say() { printf '\n== %s\n' "$*" >&2; }
die() { printf 'deploy: %s\n' "$*" >&2; exit 1; }

for tool in aws npm zip rsync; do command -v "$tool" >/dev/null || die "$tool is required"; done
[[ -x "$PY" ]] || die "no virtualenv at .venv (see README, Run it locally)"
# A short content hash, used to name the code package: a new zip only when the code changed.
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -c1-16; }

# 4. The private bucket for the code package and the dataset.
ensure_bucket() {
  if ! aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
    say "Creating private bucket s3://$BUCKET"
    if [[ "$REGION" == us-east-1 ]]; then aws s3api create-bucket --bucket "$BUCKET" >/dev/null
    else aws s3api create-bucket --bucket "$BUCKET" --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null; fi
  fi
  # Applied on every run (all idempotent), so a first run that stopped half-way still ends hardened.
  # No public access, whatever a later policy or ACL says.
  aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  # Encrypted at rest with S3-managed keys (free).
  aws s3api put-bucket-encryption --bucket "$BUCKET" --server-side-encryption-configuration \
    '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
  # Refuse any request that is not over HTTPS.
  aws s3api put-bucket-policy --bucket "$BUCKET" --policy "{
    \"Version\":\"2012-10-17\",
    \"Statement\":[{\"Sid\":\"TlsOnly\",\"Effect\":\"Deny\",\"Principal\":\"*\",\"Action\":\"s3:*\",
      \"Resource\":[\"arn:aws:s3:::$BUCKET\",\"arn:aws:s3:::$BUCKET/*\"],
      \"Condition\":{\"Bool\":{\"aws:SecureTransport\":\"false\"}}}]}"
  aws s3api delete-bucket-lifecycle --bucket "$BUCKET" 2>/dev/null || true
}

# Keep the live code package and the one before it (CloudFormation rolls back to it); delete older ones.
prune_releases() {
  local keys key
  keys="$(aws s3api list-objects-v2 --bucket "$BUCKET" --prefix releases/ \
    --query 'reverse(sort_by(Contents, &LastModified))[2:].Key' --output text)"
  while IFS= read -r key; do
    # An empty list is normal on the first two deployments, not a deployment failure.
    [[ -z "$key" || "$key" == None ]] && continue
    aws s3 rm "s3://$BUCKET/$key" --only-show-errors
  done <<< "${keys//$'\t'/$'\n'}"
}

# 5b. Upload the dataset and print its ETag. The ETag is passed to the stack as DataVersion:
# when the data changes, the function configuration changes and new instances load the new file.
publish_data() {
  [[ -f "$DATA" ]] || die "missing $DATA: run  $PY -m roadalyx data/raw/district_crashes.csv"
  say "Uploading $DATA"
  aws s3 cp "$DATA" "s3://$BUCKET/$DATA_KEY" --content-type application/gzip --only-show-errors
  aws s3api head-object --bucket "$BUCKET" --key "$DATA_KEY" --query ETag --output text | tr -d '"'
}

# 6. Create or update the stack. CloudFormation changes only what differs and rolls back on failure.
# CAPABILITY_IAM acknowledges that the template creates an IAM role.
deploy_stack() {
  local code_key="$1" data_version="$2"
  say "Deploying CloudFormation stack $STACK"
  aws cloudformation deploy --stack-name "$STACK" --template-file infra/template.yaml \
    --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset \
    --parameter-overrides "BucketName=$BUCKET" "CodeKey=$code_key" "DataVersion=$data_version"
}

# "deploy.sh data": a new dataset with the code already deployed (reuses the live code package).
if [[ "${1:-}" == "data" ]]; then
  say "Tests"
  "$PY" -m pytest -q
  ensure_bucket
  version="$(publish_data)"
  code_key="$(aws cloudformation describe-stacks --stack-name "$STACK" \
    --query "Stacks[0].Parameters[?ParameterKey=='CodeKey'].ParameterValue" --output text)"
  deploy_stack "$code_key" "$version"
  exit 0
fi

# 1. Tests
say "Tests"
"$PY" -m pytest -q

# 2. The portal: npm ci installs the exact locked versions, the build writes static files to roadalyx/web.
say "Building the portal"
npm --prefix web ci --no-audit --no-fund >/dev/null
npm --prefix web run build >/dev/null

# 3. The Lambda package. Lambda runs Linux on ARM (Graviton), not macOS, so the dependencies are
# downloaded as manylinux aarch64 wheels for Python 3.13 instead of whatever this machine would install.
say "Packaging the Lambda (Linux arm64 wheels, Python 3.13)"
rm -rf build && mkdir -p build/lambda
"$PY" -m pip install --quiet --target build/lambda --platform manylinux2014_aarch64 \
  --implementation cp --python-version 3.13 --only-binary=:all: -r requirements-lambda.txt
# The pipeline modules need pandas and never run on Lambda.
rsync -a --exclude '__pycache__' --exclude 'cris.py' --exclude '__main__.py' roadalyx build/lambda/
(cd build/lambda && zip -qr ../lambda.zip .)
code_key="releases/$(sha256 build/lambda.zip).zip"
say "Package $(du -h build/lambda.zip | cut -f1) -> s3://$BUCKET/$code_key"

# 4-7. Bucket, uploads, stack, clean-up.
ensure_bucket
aws s3 cp build/lambda.zip "s3://$BUCKET/$code_key" --only-show-errors
version="$(publish_data)"
deploy_stack "$code_key" "$version"
prune_releases

url="$(aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='Url'].OutputValue" --output text)"
# The live URL must answer with the dataset loaded, or the script exits with an error (curl -f).
say "Smoke test"
curl -fsS "${url}api/health" && echo
echo "Live at $url"
