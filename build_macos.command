#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
npm ci
npm run build
