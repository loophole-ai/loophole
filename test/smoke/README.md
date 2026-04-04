# Loophole Smoke Tests

This directory contains automated UI tests for Loophole.

## Running Smoke Tests

To run the smoke tests:

1. Ensure the project is compiled.
2. Run the following command:
   npm run smoketest

## Debugging

Use the --verbose flag to see detailed logs of each test step:
npm run smoketest -- --verbose

## Developing Tests

Tests are located in this folder. When adding new tests, ensure they are independent and do not rely on previous workbench state.
