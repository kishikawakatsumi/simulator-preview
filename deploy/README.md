# Cloudflareで社内公開する

Cloudflareのドメイン・Access・TURNを用意してから行う手順です。このリポジトリはCloudflareアカウントや外部リソースを自動作成しません。

## 1. Accessと公開ホスト名

Cloudflare AccessでSelf-hostedアプリケーションを作成し、`sim.example.com`などの公開ホスト名と、社内のメールアドレス／IdPグループを許可するポリシーを設定します。アプリのAudienceとチームドメインを控えます。メールアドレスだけをHTTPヘッダーに入れても、このサーバーの認証は通りません。

`.env`を次のように変更します。

```dotenv
PREVIEW_AUTH=access
PREVIEW_ORIGIN=https://sim.example.com
CF_ACCESS_ISSUER=https://YOUR-TEAM.cloudflareaccess.com
CF_ACCESS_AUD=YOUR-APPLICATION-AUDIENCE
```

NodeはJWTの署名、issuer、audience、有効期限を検証します。認証鍵はCloudflareのJWKSから取得し、`jose`でキャッシュします。公開モードではローカルURLからの認証なしアクセスも拒否します。

## 2. Tunnel

ホストMacに`cloudflared`をインストールし、Cloudflare Tunnelの公式手順でNamed Tunnelを作成します。公開ホスト名の転送先を`http://127.0.0.1:8091`にします。ローカル管理を選ぶ場合は[cloudflared.example.yml](cloudflared.example.yml)を参考に設定してください。

HTTPSのブラウザ→Cloudflare間、TunnelのCloudflare→Mac間を経由してHTML・API・WebSocketを提供します。ルーターで8091番を公開する必要はありません。`httpHostHeader`でHostを書き換えず、公開ホスト名をNodeに渡してください。OriginとHostは`PREVIEW_ORIGIN`に一致する必要があります。

Nodeを`npm start`で起動し、Tunnelを起動します。Accessのログイン画面を経由して社内アカウントで開けることを確認します。

## 3. TURN

Cloudflare RealtimeでTURN Keyを作成し、Key IDとその資格情報発行用APIトークンをMacの`.env`へ設定します。

```dotenv
CF_TURN_KEY_ID=YOUR-TURN-KEY-ID
CF_TURN_API_TOKEN=YOUR-TURN-API-TOKEN
```

サーバーは接続ごとに短期資格情報を発行し、ブラウザとMacのWebRTCに設定します。長期APIトークンをブラウザへ送信しません。資格情報発行が失敗した場合、TURN設定を黙って無視せず接続エラーを返します。

TunnelはWebRTCの映像・入力を転送しません。Macから外向きのWebRTC/STUN/TURN通信を許可します。Cloudflare TURNのUDPに加え、TCP/TLSの候補も設定するので、UDPが使えないネットワークではTCP/TLS経由を試します。

## 4. 公開後の確認

1. 社内アカウントだけがアクセスできることを確認する。
2. 通常接続で映像を表示し、Direct / Relay、fps、通信量、RTTを確認する。
3. `PREVIEW_RELAY_ONLY=1`でサーバーを再起動し、画面の経路表示がRelayになり、映像と入力が動作することを確認する。
4. iPhoneのWi-Fiを切り、モバイル回線でタップ・ドラッグ・回転・再接続を確認する。
5. 複数ユーザー・端末で開き、それぞれ専用シミュレーターになることを確認する。同じブラウザーの通常タブでは前面のタブへの操作の自動引き継ぎ、追加ワークスペースでは独立操作を確認する。無操作のまま2分以上置いた場合と、バックグラウンドから戻った場合も手動取得なしで操作できることを確認する。
6. 検証後は`PREVIEW_RELAY_ONLY`を外す。

TURN実回線テストは、この設定が揃うまでは未検証です。ローカルDirectの成功からTURNの成功を推定しないでください。

Macの自動スリープを避け、ログインセッションでホストを起動します。常駐化する場合はログインユーザーのLaunchAgentでNodeとcloudflaredを管理してください。GUIセッションを持たないシステムサービスへ移す前提にはしていません。

## 参照

- [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/concepts/routing/)
- [Cloudflare Access JWT検証](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- [TURN資格情報発行](https://developers.cloudflare.com/realtime/turn/generate-credentials/)
- [TURNサービスの接続先とポート](https://developers.cloudflare.com/realtime/turn/)

専用端末の割り当てを再起動後も復元するため、`PREVIEW_STATE_DIR`は同じ永続ディレクトリーを使います。初期値は作業ディレクトリー内の`.studio`です。`PREVIEW_MAX_SESSIONS=2`で開始し、Macのメモリー・エンコード負荷を確認して上限を調整してください。
