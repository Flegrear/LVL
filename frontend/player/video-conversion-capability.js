// The server reports whether video encoding is available. Until its first
// health response, assume only the Android shell lacks conversion; desktop
// keeps its established compatibility fallback.
let canConvert = typeof window === "undefined" || !(window.LvlAndroid
  || /\bLVL-Android\//.test(window.navigator?.userAgent || ""));

export function setServerVideoConversionAvailable(value) {
  if (typeof value === "boolean") canConvert = value;
}

export function serverCanConvertVideo() {
  return canConvert;
}
