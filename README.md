# Resale Scanner V1.1

店頭商品の写真 + eBay Sold Itemsスクショ（複数可）+ 現在出品スクショから、直近7/30/90日の販売数・売価・販売ペース・Active数・Sell-through・手数料・利益を計算するCloudflare Workers/PWAです。

## V1.1でできること
- 商品写真から商品名/検索語を特定
- Soldスクショを複数枚読み込み、重複カードを除外
- Sold日付・価格・buyer-facing送料・Best Offer表示を抽出
- 直近7日 / 30日 / 90日のSold件数を自動集計
- 30日/90日の販売ペース（平均何日に1個）
- 現在Active件数と90日Sell-throughを計算
- Sold価格の中央値を算出（可能ならBest Offer表示を除外）
- 仕入れ・手数料・実発送コスト・梱包材から純利益/ROIを計算
- BUY / MAYBE / SKIP 判定
- Sold検索へのリンク生成

## 精度について
Sold検索結果が4件なら、その4件すべてがスクショに入るように撮るのが理想です。結果が多い場合はスクロールして複数枚アップロードしてください。V1.1は重複を除外します。

- Sold取得率100%: 7/30/90日件数を高精度で計算可能
- Sold取得率100%未満: 7/30/90日件数は「撮影できた範囲の最低値」
- Best Offer: eBay画面の表示価格と実際の成立価格が異なる可能性あり
- 実発送コスト: eBay画面のbuyer送料とは別物なので、V1.1では手入力。V2でcarrier API連携予定

## デプロイ手順
1. Node.jsをインストール
2. このフォルダで `npm i -g wrangler`
3. `wrangler login`
4. OpenAI APIキーを登録: `wrangler secret put OPENAI_API_KEY`
5. 任意でモデル変更: `wrangler secret put OPENAI_MODEL`
6. `wrangler deploy`
7. 表示されたURLをiPhoneで開き、「ホーム画面に追加」

既定モデルは `gpt-5.6-luna`。画像からのデータ抽出中心なのでコストを抑えた設定です。精度を上げたい場合は `gpt-5.6` 等に変更できます。

## 店頭での使い方
1. 商品写真を撮る
2. eBayで同一商品を検索、Condition=New
3. Sold Items=ON
4. Sold結果を上から下までスクショ（必要なら複数枚）
5. Sold Items=OFFにしてActive画面をスクショ
6. アプリへ写真を入れる
7. 仕入れ価格と、分かれば実発送コストを入力
8. 「分析する」

## V2候補
- UPCバーコードスキャン
- eBay Browse APIでActive Listingsを自動取得
- UPS/USPS等のrate APIで実発送コスト自動推定
- eBayカテゴリー別手数料の自動設定
- D1でスキャン履歴保存
- 複数商品の連続スキャン
