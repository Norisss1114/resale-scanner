# Resale Scanner V2.5

Cloudflare Workers上で動く、店頭商品とオンラインDealのeBay転売リサーチアプリです。

## Workflows

- **Product Scan**: 写真またはバーコードから商品を特定し、eBay Sold / Active、利益、ROI、Sell-through、BUY / MAYBE / SKIPを計算
- **Deal Scan**: Walmart / Target / Home DepotのLive Provider、または明示的に選んだMock ProviderからDealを取得し、同じMarket / Profit Engineで分析
- **Local Deal**: ZIP / radiusから近隣店舗を検索し、距離・pickup confidence・Local Scoreで仕入れやすさを補助評価
- **Watchlist**: DealをlocalStorageへ保存し、将来のprice drop、ROI、profit、availability通知条件を保持

既存の`POST /api/analyze`契約、Product Scan、Deal Scan、Watchlistを維持しています。

## Live Deal Providers

各retailerは独立したProviderです。1社の失敗は他社の取得・表示を停止しません。

| Provider | 取得方式 | V2.5での状態 |
|---|---|---|
| `WalmartDealProvider` | Walmart公式Clearance公開HTMLの`__NEXT_DATA__` | Live動作確認済み |
| `TargetDealProvider` | Target公式Clearance公開HTMLのJSON-LDのみ | 現在`unavailable` |
| `HomeDepotDealProvider` | Home Depot公式Daily Deals公開HTMLの`window.__APOLLO_STATE__` | Live動作確認済み |
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
- 429 / 5xxは指数backoff付きで最大3回
- retailer結果はWorker isolate内で10分キャッシュ
- 同一scan内の重複Dealを除外
- eBay検索はリクエスト内でdeduplicate
- 過剰アクセスとeBay API消費を抑えるため、1 retailerあたり最大6 Dealを分析

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

V2.5で追加Variable / Secretはありません。ZIP geocodingとStore Locatorは公開ソースを使用します。

| Name | Type | Value |
|---|---|---|
| `OPENAI_API_KEY` | Secret | OpenAI API key |
| `EBAY_SOLD_API_URL` | Variable | `https://api.ebaysoldlistingsapi.com/scrape` |
| `EBAY_SOLD_API_KEY` | Secret | eBay Sold Listings API key |

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
