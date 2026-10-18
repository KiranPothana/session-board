#!/bin/sh
# Every check, for every change: the mod's tests (with the recorded conversations,
# tests/transcripts), the Windows/Linux UI's tests, the tests' copy of the tail read against the
# shell, and the cards the Mac board draws (tests/cards).
set -e
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
claude plugin test
(cd app && node --test ui/model.test.mjs ui/shortcut.test.mjs ui/geometry.test.mjs)
node tests/transcripts/check-pipeline.mjs 2>/dev/null
sh tests/cards/run.sh
