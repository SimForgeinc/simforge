export const ALPAMAYO_SFT_V3_RECIPE_ID = "alpamayo_sft_v3" as const;

export const ALPAMAYO_SFT_V3_CONTRACT_VERSION =
  "simforge.alpamayo-stage1-nav-package.v3" as const;

export const ALPAMAYO_SFT_V3_TARGET_TASK =
  "alpamayo1_5_stage1_nav_sft" as const;

export const ALPAMAYO_SFT_V3_QUEUE_BLOCK_MESSAGE =
  "alpamayo_sft_v3 packages are materialized by the A100 Package-Go workflow; publish an immutable prefix and manifest from the Package-Go script instead of queueing the unified CPU runner." as const;

export const ALPAMAYO_STAGE1_NAV_CAMERA_IDS = [
  "camera_front_wide_120fov",
  "camera_cross_left_120fov",
  "camera_cross_right_120fov",
  "camera_front_tele_30fov",
] as const;
