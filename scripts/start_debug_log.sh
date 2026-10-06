#!/usr/bin/env bash
set -eu

export DEBUG_LOG="${DEBUG_LOG:-1}"
python3 -m bilikara
