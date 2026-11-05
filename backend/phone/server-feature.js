// Static files of the phone layout (frontend/phone/), registered in
// backend/features/registry.js. No API routes and nothing to start.
const asset = (file) => [`/${file}`, { file, cacheControl: "no-cache" }];

export const PHONE_ASSETS = Object.freeze([
  asset("frontend/phone/phone-layout.js"),
  asset("frontend/phone/android-bridge.js"),
  asset("frontend/phone/phone.css"),
]);

export const phoneServerFeature = Object.freeze({
  id: "phone",
  assets: PHONE_ASSETS,
});
