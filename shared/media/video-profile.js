// MediaCapabilities/canPlayType only certify mainstream bitstreams, not every
// HEVC/AV1 profile or a Dolby Vision decoder. Shared by browser and server.
export function dolbyVisionFromProbe(stream) {
  const sideData = stream?.side_data_list?.find((item) => /\b(?:dovi|dolby vision)\b/i.test(String(item.side_data_type || "")));
  if (!sideData) return null;
  const numeric = (value) => value !== null && value !== undefined && value !== "" && Number.isInteger(Number(value)) ? Number(value) : null;
  return {
    profile: numeric(sideData.dv_profile),
    baseLayerCompatibilityId: numeric(sideData.dv_bl_signal_compatibility_id),
  };
}

export function browserVideoProfileSafe(video, codec) {
  codec = ({ avc: "h264", avc1: "h264", h265: "hevc", hvc1: "hevc", hev1: "hevc", av01: "av1" })[codec] || codec;
  const profile = String(video?.profile || "").trim().toLowerCase();
  if (codec === "hevc" && profile && !["main", "main 10"].includes(profile)) return false;
  if (codec === "av1" && profile && !["main", "0"].includes(profile)) return false;
  if (codec === "h264" && /high\s*10|4:?[24]:?[24]|scalable|stereo high|multiview/i.test(profile)) return false;
  const dv = video?.dolbyVision;
  if (!dv) return true;
  // P7 has an HDR10 base layer; P8 can have HDR10/SDR/HLG base layers.
  // Other DV variants (notably P5) require a Dolby Vision-specific decoder.
  const p = Number(dv.profile);
  const compatible = Number(dv.baseLayerCompatibilityId);
  return p === 7 ? [1, 6].includes(compatible)
    : p === 8 && [1, 2, 4].includes(compatible);
}
