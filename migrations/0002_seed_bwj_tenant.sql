-- Watchman Phase 1 Step 1.2 — Seed the tenants table with BWJ
-- Inserts the single v1 tenant row. config_json shape per
-- Watchman_Design_Spec_v1.docx Section 15.2 (with channel_id and handle
-- extensions confirmed by Rodney 2026-05-11).
--
-- Re-runnable: INSERT OR REPLACE will overwrite the bwj row if it exists,
-- which is the correct behavior for config updates during build.

INSERT OR REPLACE INTO tenants (id, name, config_json, updated_at) VALUES (
  'bwj',
  'Blackwater Outdoor Journeys',
  '{
  "name": "Blackwater Outdoor Journeys",
  "short_name": "BWJ",
  "brand": {
    "accent_color": "#ef9f27",
    "logo_url": null,
    "dashboard_name": "Watchman"
  },
  "platforms": [
    {
      "id": "bwj_main",
      "label": "BWJ Main Channel",
      "color_start": "#cd4f3d",
      "color_end": "#ff6b47",
      "primary_kpi": "views",
      "secondary_kpi": "subs_gained",
      "source": "youtube_api",
      "channel_id": "UCNSNQagBxGlndO2YSU-5BxQ",
      "handle": "@BlackwaterOutdoorJourneys"
    },
    {
      "id": "bwj_shorts",
      "label": "Blackwater Outdoor Shorts",
      "color_start": "#a8362a",
      "color_end": "#cd4f3d",
      "primary_kpi": "views",
      "secondary_kpi": "subs_gained",
      "source": "youtube_api",
      "channel_id": "UCkxXRS46IRX3sXTrCrrpXpw",
      "handle": "@BlackwaterOutdoorShorts"
    },
    {
      "id": "tiktok",
      "label": "TikTok",
      "color_start": "#c8cdd7",
      "color_end": "#e8edf5",
      "primary_kpi": "views",
      "secondary_kpi": "followers_gained",
      "source": "manual",
      "handle": "@blackwaterjourneys"
    },
    {
      "id": "instagram",
      "label": "Instagram",
      "color_start": "#d34d6a",
      "color_end": "#f58ca0",
      "primary_kpi": "views",
      "secondary_kpi": "followers_gained",
      "source": "manual",
      "handle": "@myblackwateroutdoorjourneys"
    },
    {
      "id": "facebook",
      "label": "Facebook",
      "color_start": "#7367d8",
      "color_end": "#a89eee",
      "primary_kpi": "views",
      "secondary_kpi": "reach",
      "source": "manual",
      "handle": "Blackwater Outdoor Journeys"
    },
    {
      "id": "skool",
      "label": "Skool · CWS",
      "color_start": "#2d8fa8",
      "color_end": "#64c8e6",
      "primary_kpi": "activity_count",
      "secondary_kpi": "new_members",
      "source": "manual",
      "handle": "camping-wilderness-skool"
    }
  ],
  "cast": ["Rodney", "Tina", "River Dog", "Whitley"],
  "hook_formulas": ["ga_boy_caps", "tug_trash", "ig_hook", "fb_southern"],
  "thresholds": []
}',
  CURRENT_TIMESTAMP
);
