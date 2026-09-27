# Model import fixtures

Saved site answers for the tests (no live network in tests).

- `printables-3161.json`, `printables-500000.json`: answers of the public Printables GraphQL API
  (`https://api.printables.com/graphql/`) to the `PrintProfile` query in `sites/printables.ts`, saved on
  2026-09-27. Model 3161 is 3DBenchy (CC0); 500000 is a CC BY-NC-SA model. Text belongs to the designers,
  kept here unchanged only as test data.
- `thingiverse-763622-*.json`: Thingiverse REST API answers (`/things/763622`, `/files`, `/images`) built
  from the example values in the API's schemas (github.com/nomike/thingiverse-client
  `openapi/schemas/thing_schema.yaml`, `file_schema.yaml`, `image_summary_schema.yaml`), since the API
  needs an app token. The second image on another host checks that it is dropped.
- `makerworld-page.html`: a synthetic MakerWorld page shaped like the real one (`__NEXT_DATA__` at
  `props.pageProps.design`, as read by github.com/fishpen0/manyfold-importer
  `content-scripts/makerworld.js`). MakerWorld shows servers a bot check, so a real page could not be
  saved here. Names and ids are made up; the tracker picture checks that other hosts are dropped.
- `makerworld-og.html`: a page with Open Graph tags only (the fallback path).
