# Privacy Policy for StealthTube

Last updated: 2026-04-16

StealthTube is designed to run locally in your browser.

## Summary

- StealthTube does not collect personal data.
- StealthTube does not transmit user data to external servers.
- StealthTube does not sell or share user data.
- StealthTube does not use remote code.

## What StealthTube Stores Locally

StealthTube stores the following data in browser local extension storage only:

- Stealth mode state (manual/current)
- Auto-stealth settings (keywords, presets, channel blacklist)
- Local usage statistics (for display inside the extension UI)

This information is stored only on your device and is not sent to us.

## Permissions and Why They Are Used

- storage: saves local settings and local counters
- declarativeNetRequest: blocks selected YouTube telemetry and tracking requests while Stealth mode is active
- scripting: runs bundled extension scripts required for in-page checks and feature workflows
- tabs: detects and updates relevant YouTube tabs for extension state sync
- alarms: performs periodic internal maintenance tasks
- webNavigation: detects YouTube navigation changes (including SPA route changes)
- host permissions (`*://*.youtube.com/*`, `*://s.youtube.com/*`): limit operation to YouTube domains required by the extension

## Data Sharing and Selling

StealthTube does not sell, transfer, or share user data with third parties.

## Children

StealthTube is not intended to collect data from children. No user data collection is performed.

## Changes to This Policy

If this policy changes, updates will be published in this file.

## Contact

For questions or support, open an issue in the project repository:

https://github.com/costin-cernea/youtube-stealth-mode-extension/issues
