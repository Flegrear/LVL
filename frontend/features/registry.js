// Browser features registered with frontend/features/feature-host.js.
// Owned by roadmap Part B (alpha-comic). alpha-dev keeps this list empty and
// doesn't edit it, so the two lanes never conflict here. See opus-work-notice.md.
//
// Add one import line and one array entry per feature (for example the
// readerFeature object exported by frontend/reader/feature.js). Each imported
// browser module also needs a static route; declare it in the feature's server
// entry in backend/features/registry.js, not in server.js. The import-graph
// test in tests/alpha-source-layout.test.js checks this.
export const CLIENT_FEATURES = Object.freeze([]);
