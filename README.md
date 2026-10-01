# Resale Scanner V2.6.5

## Product Scan UX and Billing Quota

Camera and photo-library inputs share one preview, Replace/Remove controls and
the unchanged `productImage` API field. Native browser decoding converts supported
JPEG/PNG/WebP/HEIC/HEIF images to JPEG (quality 0.85, maximum dimension 2048).
Unsupported HEIC produces an explicit conversion message; no heavy codec or
photo-library-wide permission is requested. Physical iOS/Android verification remains pending.

Max Buy Price distinguishes `VALUE`, `TARGET_IMPOSSIBLE` and `INSUFFICIENT_DATA`.
Estimated sale price explains the market weighting and buyer-shipping subtraction.
Risk details report actual decision reasons rather than invented explanations.

Apply **0005_provider_quota.sql before deploying V2.6.5**. HTTP 402 latches a shared
D1 quota stop with zero remaining; 429 is a separate cooldown. No automatic retries.
Billing quota defaults to 3000, daily quota to 80. Set the ordinary Variable
`EBAY_PROVIDER_QUOTA_RESET_AT` to the provider's actual next billing reset timestamp
(ISO 8601 with timezone); never guess it or use calendar-month rollover.
Until configured, usage accumulates without automatic reset. At the configured
date, requests stop until the operator confirms renewal and advances the date.
Editing a still-future reset date does not refund usage or clear a 402 stop.

Cycle admission uses nested shared thresholds: Scheduled up to 15%, Manual plus
Scheduled up to 40%, Product up to 100%. Thus at least 60% is reserved for Product;
these are not independent guaranteed allocations. Daily/minute thresholds below
also apply. Cached reads do not consume new provider requests.

Counters measure this app's reservations, not the provider dashboard or other
clients. On rollout, seed `provider_usage.quota_count` from actual billing-period
usage before enabling scans. After an independently confirmed billing reset, an
operator can reconcile `quota_count`, `quota_epoch` (next reset in canonical UTC)
and `quota_exhausted` using authenticated D1 tooling. Do not clear the stop merely
because a request failed. No public reset endpoint is provided.

See [V2.6.5 validation and rollout notes](docs/V2.6.5-validation.md).

## Provider Expansion & Retailer Recovery

Public HTML only: no private APIs, fixed cookies, challenge solving or bot bypass.
Local server-side observations on 2026-09-30 are **not Cloudflare edge verification**.

| Provider | Local result | Parsers / adoption |
| --- | --- | --- |
| Walmart | HTTP 200; 48-51 validated products across two captures | Next data, embedded JSON, HTML cards, JSON-LD; environment-sensitive |
| Target | HTTP 200; zero product cards/prices in response | Embedded JSON, HTML cards, JSON-LD implemented; still unavailable live |
| Home Depot | HTTP 200; 4 deals | Existing public Apollo-state parser retained |
| Kohl's | HTTP 403 | Provider registered with tested adapters; provisional, NOT certified live |

Future research: Best Buy (timeout), Lowe's/Macy's/CVS (403), Menards/Costco/
Sam's Club (200, product extraction unvalidated), Walgreens (weekly ad 200;
legacy sale URL 500). No future candidates are automatically enabled.
See [research, limitations and deployment checklist](docs/V2.6.4-provider-expansion.md).

Manual and Scheduled scans globally rank eligible candidates with a descriptive
PreScore, at most eight analyses and four per retailer. Remaining daily AND minute
quota and cooldown can lower those limits. Clearance evidence can qualify without
a reference price; discount remains null. Store inventory is never inferred.
Retailer filters/capabilities are rendered from the response registry, not a fixed
three-store list. Retailer health is isolate-local; scheduled health summaries
persist in existing scan_runs.provider_summary. V2.6.4 added no migration; V2.6.5
requires migration 0005. No additional Secrets are required.

Install dependencies with `npm ci` before tests or deployment (htmlparser2 is used
for bounded HTML parsing). Reproduce public-source research with
`node scripts/research-retailers.mjs /tmp/research.json`.

## Production Stabilization

The eBay transport serializes requests within each Worker isolate and spaces calls by 1.2 seconds. Every cache miss must atomically reserve a request in D1 before contacting the provider. All Product, Manual and Scheduled scans share this budget; missing D1/migrations fail closed. Defaults: 80 requests per UTC day and 20 per fixed UTC minute. `EBAY_PROVIDER_DAILY_REQUEST_LIMIT` and `EBAY_PROVIDER_MINUTE_REQUEST_LIMIT` are ordinary Variables. Limits include failures; reservations are not refunded after crashes. Fixed-minute windows can allow a boundary burst, so this is not a rolling-minute or globally serial queue.

Scheduled scans can consume only the first 50% of each budget, Manual Deal scans 75%, and Product scans 100%. This reserves capacity, rather than preempting in-flight requests. Manual/Scheduled analysis is limited to half the remaining daily/minute request capacity, at most eight candidates, ranked by PreScore with a four-per-retailer cap. Fresh cached responses do not consume quota. Deal Scan conservatively defers all candidate analysis during cooldown; Product requests can still use fresh cache.

Within an isolate, queued Product requests are selected before Manual and Scheduled requests. Cross-isolate priority is provided by the reserved quotas; in-flight work is not preempted. Budget-deferred scheduled runs are `partial`, or `skipped` if nothing is analyzed.

Raw responses are cached for five minutes in D1 using a SHA-256 key over credentials and the complete URL, with an additional bounded isolate cache (64 entries). Credential values are not stored in D1. Concurrent cache misses on different isolates can each reserve a call; the global hard cap still applies. HTTP 429 honors numeric or HTTP-date Retry-After with a minimum 60-second shared cooldown. Three consecutive failures open a 30-second shared circuit. Automatic retries are disabled.

`providerHealth` and authenticated `GET /api/provider/health` expose D1 counters for requests, successes, failures, 429, 5xx, latency, cache hits and circuit openings, plus budget remaining and cooldown. Counters are lifetime totals; daily/minute counts reset on the next reservation. Mean latency can be computed as latency_ms / completed attempts.

All `/api/*` endpoints require a signed 12-hour HttpOnly, Secure, SameSite=Strict cookie. Unlock on mobile using a personal passphrase. Set `APP_ACCESS_PASSWORD` as a Secret (20-256 characters, random and unique); it is never embedded in the frontend, localStorage, logs or D1. Missing configuration disables the API. Password rotation invalidates all sessions. Login attempts are globally limited to five per 15 minutes; authenticated POSTs to 20/minute; OpenAI analyses to 20/UTC day. POSTs require an exact same-origin Origin header. Global login limiting can cause temporary lockout under attack; this individual-use tradeoff avoids an account system. Use HTTPS in production.

### Deploy order

Use Node 24+ for local tests (the SQLite migration/integration tests use `node:sqlite`).

```sh
npm run check
npx wrangler d1 migrations apply DB --local
npx wrangler deploy --dry-run
git diff --check
# After Cloudflare authentication is available:
npx wrangler secret put APP_ACCESS_PASSWORD
npx wrangler d1 migrations apply DB --remote
npx wrangler deploy
```

Existing Secrets remain `OPENAI_API_KEY`, `EBAY_SOLD_API_KEY`; `EBAY_SOLD_API_URL` is a Variable. No eBay Developer account or Browse API credentials are needed. Migration `0003_provider_budget_and_health.sql` adds quota/cache/access-limit tables and nullable snapshot quality columns without deleting historical data. Apply migrations before deploying; never put a passphrase into wrangler.toml or a commit. `.dev.vars` and `.wrangler/` are ignored.

Match Confidence now reflects listing evidence (weakest accepted method), not the presence of an input UPC. Exact requires the listing's structured identifier; title digits alone do not qualify. Evidence is available in Product and Deal details. Market Confidence is separate from Deal Score and considers recent dated sold samples, active samples, actual matching, provider success, sample cap, freshness (15 minutes) and price dispersion. Capped, stale or Low-confidence markets cannot generate BUY/Strong. Counts and sell-through are sampled, not population totals. Stored opportunities age out of Strong even without another scan. Notifications remain unimplemented.

Product Scan now suppresses profit/ROI when either market source fails or lacks matches. Historical opportunities without a calculable profit status require reanalysis and display N/A. Walmart supports public Product JSON-LD as a fallback, but only explicit former-price evidence can produce a deal; AggregateOffer.highPrice is not a former price. Live recovery requires verification against current public pages.

Cloudflare Workers上で動く、店頭商品とオンラインDealのeBay転売リサーチアプリです。

## Workflows

- **Product Scan**: 写真またはバーコードから商品を特定し、eBay Sold / Active、利益、ROI、Sell-through、BUY / MAYBE / SKIPを計算
- **Deal Scan**: Walmart / Target / Home Depot / Kohl'sの公開Provider、または明示的に選んだMock ProviderからDealを取得し、同じMarket / Profit Engineで分析。取得不能な店はunavailableのまま表示
- **Local Deal**: ZIP / radiusから近隣店舗を検索し、距離・pickup confidence・Local Scoreで仕入れやすさを補助評価
- **Watchlist**: DealをlocalStorageへ保存し、将来のprice drop、ROI、profit、availability通知条件を保持
- **Automated Deal Monitoring**: Cloudflare CronからShared Deal Scan Serviceを毎日実行し、D1 snapshotとの差分を保存
- **Today's Opportunities / Scan History**: New、Price Drop、Became BUY、Strongなどのイベントと直近20 runを表示

既存の`POST /api/analyze`契約、Product Scan、Deal Scan、Watchlistを維持しています。

## Live Deal Providers

各retailerは独立したProviderです。1社の失敗は他社の取得・表示を停止しません。

| Provider | 取得方式 | V2.6.4ローカル取得結果（Cloudflare未検証） |
|---|---|---|
| `WalmartDealProvider` | Next data / embedded JSON / HTML cards / JSON-LD | HTTP 200、48-51件 |
| `TargetDealProvider` | embedded JSON / HTML cards / JSON-LD | HTTP 200、商品データなし、unavailable |
| `HomeDepotDealProvider` | Home Depot公式Daily Deals公開HTMLの`window.__APOLLO_STATE__` | HTTP 200、4件 |
| `KohlsDealProvider` | embedded JSON / HTML cards / JSON-LD | HTTP 403、暫定対応、unavailable |
| `MockDealProvider` | Worker内の6件の固定データ | Mock選択時のみ |

Walmart Marketplace Item Search APIはSeller / approved Solution Provider向けOAuthとseller catalog workflowを前提にしており、一般Clearance一覧用途には使用していません。

Targetの公開URLはHTTP 200を返しますが、未ログインのサーバー側取得では商品一覧がHTMLやJSON-LDへ含まれません。非公開endpoint、session cookie、CAPTCHA回避は使わず、Provider statusを`unavailable`として返します。

Live Provider失敗時にMockへ自動フォールバックしません。MockはUIで`Mock`を選択した場合だけ表示します。

## Normalized Deal

全Providerは次の共通形式へ変換されます。

```js
{
  id, retailer, title, brand, model, upc, gtin, sku,
  regularPrice, salePrice, discountPercent,
  imageUrl, productUrl,
  fulfillment, availability, locationText,
  purchasePopularity, dealType,
  source, sourceType, providerStatus, fetchedAt,
  storeId, storeName, storeDistanceMiles, withinRadius,
  availabilityType, localAvailabilityStatus,
  pickupAvailable, shippingAvailable, inventoryCount
}
```

取得元に存在しない値は`null`または`unknown`です。

## ZIP and Store Providers

Deal Scan SettingsのZIP Codeと5 / 10 / 15 / 25 / 50 miles radiusは`localStorage`へ保存されます。ZIP未設定でもonline Deal Scanは通常どおり動き、`Location not set`を表示します。

| Provider | 公開ソース | Cache | 現在の制限 |
|---|---|---:|---|
| `LocationProvider` | Zippopotam.us / GeoNames | 24時間 | ZIP centroid。正確な住所は扱いません |
| `WalmartStoreProvider` | Walmart公式Store Finder HTML | 1時間 | 検索結果が公開HTMLにない場合`unavailable` |
| `TargetStoreProvider` | Target公式Store Locator HTML | 1時間 | 店舗名・住所・番号を取得。座標は店舗ZIP centroid |
| `HomeDepotStoreProvider` | Home Depot公式Store Locator HTML | 1時間 | 403または公開結果なしの場合`unavailable` |

各Store Providerは独立しており、店舗検索やZIP解決の失敗はonline Deal取得とeBay分析を停止しません。距離はbackendのHaversine純粋関数で計算し、指定半径内の最大10店舗を表示します。

## Automated Deal Monitoring

`worker.js`の`runDealScanService()`をManual Deal Scanと`scheduled()`が共有します。CronがHTTP経由でWorker自身を呼ぶことはありません。両方が同じ4店舗registryを使用し、候補のglobal PreScoreと共有API予算で分析件数を制限します。

初期Cronは毎日`12:00 UTC`です。Chicagoでは夏時間・標準時間により午前6時または7時前後になります。実行結果はD1へ次の3テーブルで保存します。

- `scan_runs`: trigger、status、件数、provider summary
- `deal_snapshots`: 価格、市場、Deal / Local Score、decision、location状態
- `deal_events`: snapshot差分イベント

Manual Deal Scanは同じScan Serviceを利用しますが、snapshot保存はScheduled Scanのみです。現在はAPI予算・認証制限のためD1とmigrationが必須です。D1未設定で有料API分析を開始しません。

## Deal Events

安定した`deal_key`はUPC / GTIN、retailer + SKU、正規化URL、retailer + brand + model、retailer + titleの順で生成します。直前のcompleted / partial snapshotと比較し、次を検出します。

- `new_deal` / `returned`
- `price_drop`: $5以上または5%以上
- `profit_increase`: $10以上
- `score_increase`: Deal Score 10以上
- `became_buy` / `became_strong`
- `availability_improved`

同じrun / deal / eventの重複はD1 UNIQUE制約とapplication dedupeの両方で防止します。通知はまだ送信しませんが、Became BUY、New Strong、Price Drop + BUYを`notificationEligible`として返します。

Today's OpportunitiesはBecame BUY、Strong + Price Drop、New Strong、Price Drop、Profit Increase、Score Increaseの順で表示し、同順位ではDeal Score、Profit、Local Scoreを比較します。新しいsnapshotはprofit / market / match診断を保存し、`PROFITABLE`以外はStrong判定とPotential Profitから除外します。V2.6の既存行は変更せず読み込めます。

## Availability Confidence

- `confirmed`: retailer公式公開情報が商品と特定店舗のpickupを明示した場合のみ
- `likely`: 一般的なpickup情報はあるが、特定店舗の商品在庫までは確認できない
- `unknown`: 判断材料なし
- `unavailable`: Store Provider自体が取得不能

V2.5の一覧Providerは商品別・店舗別在庫を公開情報から確認できないため、通常は`likely`以下です。未確認の商品を`In Stock`とは表示しません。`inventoryCount`は常に実データのみを許可し、現在のProviderでは`null`です。

## Provider Status

- `ok`: Dealを正常取得
- `empty`: Providerは正常だがDealが0件
- `partial`: 一部データのみ利用可能
- `unavailable`: 公開・対応可能なデータ構造がない
- `error`: HTTP、timeout、parseなどの取得失敗

0件と取得失敗は別状態です。

## Matching Confidence

eBay照合は次の優先順位です。

1. UPC / GTIN exact identifier
2. brand + model
3. brand + title
4. title

Deal cardには`Exact identifier`、`High`、`Medium`、`Low`を表示します。Lowは`Verify match`警告となり、利益・需要条件を満たしてもBUYではなくMAYBEへ抑制されます。

## Profit and Market Diagnostics

Deal Scanは`$0.00`をデータ不足のfallbackにしません。計算不能なprofit / ROIは`null`で返し、UIでは`N/A`と表示します。計算結果が本当にゼロの場合だけ`$0.00` / `0%`です。

`profitStatus`は`PROFITABLE`、`UNPROFITABLE`、`NO_SOLD_DATA`、`NO_ACTIVE_DATA`、`NO_MARKET_DATA`、`LOW_MATCH_CONFIDENCE`、`PROVIDER_ERROR`、`INSUFFICIENT_PRICE_DATA`、`ANALYSIS_ERROR`です。

`marketDataStatus`は`COMPLETE`、`SOLD_ONLY`、`ACTIVE_ONLY`、`NO_MATCHES`、`PARTIAL`、`PROVIDER_ERROR`です。主判定のBUY / MAYBE / SKIPは維持し、データ不足時は`NO DATA`、`NO MATCH`、`API ERROR`などの補助badgeと短い`profitReason`を表示します。Deal cardのDetailsでは検索query、match method、Sold / Active一致件数、provider statusを確認できます。

## Improved eBay Matching

検索順はUPC / GTIN exact、brand + exact model、brand + SKU / MPN、brand + normalized title、high-value title tokensです。Free shipping、Best seller、New、Bundle、Includes、Premium、Heavy duty、Limited editionなどのmarketing語を除去し、model、size、pack countは保持します。

`matchMethod`は`upc_exact`、`brand_model`、`brand_sku`、`brand_title`、`title_tokens`、`fallback_keywords`です。listing filterはbrand、model、size、pack count、key title tokensを比較し、Fire TV StickのMax / LiteやRing Floodlight CamのPlus / Proなどのvariant違いを除外します。

## Shared Market / Profit Engine

Product ScanとDeal Scanは`worker.js`の同じeBay Provider、商品一致、価格統計、Sell-through、fee、shipping、profit、ROI計算を共有します。retailer側にeBayロジックはありません。

## Deal Score

V2.3のweightsを維持しています。

| Component | Weight |
|---|---:|
| Estimated Profit | 30% |
| ROI | 20% |
| 90-day Sold / Demand | 20% |
| Sell-through | 15% |
| Discount | 10% |
| Competition / Active | 5% |

Scoreは0〜100へclampします。割引率だけでBUYにはなりません。

## Local Score and Nearby Sort

Local ScoreはDeal Scoreと分離した0〜100の補助指標です。距離45%、pickup indication 25%、availability confidence 30%で構成します。`Best Nearby Deal`はBUY / MAYBE / SKIP、既存Deal Score、Local Score、距離の順を明示的に比較し、既存Deal Score自体は変更しません。

## Rate Limit and Cache

- retailer Providerは並列取得し、商品分析は制限付きconcurrency
- retailer HTTP timeoutは15秒
- 403 / 429 / challengeは再試行しない。その他の取得失敗は最大1回再試行
- retailer成功結果はWorker isolate内で10分、失敗・unavailableは1分キャッシュ
- 同一scan内の重複Dealを除外
- eBay検索はリクエスト内でdeduplicate
- 1 retailerから最大40候補を保持し、分析は1 retailer最大4件・全店最大8件
- Scheduled Scanはdiscount 30%以上または明示的clearanceを抽出し、PreScore順・concurrency 1で分析
- 日次・分次予算やcooldownによりさらに件数を減らす。4店舗とも取得失敗を独立処理

## Filtering

- Minimum Profit / ROI / Discount
- Sort By
- Retailer
- Source Type
- BUY / MAYBE / SKIP
- In Stock only
- Within radius only
- Pickup available only
- Confirmed availability only

## Cloudflare Settings

V2.5までのZIP geocodingとStore Locatorには追加Variable / Secretはありません。

| Name | Type | Value |
|---|---|---|
| `OPENAI_API_KEY` | Secret | OpenAI API key |
| `EBAY_SOLD_API_URL` | Variable | `https://api.ebaysoldlistingsapi.com/scrape` |
| `EBAY_SOLD_API_KEY` | Secret | eBay Sold Listings API key |

V2.6 Automated Monitoringでは次を追加します。

| Name | Type | Example |
|---|---|---|
| `DB` | D1 binding | `resale-scanner-monitoring` |
| `SCAN_ZIP_CODE` | Variable | `60409` |
| `SCAN_RADIUS_MILES` | Variable | `15` |
| `APP_ACCESS_PASSWORD` | Secret | Personal random passphrase, 20-256 characters |
| `EBAY_PROVIDER_DAILY_REQUEST_LIMIT` | Variable | `80` |
| `EBAY_PROVIDER_QUOTA_LIMIT` | Variable | `3000` |
| `EBAY_PROVIDER_QUOTA_RESET_AT` | Variable | Actual next billing reset, ISO 8601 with timezone |
| `EBAY_PROVIDER_MINUTE_REQUEST_LIMIT` | Variable | `20` |

```bash
npx wrangler d1 migrations apply resale-scanner-monitoring --remote
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put EBAY_SOLD_API_KEY
npx wrangler secret put APP_ACCESS_PASSWORD
npx wrangler deploy
```

Production D1 bindingとdatabase IDは`wrangler.toml`へ設定済みです。`SCAN_ZIP_CODE`未設定でもScheduled Scanは継続し、Local Scoreはlocationなしとして扱います。

## Retention

Scheduled Scan完了後、90日より古いevents、snapshots、scan runsを順に削除します。cleanup helperはD1未設定時にno-opです。

## Data Limitations

- 公開ページのHTML構造変更でProvider parserの更新が必要になる場合があります
- Walmartの公開Clearance一覧にはUPC / GTINが通常含まれず、brand / title照合になる商品があります
- Home Depot一覧にはUPC / GTINがなく、availabilityが`unknown`になる商品があります
- Targetは現在live商品データを取得できません
- Target店舗距離は公開店舗住所のZIP centroidによる近似で、入口までの道路距離ではありません
- Walmart / Home DepotのStore Locatorが公開HTMLを返さない場合は`Store lookup unavailable`になります
- location-specific price、商品別pickup、店舗別在庫数は確認できない限り表示しません
- 非公開API、固定session cookie、CAPTCHA / bot protection回避、Walmart Marketplace Inventory APIは使用しません

## Validation

```bash
node --check worker.js
node --check public/app.js
npm test
git diff --check
npx wrangler deploy --dry-run
```

D1 migrationsは`0001_automated_deal_monitoring.sql`と`0002_profit_diagnostics.sql`です。`0002`は既存snapshotを維持したままnullable診断列とindexを追加します。
# V2.6.3 Decision Intelligence

Shared Product/Deal purchase decisions now include Max Buy Price, break-even and
required sale prices, qualitative risk, and explicit decision reasons. Provider
request volume is unchanged. Apply migration `0004_decision_intelligence.sql`
before deployment. No new secrets are required. See
[design, formulas, limitations and deployment checklist](docs/V2.6.3-decision-intelligence.md).
