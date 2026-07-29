#!/usr/bin/env node
/**
 * Occupies a pid and does nothing else, so a scenario can record a pid that is
 * alive but has no connection to any hub. Self-reaps after a minute in case a
 * test leaks it.
 */
setTimeout(() => {
  process.exit(0);
}, 60_000);
