#!/bin/sh
# SRI-235: V0..V4 isolation. Usage: sh scripts/sri224/run-variants.sh
export PLAYWRIGHT_BROWSERS_PATH=/Users/sriv/Library/Caches/ms-playwright SITE=music SCEN=basic,pseek REPS=4
D=scripts/sri224/variants
for V in V0 V1 V2 V3 V4; do
  mkdir -p $D/$V; unset PATCH DEFMODE
  case $V in V1) export PATCH=scripts/sri224/patches/v1-no-occlusion.js;; V2) export PATCH=scripts/sri224/patches/v2-no-capture.js;; V3) export PATCH=scripts/sri224/patches/v3-inert.js;; V4) export DEFMODE=1;; esac
  OUT=$D/$V node scripts/qa-sri224.mjs > $D/$V/run.out 2>&1
done
