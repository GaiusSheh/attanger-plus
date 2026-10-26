/* eslint-disable no-undef */
// Plan and log write operations without carrying them out (requirements §F8).
// On until the user turns it off after a trial period (Phase 2-6).
pref("dryRun", true);
// Look for changes made in the file manager at startup (requirements §F3).
// The test runner turns it off: its fixtures are such changes on purpose.
pref("inspectOnStartup", true);
