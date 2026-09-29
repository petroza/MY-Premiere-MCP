#!/usr/bin/env bash
# Rychlý test lokálního plánu (Hermes) – vypíše vybrané věty. ./scripts/plan-review.sh <zdroj> "<zadání>" <sekundy>
cd "$(dirname "$0")/.."
node scripts/run-tool.mjs plan_edit_local "{\"path\":\"$1\",\"instruction\":\"$2\",\"targetSec\":$3,\"format\":\"review\"}" 2>&1 | grep -v "^ *[0-9]* %" | sed -n '1,/NÁHRADNÍCI/p'
