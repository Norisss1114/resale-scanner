# Resale Scanner V2.1

店頭で商品写真またはバーコード写真を1枚アップロードし、仕入れ価格を入力して、自動でeBay転売判断を出すCloudflare Workersアプリです。

## V2.1の主な変更

- Cloudflare Browser RunによるeBayスクレイピングを廃止
- Active ListingsをeBay公式Browse APIに切り替え
- Sold Listingsを差し替え可能な外部Provider方式に変更
- API失敗と0件を明確に区別
- Sold中央値を優先した想定販売価格、Sell-through、販売ペース、利益、ROI、BUY / MAYBE / SKIPを自動計算
- モバイル店頭利用向けUIに更新

## 必要なCloudflare Secrets

Cloudflare WorkersのRuntime Secretとして設定してください。コードやフロントエンドへキーは出しません。

```bash
wrangler secret put OPENAI_API_KEY
wrangler secret put EBAY_CLIENT_ID
wrangler secret put EBAY_CLIENT_SECRET
wrangler secret put EBAY_SOLD_API_KEY
```

任意設定:

```bash
wrangler secret put EBAY_SOLD_API_URL
wrangler secret put EBAY_SOLD_API_KEY_HEADER
```

`EBAY_SOLD_API_URL` と `EBAY_SOLD_API_KEY` が未設定の場合、Soldは「取得失敗/未設定」と表示され、0 Soldとしては扱いません。

## eBay Browse API

Active ListingsはeBay Browse APIの `item_summary/search` を使います。

必要なもの:

- eBay Developer Programのアプリ
- Production Client ID
- Production Client Secret
- App access token用のOAuth Client Credentials Grant

Workerは `EBAY_CLIENT_ID` と `EBAY_CLIENT_SECRET` からサーバー側でApp access tokenを取得し、期限までメモリキャッシュします。トークンやSecretはレスポンス、ログ、フロントエンドに出しません。

## Sold Provider

Sold Listingsはサービス固定にせず、`HttpSoldProvider` に分離しています。Providerは以下のPOST JSONを受け取れる想定です。

```json
{
  "query": "Ozark Trail OT PRO AM 24 Navy Adult",
  "queries": [
    { "type": "model", "value": "Ozark Trail OT PRO AM 24 Navy Adult" }
  ],
  "upc": null,
  "gtin": null,
  "mpn": "OT PRO AM 24",
  "brand": "Ozark Trail",
  "productName": "A/M 24 Automatic/Manual Inflatable Life Jacket",
  "size": "Adult",
  "color": "Navy",
  "days": 90
}
```

Providerレスポンスは `listings` または `results` 配列を返してください。

```json
{
  "source": "External Sold Provider",
  "total": 12,
  "listings": [
    {
      "title": "Ozark Trail A/M 24 Automatic Manual Inflatable Life Jacket Navy Adult",
      "soldPrice": 58.0,
      "shipping": 8.25,
      "soldDate": "2026-09-10",
      "condition": "New",
      "itemId": "1234567890",
      "bestOffer": false,
      "url": "https://www.ebay.com/itm/1234567890"
    }
  ]
}
```

Best Offerは実売価格が表示価格と異なる可能性があるため、UIに警告を表示します。

## 判定ロジック

BUY / MAYBE / SKIPは以下を使うルールベースです。

- Net Profit
- ROI
- Sell-through = 90日Sold ÷ Active × 100
- 30日Sold / 90日Sold
- Active競合数
- Product match confidence
- Shipping difficulty

想定販売価格はSold中央値を最優先し、Soldが不足するとActive中央値を補助的に使います。その場合は推定精度が低いと表示します。

## セキュリティとエラー処理

- APIキーはRuntime Secretからのみ読み込み
- APIキーをレスポンスやログに含めない
- 画像MIMEをJPEG / PNG / WebP / HEICに制限
- 画像サイズは7MB以下
- 外部APIにはタイムアウトを設定
- API取得失敗を0件や$0として扱わない
- CORS preflightに対応

## デプロイ

```bash
wrangler deploy
```

`wrangler.toml` からBrowser bindingは削除済みです。
