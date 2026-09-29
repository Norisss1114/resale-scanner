# Resale Scanner V2.3

Cloudflare Workers上で動く、店頭商品とオンラインDealのeBay転売リサーチアプリです。

## 3つのワークフロー

### Product Scan

商品写真またはバーコード写真をOpenAI Visionで特定し、eBay Sold / Active Listings、利益、ROI、Sell-through、BUY / MAYBE / SKIPを計算します。V2.2の `/api/analyze` 契約を維持しています。

### Deal Scan

V2.3では6商品のMock Deal Providerを使い、Walmart、Target、Home Depotの商品を同じeBay分析エンジンへ送ります。

```text
Deal Provider
  -> Normalized Deal
  -> Normalized Product
  -> Shared eBay Market / Profit Engine
  -> Deal Score + BUY / MAYBE / SKIP
```

`POST /api/deals/scan` はSold / Activeを商品ごとに並列取得します。商品間の同時実行数は制限され、`Promise.allSettled` により1商品の失敗でスキャン全体を停止しません。

初期フィルター:

- Minimum Profit: `$25`
- Minimum ROI: `40%`
- Minimum Discount: `0%`

### Watchlist

Deal cardから追加・削除できます。V2.3ではブラウザの`localStorage`を使用します。保存データには、将来のprice drop、maximum price、minimum ROI、minimum profit、availability通知用の`alertRules`を含みます。

## 共通Market / Profit Engine

Product ScanとDeal Scanは、`worker.js`の同じ処理を共有します。

- eBay Sold / Active取得
- UPC、ブランド、型番、サイズ、色による商品一致判定
- 7 / 30 / 90日Sold
- 送料込み価格統計
- Sell-through
- eBay fee / shipping / net profit / ROI
- BUY / MAYBE / SKIP

eBay Providerを変更する場合は`EbaySoldListingsProvider`を差し替えることで、両方のScanへ反映できます。

## Deal Provider architecture

Deal Providerは`listDeals()`でretailer固有データを取得し、共通Deal形式へnormalizeします。現在は`MockDealProvider`のみです。

主な共通フィールド:

```js
{
  id, retailer, title, brand, model, upc, sku,
  regularPrice, salePrice, discountPercent,
  imageUrl, productUrl, fulfillment, availability,
  locationText, source
}
```

V2.4では同じ境界へ`WalmartProvider`、`TargetProvider`、`HomeDepotProvider`を追加できます。

## Deal Score

Deal Scoreは[`lib/deal-utils.mjs`](lib/deal-utils.mjs)の純粋関数で0〜100へclampします。ウェイトは独立した定数で変更できます。

| Component | Weight |
|---|---:|
| Estimated Profit | 30% |
| ROI | 20% |
| 90-day Sold / Demand | 20% |
| Sell-through | 15% |
| Discount | 10% |
| Competition / Active | 5% |

- 80〜100: Strong opportunity
- 65〜79: Good
- 50〜64: Maybe
- 0〜49: Weak

Deal Scoreとは別にBUY / MAYBE / SKIPを計算します。割引率だけでBUYにはなりません。

## Cloudflare設定

V2.3で追加Secretはありません。

| 名前 | 種別 | 値 |
|---|---|---|
| `OPENAI_API_KEY` | Secret | OpenAI API key |
| `EBAY_SOLD_API_URL` | Variable | `https://api.ebaysoldlistingsapi.com/scrape` |
| `EBAY_SOLD_API_KEY` | Secret | eBay Sold Listings API key |

eBay Developer Programのアカウント、Client ID、Client Secretは不要です。

## エラー状態

UIとAPIは、Deals 0件、Sold 0件、Active 0件、Deal Provider failure、eBay Provider failure、Analysis failureを区別します。API失敗を0件や`$0`へ変換しません。

## Validation

```bash
node --check worker.js
node --check public/app.js
node --test test/deal-utils.test.mjs
git diff --check
npx wrangler deploy --dry-run
```

## Future retailer integrations

Walmart / Target / Home Depotのlive API、店舗・ZIP検索、通知、Cron、D1、LoginはV2.3の対象外です。Provider境界、normalized Deal、Watchlist alert rules、制限付き並列実行は、これらを後付けできる構造になっています。
