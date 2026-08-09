# Third-party notices

The application vendors the following browser libraries so its interface does not depend on public JavaScript CDNs at runtime:

| Component | Version | License | Local license |
|---|---:|---|---|
| Chart.js | 4.4.1 | MIT | `vendor/licenses/CHARTJS-LICENSE.md` |
| Leaflet | 1.9.4 | BSD-2-Clause | `vendor/licenses/LEAFLET-LICENSE` |
| Leaflet.heat | 0.2.0 | BSD-2-Clause | `vendor/licenses/LEAFLET-HEAT-LICENSE` |

The optional browser smoke test uses Playwright 1.62.0 under the Apache-2.0 license. It is a development dependency and is not loaded by the deployed application.

Map backgrounds are requested from CARTO and include OpenStreetMap/CARTO attribution in the interface. Deployment owners remain responsible for confirming current tile-service terms, usage limits, and attribution requirements.
