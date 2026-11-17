const fs = require('node:fs');
const assert = require('node:assert/strict');

const powerbi = fs.readFileSync('src/powerbi.css', 'utf8');

const checks = [
  [
    'dark mode styles notification item titles (vtabNotificationContent b)',
    powerbi.includes('.vtabNotificationContent b') &&
    powerbi.includes('html[data-color-mode="dark"] .servicesPortalShell .vtabNotificationContent b')
  ],
  [
    'dark mode styles notification header subtitle (vtabNotificationPanel>header small)',
    powerbi.includes('html[data-color-mode="dark"] .servicesPortalShell .vtabNotificationPanel>header small')
  ],
  [
    'dark mode styles notification header actions',
    powerbi.includes('html[data-color-mode="dark"] .servicesPortalShell .vtabNotificationPanel>header button')
  ],
  [
    'dark mode styles notification unread indicator dot',
    powerbi.includes('.vtabNotificationPanel article.unread::before')
  ],
  [
    'dark mode styles notification empty state and loading',
    powerbi.includes('html[data-color-mode="dark"] .servicesPortalShell .vtabNotificationEmpty b')
  ],
];

const failures = checks.filter(([, pass]) => !pass).map(([name]) => name);
for (const [name, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`);
}
assert.deepEqual(failures, [], `${failures.length} notification dark mode visibility check(s) failed`);
console.log(`${checks.length}/${checks.length} notification dark mode visibility checks passed`);
