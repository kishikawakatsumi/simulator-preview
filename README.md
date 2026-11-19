# Simulator Preview

Pull RequestのSimulator用ビルドを、リンクからブラウザで動作確認する実験用プロジェクトです。リポジトリ名は `simulator-preview` を想定しています。

```
PR更新 → GitHub Actions → Simulator .app → Artifact
                                         ↓
PRコメントのURL → 認証 → 取得・検証 → 専用Simulatorへインストール・起動
                                         ↓
                                 WebRTCで表示・操作
```

デモ用iOSアプリ、GitHub Actionsワークフロー、Artifact取得サーバー、Swift配信ホスト、Webクライアントをこのリポジトリに含みます。既存のSimulator Studioとは別のソース・ポート・状態ディレクトリで動作します。外部パッケージのインストール以外に、兄弟プロジェクトの参照はありません。

## GitHubなしで試す

Apple Silicon Mac、フル版Xcode、iOS 18以降のSimulatorランタイムと作成済みのiPhone端末、Node.js 24以降、Python 3が必要です。Macのログイン済みユーザーで実行します。

```sh
npm ci
npm run demo:build
npm run build
npm run demo
```

`http://127.0.0.1:8091/builds/1/1` を開きます。

同じ形式のZIP Artifactを読み込み、内容を検証した後、利用者用の新しいシミュレータへデモアプリをインストール・起動します。最初の端末起動では数分かかることがあります。画面が表示されたら **Try it · Add one**、**Warm accent**、**Open details** で入力と画面遷移を確認できます。

ローカルデモではGitHub APIと認証を省略します。公開モードで `PREVIEW_DEMO=1` を使うことはできません。デモ用の成果物は `example-build/artifact.zip` に作成されます。実行中に再ビルドした場合はサーバーを再起動して読み込み直してください。

## GitHubで試す

1. GitHubに `YOUR_OWNER/simulator-preview` リポジトリを作成し、このプロジェクトをpushします。`.github/workflows` を含む初期状態を **default branchへ先に配置**してください。コメント用の `workflow_run` はdefault branchにある定義を使います。
2. 常設Macのサーバーを公開し、Cloudflare Accessでこのリポジトリを閲覧・実行してよい人だけを許可します。公開手順は [deploy/README.md](deploy/README.md)。既存サービスと併用する場合は新しいホスト名とポート8091を使います。
3. GitHubの **Settings → Secrets and variables → Actions → Variables** に `PREVIEW_ORIGIN=https://preview.example.com` を設定します。これは秘密情報ではなく、PRコメントに掲載するURLのオリジンです。
4. サーバーMacで `.env.example` を `.env` にコピーし、次を設定します。

```dotenv
PREVIEW_PORT=8091
PREVIEW_ORIGIN=https://preview.example.com
PREVIEW_AUTH=access
PREVIEW_REPOSITORY=YOUR_OWNER/simulator-preview
GITHUB_TOKEN=YOUR_FINE_GRAINED_TOKEN
CF_ACCESS_ISSUER=https://YOUR_TEAM.cloudflareaccess.com
CF_ACCESS_AUD=YOUR_ACCESS_APPLICATION_AUD
CF_TURN_KEY_ID=YOUR_TURN_KEY_ID
CF_TURN_API_TOKEN=YOUR_TURN_API_TOKEN
```

`GITHUB_TOKEN` は対象リポジトリだけを許可したfine-grained PATで、**Actions: Read** と **Pull requests: Read** が必要です。Macの `.env` に保存します。CIのSecretやブラウザへ渡しません。組織によってはPATの承認も必要です。公開時は `PREVIEW_DEMO` を設定しないでください。初期版ではAccessで許可した全員が設定済みリポジトリのプレビューを開けます。閲覧者ごとのGitHubリポジトリ権限照合は行いません。

5. `npm start` でサーバーを起動します。
6. 同じリポジトリ内にブランチを作り、例えば `examples/PreviewDemo.swift` の文言を変更してPRを作成します。ビルドが成功するとPRに **Open Preview** が投稿されます。リンクを開いて認証すると、そのコミットのアプリが起動します。

コメントの投稿には、リポジトリ／組織のActionsポリシーが `pull-requests: write` を許可している必要があります。投稿できない場合でもビルドArtifactは残ります。URLは `/builds/<Actions Run ID>/<Artifact ID>` です。

## ワークフローとバージョン

- `simulator-preview-build.yml`: PRのheadコミットをcheckoutし、arm64のiOS Simulator用アプリをビルド。実行権限やsymlinkを保持する `app.tar` を `simulator-preview` というArtifact名で7日保存します。スキーム未指定なら同梱デモをビルドします。
- `simulator-preview-comment.yml`: 成功通知後に、信頼するdefault branchの処理でPRコメントを作成・更新します。PRコードやArtifactをこの権限付きジョブで実行しません。PRが更新済みなら古い結果を掲載しません。
- URLはRun IDとArtifact IDに固定されます。既存URLが別コミットにすり替わることはありません。PRコメントだけを新しいURLへ更新します。
- サーバーはリポジトリ、ワークフローパス、成功状態、PR、コミット、Artifactの対応、有効期限、SHA-256を検証します。forkのPRは初期版では対象外です。
- 期限切れは再ビルドを案内します。既に動いているセッションをArtifact失効と同時に強制終了する方式ではありません。

## 自分のアプリに差し替える

この構成を対象アプリのリポジトリへ配置し、Repository Variablesに次を設定してください。

| Variable | 例 |
|---|---|
| `PREVIEW_PROJECT` | `MyApp.xcodeproj` |
| `PREVIEW_WORKSPACE` | `MyApp.xcworkspace`（workspace利用時。projectより優先） |
| `PREVIEW_SCHEME` | `MyApp`（共有scheme） |
| `PREVIEW_ORIGIN` | `https://preview.example.com` |

`PREVIEW_SCHEME` を指定すると `scripts/build-preview.sh` が `xcodebuild` を使います。基本形は、Debugビルドからトップレベルの `.app` が1つ生成されるアプリです。複数のアプリを生成するschemeや特殊なビルド手順では、このスクリプトの成果物選択を調整してください。サーバー側の `PREVIEW_REPOSITORY` も対象リポジトリへ変更します。

CIと常設Macで必要なXcode・SDK・ランタイムを揃えてください。実機用IPAは対象外です。サーバーはarm64とSimulator向けMach-Oを確認し、アプリの最低OS以上の端末だけを一覧に表示します。ビルドはリモートMacでは行いません。

## セッションと運用

- 認証ユーザー＋ブラウザID＋追加セッションID＋ビルドごとに専用端末を割り当てます。同じ人でも別ビルドは別端末です。
- 同じブラウザで同じURLに戻ると既存の端末を再利用します。同じURLを複数タブで開くと同じ端末を共有し、操作権は前面タブへ移ります。
- 初期値は同時2セッション／4タブ。上限時はブラウザで待機します。`PREVIEW_MAX_SESSIONS` / `PREVIEW_MAX_VIEWERS` で変更できます。
- 全タブ切断の60秒後に端末を停止します。アプリのデータは保持しますが、再接続でホストを再起動する場合、アプリのメモリ上の状態は引き継ぎません。
- Artifactはローカルにキャッシュします。ダウンロード上限512MiB、展開サイズ上限2GiB、キャッシュ容量目安10GiB。容量不足時は停止して古い `.preview/builds` のキャッシュを削除してください。削除済み成果物でも、GitHubに残っていれば再取得できます。
- この実験版は利用停止した端末の自動削除を行いません。長期間運用する場合、サーバー停止中にXcodeから不要な専用端末を整理してください。端末名は `Studio-<このインストールのID>-…` です。
- 公開forkの任意コードを安全に実行する隔離サービスではありません。信頼する社内PRを対象とし、ビルドの実行環境はGitHub-hosted runner、プレビューの実行環境は専用Macを使う想定です。

## 構成

| 場所 | 役割 |
|---|---|
| `server/preview/` | GitHub API、ビルド検証、キャッシュ、準備API、OS互換性 |
| `server/` | 認証、セッション割り当て、WebRTC、配信ホスト管理 |
| `web/preview.ts` | 準備状況・エラー・リトライ・ビルド情報 |
| `native/` | CoreSimulator接続、画面取得、VideoToolbox H.264圧縮、入力 |
| `scripts/` | ビルド、成果物パッケージ、パスを検証する展開処理 |
| `examples/PreviewDemo.swift` | PR番号・コミット表示、カウンター、画面遷移のデモ |

配信と入力はSimulator Studioから移植しました。CoreSimulator / SimulatorKitの非公開APIを使用するため、Xcode更新時は互換性確認が必要です。通常起動はNode.jsサーバーとセッションごとのSwiftホストだけで、DBや別のキューサービスは使いません。

## 検証

```sh
npm test
python3 tests/archive_test.py
# デモと配信ホストをビルド後、GUIセッション上で:
PREVIEW_TEMPLATE=<既存iPhoneのUDID> node tests/preview.browser.mjs
```

ブラウザ統合テストは専用端末を2台作成し、ZIPからのアプリ展開・インストール・起動・WebRTC・タップ・ビルド間分離・再接続を実行します。終了時にテストが作った端末だけを削除します。GitHubの通信は固定のローカルArtifactで代替します。GitHub上のActions実行・PRコメント・外部ネットワーク経由の確認は、リポジトリ作成と公開設定後に必要です。
