# VTAB Reporting Services 6.1.7 — Desktop Measure Recovery Parity

- Adds the same conservative DAX correction engine used by Desktop.
- Keeps correction and compatibility reconstruction as separate, auditable stages.
- Chains correction into reconstruction for malformed pasted formulas that also use an unsupported function.
- Requires semantic, storage compiler, and visual-query preflight before any recovery proposal is marked usable.
- Preserves compact signed numeric literals for time-intelligence compatibility.
- Publishes engine version 6.1.7 for Desktop/Services parity.

Verification: 69 applicable Services DAX tests, 13 focused recovery checks, the Desktop/Services sync contract, and the production web build pass.
