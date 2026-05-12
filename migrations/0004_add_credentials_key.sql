-- Watchman Phase 1 Step 1.4 prep -- add credentials_key to the two
-- youtube_api platforms in the BWJ tenant config.
--
-- Maps each youtube_api platform to its KV credential prefix:
--   bwj_main   -> youtube_oauth         (Main channel refresh token)
--   bwj_shorts -> youtube_oauth_shorts  (Shorts Brand Account refresh token)
--
-- Cron handler reads <credentials_key>_client_id, _client_secret,
-- _refresh_token from KV based on this field, so the channel->credentials
-- mapping is data-driven (not hardcoded).
--
-- Other platforms (tiktok, instagram, facebook, skool) have no credentials_key
-- since they currently use source='manual'.

UPDATE tenants
SET config_json = '{
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
      "handle": "@BlackwaterOutdoorJourneys",
      "credentials_key": "youtube_oauth"
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
      "handle": "@BlackwaterOutdoorShorts",
      "credentials_key": "youtube_oauth_shorts"
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
    updated_at = CURRENT_TIMESTAMP
WHERE id = 'bwj';
