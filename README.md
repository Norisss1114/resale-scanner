# Resale Scanner V2

商品写真またはバーコード写真を1枚入れるだけで、商品をAI特定し、Cloudflare Browser RunでeBayのSold/Active検索ページを自動取得して、販売速度・相場・利益を推定します。

## V2で自動化されるもの
- 商品名 / ブランド / 型番 / UPC候補の特定
- eBay Sold検索
- eBay Active検索
- 直近7/30/90日のSold件数（取得できたSoldカードの日付から集計）
- Active件数
- Sell-through
- 平均販売ペース
- Sold中央値 / Active中央値
- eBay手数料の推定
- 送料の概算
- 1個あたり利益 / ROI
- BUY / MAYBE / SKIP

## Cloudflare設定
1. Secret `OPENAI_API_KEY` を設定。
2. `wrangler.toml` に `[browser] binding = "BROWSER"` があるので、GitHubへのpush後にCloudflareが再デプロイします。
3. Cloudflare Dashboardで Worker > Settings > Bindings に Browser Run `BROWSER` が表示されることを確認してください。

## 重要
- eBayはbot対策やHTMLを変更することがあります。Browser Runで取得できない場合は結果に `FAILED/PARTIAL` が出て、eBay Sold/Activeを手動確認するリンクを残します。
- Best Offerは表示価格と実際の成約価格が異なることがあります。
- 送料は写真から推定した梱包重量/寸法を使う概算です。実際の送料とは異なる場合があります。
- eBay手数料は初期値13.6% + $0.40。カテゴリー、ストア、Promoted Listings等で変わるため詳細設定から変更できます。
