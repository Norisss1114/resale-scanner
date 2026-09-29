# Resale Scanner V2.4

Cloudflare Workers上で動く、店頭商品とオンラインDealのeBay転売リサーチアプリです。

## Workflows

- **Product Scan**: 写真またはバーコードから商品を特定し、eBay Sold / Active、利益、ROI、Sell-through、BUY / MAYBE / SKIPを計算
- **Deal Scan**: Walmart / Target / Home DepotのLive Provider、または明示的に選んだMock ProviderからDealを取得し、同じMarket / Profit Engineで分析
- **Watchlist**: DealをlocalStorageへ保存し、将来のprice drop、ROI、profit、availability通知条件を保持

V2.3の`POST /api/analyze`契約とProduct Scanを維持しています。

## Live Deal Providers

各retailerは独立したProviderです。1社の失敗は他社の取得・表示を停止しません。

| Provider | 取得方式 | V2.4での状態 |
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
  source, sourceType, providerStatus, fetchedAt
}
```

取得元に存在しない値は`null`または`unknown`です。

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

## Cloudflare Settings

V2.4で追加Variable / Secretはありません。

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
- location-specific price / inventory、ZIP radius、店舗別在庫はV2.4対象外です

## Validation

```bash
node --check worker.js
node --check public/app.js
npm test
git diff --check
npx wrangler deploy --dry-run
```

## V2.5 Direction

Providerごとにlocation / ZIP入力、店舗別availability、価格差を追加できる境界はあります。ただし各retailerが公開・許可する取得方式の確認が必要です。
