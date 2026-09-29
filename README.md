# Resale Scanner V2.2

店頭で商品写真またはバーコード写真を1枚アップロードし、仕入れ価格を入力して、自動でeBay転売判断を出すCloudflare Workersアプリです。

## V2.2の主な変更

- eBay公式Browse API、OAuth、アクセストークンキャッシュを削除
- Sold / Active Listingsの両方を[eBay Sold Listings API](https://ebaysoldlistingsapi.com/docs)から取得
- SoldとActiveを並列取得し、Providerのレート制限時は短く再試行
- API失敗と0件を明確に区別
- AIが特定したUPC、ブランド、型番、サイズ、色を使って別商品を可能な範囲で除外
- Sold中央値、Sell-through、販売ペース、利益、ROI、BUY / MAYBE / SKIPを自動計算

eBay Developer Programのアカウント、Production API access、Client ID、Client Secretは不要です。

## 必要なCloudflare設定

必要なRuntime Secrets / Variablesは次の3つだけです。

| 名前 | 必須 | 推奨設定 | 値 |
|---|---:|---|---|
| `OPENAI_API_KEY` | 必須 | Secret | OpenAI API key |
| `EBAY_SOLD_API_URL` | 必須 | Variable | `https://api.ebaysoldlistingsapi.com/scrape` |
| `EBAY_SOLD_API_KEY` | 必須 | Secret | eBay Sold Listings API dashboardで発行したkey |

CLIで設定する場合:

```bash
wrangler secret put OPENAI_API_KEY
wrangler secret put EBAY_SOLD_API_KEY
```

`EBAY_SOLD_API_URL` はCloudflare DashboardのWorker設定でVariableとして登録するか、Secretとして登録できます。

```bash
wrangler secret put EBAY_SOLD_API_URL
```

`EBAY_CLIENT_ID`、`EBAY_CLIENT_SECRET`、`EBAY_SOLD_API_KEY_HEADER`は使用しません。

## Listings Provider

Workerは同じ `GET EBAY_SOLD_API_URL` エンドポイントへBearer認証で2リクエストを並列送信します。

Sold Listings:

```text
?keyword=検索語&sold=true&count=240&itemCondition=any
```

Active Listings:

```text
?keyword=検索語&sold=false&count=240&itemCondition=any
```

商品の状態がAI解析で判別できた場合、`itemCondition` は `new` または `used` になります。Providerレスポンスの `results` 配列を読み、`soldPrice`、`shippingPrice`、`totalPrice`、`endedAt` などを正規化します。

## 集計と判定

Sold Listingsから以下を計算します。

- 7日 / 30日 / 90日Sold
- 平均、中央値、最低、最高
- 30日 / 90日の平均販売ペース

Active Listingsから以下を計算します。

- Active件数
- 送料込み価格の平均、中央値、最低、最高

Sell-throughは `90日Sold ÷ Active × 100` です。想定販売価格はSold中央値を優先し、Soldが不足するとActive中央値を補助的に使います。

Providerが正常に空の `results` を返した場合は0件として扱います。HTTPエラー、タイムアウト、不正なレスポンスの場合は取得失敗として扱い、0件や$0には変換しません。

## セキュリティ

- API keyはCloudflare Runtime Secretからのみ読み込み
- API keyをレスポンス、ログ、フロントエンドに含めない
- 画像MIMEをJPEG / PNG / WebP / HEICに制限
- 画像サイズは7MB以下
- 外部APIにタイムアウトを設定
- CORS preflightに対応

## ローカル確認とデプロイ

```bash
node --check worker.js
node --check public/app.js
npx wrangler deploy --dry-run
npx wrangler deploy
```
