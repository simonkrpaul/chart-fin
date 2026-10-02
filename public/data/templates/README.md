# Chart templates

JSON files in this folder are picked up by `scripts/_manifest.py` and seeded
into every browser's IndexedDB on first boot. They appear in the Toolbar's
📋 Templates panel as pre-installed presets.

## How to add one

1. In the app: build a chart you like (indicators, offset overlays, cycle
   combiner, custom transits, confluence toggle).
2. Open **📋 Templates** → type a name → **💾 Save**. The template is saved
   to your browser's IndexedDB.
3. In the same panel, click **⬇ Export** next to the template. A `.json`
   file downloads to your Downloads folder.
4. Move it into `public/data/templates/` and rebuild the manifest:

   ```bash
   mv ~/Downloads/<slug>.json public/data/templates/
   python scripts/_manifest.py
   git add public/data/ && git commit -m "chore: add <name> template"
   ```

## Schema

```json
{
  "schemaVersion": 1,
  "id": "tmpl-...",
  "name": "Human-readable name",
  "description": "Optional one-liner",
  "createdAt": 1762000000000,
  "updatedAt": 1762000000000,
  "payload": {
    "timeframe": "1d",
    "showOverlays": true,
    "offsetConfluenceHighlight": true,
    "gapVisibility": "session_calendar_days",
    "indicatorConfigs": [...],
    "overlayConfigs": [...],
    "cycleCombinerConfig": {...},
    "transitZoneGroups": [...]
  }
}
```

Only `schemaVersion`, `name`, and `payload` are required. All payload fields
are optional — a template can describe just overlays, just indicators, etc.

## Notes

- Templates do NOT bind to a specific symbol — they re-apply on top of
  whatever series the user has currently loaded.
- Overlay `anchorTimestamp` fields are absolute. A template saved today
  with "today" anchors will still point at today's date next month;
  users may need to re-anchor overlays after apply.
- Seeding is idempotent: once a template URL has been seeded, the browser
  won't re-import it on subsequent boots. Delete the "seeded" setting in
  DevTools to force a re-seed.
