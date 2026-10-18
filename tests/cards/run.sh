#!/bin/sh
# The cards the Mac board draws for the fixture home (tests/cards/home, from make-home.py), as
# text, against tests/cards/expected.txt: every change to the board runs it.
#   sh tests/cards/run.sh            build the board, draw the cards, compare
#   sh tests/cards/run.sh --update   write what it draws as the new expected.txt (read the diff)
set -e
here=$(cd "$(dirname "$0")" && pwd)
bin=$(mktemp -d)/board
swiftc -O -swift-version 5 -o "$bin" "$here/../../board/main.swift"
out=$(SESSION_BOARD_HOME="$here/home" "$bin" --cards 1792330000000)
if [ "$1" = "--update" ]; then printf '%s\n' "$out" > "$here/expected.txt"; echo "wrote expected.txt"; exit 0; fi
if printf '%s\n' "$out" | diff -u "$here/expected.txt" -; then echo "cards match ($(grep -c '^alert:' "$here/expected.txt") cards)"; else echo "cards differ"; exit 1; fi
