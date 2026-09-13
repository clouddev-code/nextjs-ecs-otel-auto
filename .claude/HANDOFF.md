# HANDOFF: nextjs-ecs-otel-auto

最終更新: 検証結果報告スライド（Claude Design canvas, 9枚）を作成・公開 →
バックグラウンドレビュー（slide-check）で見つかった指摘を全て修正 → 再publish完了した時点
（コンテキスト使用量110%到達のため緊急保存）

## ゴール（原文）

Next.jsのサンプル的なApp.route使ったアプリをecsでotel collectorでx-ray trace可視化できるものを作りたい。otelは自動計装で、ecs task起動時にinit containerでjarを取得、bind mountなvolumeに配置。NODE_OPTIONSでロードするものを インフラはAWS CDK

## ステータス: 実装・ローカルE2E検証まで完了。AWSへの実デプロイは未実施（ユーザーが明示的に保留を選択）

---

## 完了事項

### 1. リポジトリ構成
```
/Users/hiruta/work/nextjs-ecs-otel-auto/
├── app/       Next.js 16 (App Router) サンプルアプリ。OTel依存は一切含まない
├── infra/     AWS CDK (TypeScript)
├── research/  aws-researcherエージェントによる調査メモ
└── README.md  アーキテクチャ・デプロイ手順・ハマりどころ
```

### 2. Next.js アプリ (`app/`)
- Next.js 16.3.4 / React 19.2.0（当初 next@15.0.3 を使ったが CVE-2025-66478 の脆弱性があったため 16.3.4 に上げた。`npm audit` で 0 vulnerabilities 確認済み）
- ルート: `/`（Server Component、起動時に `/api/hello` へ内部fetch）、`/about`、`/api/hello`（Route Handler）
- `next.config.mjs`: `output: 'standalone'`
- `Dockerfile`: マルチステージビルド。**重要な修正済みバグ**: standalone の `server.js` は `process.env.HOSTNAME` にバインドするが、Docker はコンテナ起動時に `HOSTNAME` をコンテナIDに自動設定するため、何もしないと `127.0.0.1` にバインドされず、`/` 内部の `fetch('http://127.0.0.1:3000/api/hello')` が `ECONNREFUSED` になる。`Dockerfile` に `ENV HOSTNAME=0.0.0.0` を追加して解消済み（ローカル・ECS本番どちらでも必要）。
- ローカルビルド・起動・3ルートの200確認済み。

### 3. CDKインフラ (`infra/lib/otel-ecs-stack.ts`)
ECS Fargateタスク1つに3コンテナ構成（`ecs.FargateTaskDefinition` + `addContainer` のL2構成。`ApplicationLoadBalancedFargateService`は起動順序制御・essential:false構成に不向きなため不採用）:

1. **OtelInit**（init container, `essential: false`）
   - image: `public.ecr.aws/aws-observability/adot-autoinstrumentation-node:v0.12.0`（実在確認済み・pull確認済み）
   - command: `['cp', '-a', '/autoinstrumentation/.', '/otel-auto-instrumentation-node']`
   - 共有ボリューム `otel-auto-instrumentation-node`（`ecs.Volume` で `host` 未指定 = Fargate対応のタスクスコープ・エフェメラルボリューム。`sourcePath`はEC2専用なので不使用）にマウント

2. **OtelCollector**（sidecar, `essential: true`）
   - image: `public.ecr.aws/aws-observability/aws-otel-collector:v0.50.0`（実在確認済み・pull確認済み。当初v0.42.0を指定していたが最新版に更新済み）
   - config: `infra/assets/otel-collector/collector-config.yaml`（OTLP grpc:4317/http:4318 受信 → `resourcedetection`[env,system,ecs] → `awsxray` exporter）を `ssm.StringParameter` に格納し、`ecs.Secret.fromSsmParameter()` 経由で `AOT_CONFIG_CONTENT` 環境変数として注入（実行ロールへの読み取り権限はCDKが自動付与）

3. **App**（`essential: true`, `dependsOn: [OtelInit=SUCCESS, OtelCollector=START]`）
   - image: `ecs.ContainerImage.fromAsset('../app', { platform: Platform.LINUX_ARM64 })`（ユーザー指示によりARM64=Gravitonに変更済み。ビルド環境のアーキテクチャに関わらず常にARM64イメージを生成）
   - `NODE_OPTIONS=--require /otel-auto-instrumentation-node/autoinstrumentation.js`
   - OTel環境変数: `OTEL_SERVICE_NAME=nextjs-app`, `OTEL_TRACES_EXPORTER=otlp`, `OTEL_METRICS_EXPORTER=none`, `OTEL_EXPORTER_OTLP_PROTOCOL=grpc`, `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4317`, `OTEL_PROPAGATORS=tracecontext,baggage,xray`, `OTEL_TRACES_SAMPLER=always_on`（デモ用に常時サンプリング。本番相当にする場合は`xray`リモートサンプリング＋Collector側`awsproxy` extensionが必要）
   - 同ボリュームを`readOnly: true`でマウント

- タスクロールに管理ポリシー `AWSXRayDaemonWriteAccess` を付与
- `FargateTaskDefinition`に`runtimePlatform: { cpuArchitecture: ARM64, operatingSystemFamily: LINUX }`を指定（**ユーザー指示によりARM64化済み**。3コンテナのイメージ全てARM64マニフェスト対応をdocker pullで実機確認済み）
- `ecs.Cluster`（VPC 2AZ、パブリック+プライベート(egress)サブネット、**Regional NAT Gateway 1つ**）+ `ApplicationLoadBalancer`（port 80 → target port 3000, healthCheck path `/api/hello`）
- **VPCエンドポイント（ユーザー指示により追加済み）**: Gateway `S3`、Interface `ecr.api` / `ecr.dkr` / `logs` / `ssm` / `xray`。NAT Gatewayは`public.ecr.aws`（ECR Public、VPCエンドポイント非対応）からのADOTイメージ取得に必要なため維持。
- `CfnOutput`: `AlbDnsName`

### 4. 検証済み事項
- `npx tsc --noEmit`（infra）: エラーなし
- `npx cdk synth`: exit 0。テンプレート内容を確認済み（コンテナ定義・dependsOn・mountPoints・IAMポリシーArn・SSM Secret参照が意図通り）
- Dockerイメージビルド成功、コンテナ単体起動で3ルート200確認
- **ローカルDockerでのE2E検証（advisorの指摘で追加実施・成功）**:
  1. `docker volume create otel-e2e`
  2. `docker run --rm -v otel-e2e:/otel-auto-instrumentation-node public.ecr.aws/aws-observability/adot-autoinstrumentation-node:v0.12.0 cp -a /autoinstrumentation/. /otel-auto-instrumentation-node` → exit 0、ファイル配置確認（`/autoinstrumentation/autoinstrumentation.js`が`require('@aws/aws-distro-opentelemetry-node-autoinstrumentation/register')`しているのを確認済み）
  3. アプリコンテナを同ボリューム+`NODE_OPTIONS`+`OTEL_TRACES_EXPORTER=console`で起動 → "AWS Distro of OpenTelemetry automatic instrumentation started successfully" を確認
  4. `/`と`/api/hello`にcurl → 両方200。コンソールログ上で同一traceIdの中に `fetch GET http://127.0.0.1:3000/api/hello`（送信側span）と `GET /api/hello`（受信側span）が両方出現 = 2ホップ分散トレースの相関を確認
  5. 既知の無害な警告あり: `Cannot execute the operation on ended Span ...`（ADOT自動計装とNext.js内部トレーシングの二重span操作によるもの。トレース自体は正しくエクスポートされる。READMEに記載済み）
  6. テスト用のvolume/container/imageは全て後片付け済み

### 5. Advisor相談履歴
- 1回目（実装着手前）: アーキテクチャ方針を承認。追加助言: Apple Siliconなので`Platform.LINUX_AMD64`固定必須、Collector configはSSM Secret経由、`OTEL_TRACES_SAMPLER=xray`は`awsproxy` extension必要なので今回は`always_on`に、ALBヘルスチェックは`/api/hello`
- 2回目（完了報告前）: 「E2E未検証」を指摘（init→volume→NODE_OPTIONSの実機構成を一度も動かしていなかった）。→ 上記4節の検証を追加実施して解消。デプロイ判断はユーザーに委ねるようにとの助言 → AskUserQuestionで確認

### 6. 追加対応: VPC環境・VPCエンドポイント・ARM64化（ユーザー追加指示）
- ユーザー指示: 「ECS Fargate をデプロイするVPC環境、VPC Endpoint、Regional NAT Gatewayも用意して。FargateはARMで」
- `infra/lib/otel-ecs-stack.ts` を編集:
  - VPC: `subnetConfiguration`で public/private-with-egress を明示、`natGateways: 1`（regional、AZごとではない）は維持
  - `vpc.addGatewayEndpoint('S3Endpoint', ...)` + `vpc.addInterfaceEndpoint(...)` を ECR API/DKR, Logs, SSM, XRay の5つ追加
  - `FargateTaskDefinition`に`runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX }`追加
  - App コンテナの`ContainerImage.fromAsset`の`platform`を`LINUX_AMD64`→`LINUX_ARM64`に変更
- 検証: `adot-autoinstrumentation-node:v0.12.0`と`aws-otel-collector:v0.50.0`を`docker pull --platform linux/arm64`で実機取得しArch:arm64を確認済み。`npx tsc --noEmit`・`npx cdk synth`とも成功、生成テンプレートで`RuntimePlatform: ARM64`とVPCエンドポイント5種・NAT Gateway1つを確認済み。
- **注意**: この変更後、Docker上でのフルE2E再実行（initコンテナ→ボリューム→NODE_OPTIONS→2ホップトレース相関）はまだ行っていない。ただし直前のE2E検証はホスト（Apple Silicon/OrbStack）がarm64でDocker pullがデフォルトでarm64イメージを取得していたため、実質的に同じarm64構成での動作は既に確認できている。念のため再検証するなら README「ローカルでの動作確認」または HANDOFF「4. 検証済み事項」の手順を参照。
- README.md も上記変更内容に合わせて更新済み（アーキテクチャ節・ネットワーク節・ハマりどころ節）。

### 7. 検証結果報告スライド（Claude Design canvas, 今回追加）

ユーザー依頼:「検証結果を元に、claude designでスライド作りたい」

- `/design` スキル（Claude Design canvas）を使い、README.md / HANDOFF.md の内容をもとに
  日本語9枚のスライドデッキを作成・公開済み。
- **公開URL**: `https://claude.ai/code/artifact/c1c84b5c-58e0-4bf1-ba2b-2cdb2873b992`
  （このセッションで公開。以後の更新はこのURLに対して同じファイルパスで再publishすれば良い）
- **作業ファイル（再編集の元になるもの、保持する）**:
  `/private/tmp/claude-501/-Users-hiruta-work-nextjs-ecs-otel-auto/8ba07955-c19a-4339-bd88-37f7cc10dcf8/scratchpad/otel-slides/`
  配下に `Main.dc.html`（タイトル）, `Slide02-Goal.dc.html` 〜 `Slide09-Status.dc.html`,
  `canvas.json`、および seed済みの `nextjs-ecs-otel-verification-report.html`（公開した実体ファイル）。
  **注意**: このパスは `/tmp` 配下のセッション固有スクラッチパッドのため、セッション終了後に
  消える可能性がある。次回編集する際は `/design` スキルの「Updating an existing canvas」手順
  （公開済みアーティファクトURLを WebFetch → `--extract` で作業ファイルを復元）に従うこと。
- **スライド構成（9枚、全て1280x720、ダークテーマ/cyan・amber・green アクセント、
  Space Grotesk+IBM Plex Sans JP+IBM Plex Mono）**:
  1. タイトル（ゴール概要・ステータスバッジ）
  2. 検証のゴール・検証スコープ
  3. アーキテクチャ全体図（ECS Task内3コンテナ構成、SVG矢印でcp -a/OTLP/awsxray exporterの関係を可視化）
  4. 3コンテナの役割詳細（OtelInit/OtelCollector/Appを3カード）
  5. ネットワーク構成図（VPC 2AZ、Regional NAT Gateway、VPCエンドポイント5種）
  6. サンプルアプリの動作（/→/api/helloの2ホップをトレースウォーターフォール風に可視化）
  7. ローカルE2E検証結果チェックリスト＋既知の無害な警告の説明
  8. 実装上の2つの落とし穴（HOSTNAMEバインド問題／CDK L2構成選択）
  9. ステータス・Next Steps（デプロイ手順・デプロイ後確認手順）
- **バックグラウンドレビュー完了・指摘は全て反映済み**（`slide-check`サブエージェントがRead専用で
  9ファイル+canvas.jsonをチェック。事実面の矛盾・フォーマット不備・日本語の問題は無し）。
  見つかった4点のうち3点を修正、1点は判断の上「修正不要」とした:
  1. ✅ 修正済み: 各content スライドのキッカー番号（例: Slide02の「01 — 背景・目的」）が
     フッターのページ番号（「02/09」）と1つズレていた。Slide02〜09のキッカー番号を
     フッターと一致させた（02〜09）。
  2. ✅ 修正済み: `Slide03-Architecture.dc.html` で dependsOn バッジ2つがAppカード上端と
     約10px重なっていた → バッジの`top`を20px→8px、フォント/パディングを縮小して解消。
  3. ✅ 修正済み: 同スライドのAWS X-Rayボックスが、「タスク境界の外」という意図に対し
     実際は大部分（55%）が境界線の内側にあった → ボックスの`top`を320px→335pxに移動し
     境界を越える比率を反転（59%が外側）。連動して矢印終点・注釈バーの位置も調整。
  4. ⬜ 修正不要と判断: Slide07の「SSM Secret参照」という表記をレビューアが
     「Parameter Storeとの混同」として指摘したが、これはCDKの
     `ecs.Secret.fromSsmParameter()`（SSM Parameter Store由来のECS Secret）を指す
     正確な表現で、元のHANDOFF内検証メモ（3節4節）の表記とも一致するため変更していない。
- 修正後、working filesを再度 `seed-canvas.mjs` で再seed（`--check`で`ok`確認済み）→
  同じURL（下記）へ `url` 指定 + `contract: "0.1.31"` で再publish済み（`capabilities`は省略し、
  保存済みの`{self:{}, downloads:{}}`をそのまま継続）。**この再publishが本セッション最後の
  完了アクション。ユーザーへの最終報告も送信済み。**
- 公開時の設定: `favicon: "🛰️"`, `contract: "0.1.31"`, `capabilities: {self:{}, downloads:{}}`
  （ロースターに基づき artifact-publish + downloads を declare 済み）。

### 8. Fargate Spot 化・コンテナヘルスチェック・FireLens→S3ログ（今回追加、advisor相談1回）

- ユーザー指示1:「Fargate Spotにしておきたい」
  - `cluster`: `enableFargateCapacityProviders: true` を追加
  - `FargateService`: `capacityProviderStrategies: [{ capacityProvider: 'FARGATE_SPOT', weight: 1 }]`
    を追加（launchType指定は外れ、100% Spotで起動）。`cdk synth`で
    `AWS::ECS::ClusterCapacityProviderAssociations`（FARGATE/FARGATE_SPOT）と
    サービス側`CapacityProviderStrategy`を確認済み。
- ユーザー指示2:「container health checkとFluentbitでS3にログ送るようにしておいて」
  - advisorに1回相談（オプションA: 各コンテナの`awsfirelens`オプションで`Name: s3`
    を直接使う素直な実装 vs オプションB: カスタムfluent-bit.conf+BucketDeployment
    でCloudWatch併用 → **A採用**、その場で「深追いしすぎ」との判断）
  - **コンテナヘルスチェック**: Appコンテナにのみ設定（`CMD-SHELL`,
    `node -e "fetch('http://127.0.0.1:3000/api/hello')..."`, interval 30s, timeout 5s,
    retries 3, startPeriod 30s）。`NODE_OPTIONS=`で毎回の呼び出し内でのみ空に
    上書きし、ヘルスチェックのたびにOTel自動計装が再ロードされるのを防止。
    **OtelCollectorには設定していない**: `aws-otel-collector`イメージには
    `/bin/sh`が無く`CMD-SHELL`が使えないことを実機確認済み（`docker run --entrypoint sh`
    → `executable file not found`）。
  - **FireLens/Fluent Bit → S3**: `FireLensLogRouter`サイドカーを追加
    （image: `public.ecr.aws/aws-observability/aws-for-fluent-bit:2.32.2`、
    `docker manifest inspect`でarm64対応確認済み）。App/OtelCollector/OtelInitの
    3コンテナの`logging`を`ecs.LogDrivers.awsLogs`から`ecs.LogDrivers.firelens`
    （オプション`Name: s3`, `bucket`, `region`, `total_file_size: 1M`,
    `upload_timeout: 1m`, `use_put_object: On`, `compression: gzip`,
    `s3_key_format: /<container>/%Y/%m/%d/%H/%M/%S-$UUID`）に変更。
    新規`logsBucket`（S3, blockPublicAccess ALL, DESTROY+autoDeleteObjects）を作成し
    `logsBucket.grantPut(taskRole)`（**タスクロール**に付与。Fluent Bitはタスク内の
    コンテナとして動くため実行ロールではない点に注意）。
    既存の`logGroup`（CloudWatch）は`FireLensLogRouter`自身のログ専用に用途変更
    （ログパイプライン自体が壊れた場合の可視性を残すため、advisor助言どおり）。
    3コンテナに`FireLensLogRouter`への`dependsOn: START`を追加。
  - **既知のトレードオフ（ユーザーに要説明）**: CloudWatch Logsでの
    アプリ/Collector/Initログの`tail`はできなくなった（1MBまたは1分単位で
    gzip1オブジェクトとしてS3にまとめてPutObjectされるため、リアルタイム性は無い）。
    S3のみを送信先とする実装（CloudWatch併用はしていない）。
  - 検証: `npx tsc --noEmit`・`npx cdk synth`とも成功。生成テンプレートで
    `awsfirelens`ドライバ×3、`HealthCheck`（Appのみ）、
    `FirelensConfiguration: {Type: fluentbit}`、`LogsBucket`とタスクロールへの
    `s3:PutObject`系権限、を確認済み。
  - **追加指示（同セッション）**:「logとるコンテナはappのみであとは要らないです」
    → OtelInit/OtelCollectorの`logging`（firelens）と`FireLensLogRouter`への
    `dependsOn`を削除。この2コンテナは`logConfiguration`自体を持たず、標準出力は
    どこにも収集されない（意図的）。App コンテナのみ`awsfirelens`→S3のまま。
    単一呼び出しになった`s3LogOptions`ヘルパー関数はAppの`logging`に直接インライン化。
    `npx tsc --noEmit`・`npx cdk synth`で再確認済み（`awsfirelens`が1件のみ、
    OtelInit/OtelCollectorに`LogConfiguration`が存在しないことを確認）。
  - README.md も本節の内容に合わせて更新済み（アーキテクチャ図に
    `[0] FireLensLogRouter`追加、「ログ」節新設、「実装上のポイント」に
    ヘルスチェック関連2件追加）。
  - **注意**: この変更後、Docker上でのフルE2E再実行（FireLens→S3送信の実機確認）は
    行っていない。`cdk synth`の静的検証のみ。実際にS3へログが届くかは
    `cdk deploy`後でないと確認できない。

## 未完了・保留事項

- **`cdk deploy` 未実施**: ユーザーに確認したところ「今はデプロイしない」を選択。NAT Gateway/ALB/Fargateなど課金対象リソースが発生するため。
- デプロイ手順は `README.md` に記載済み（`cd infra && npm install && npx cdk bootstrap && npx cdk deploy`）。
- デプロイ後の確認手順もREADMEに記載済み（ALB DNS名へのcurl、X-Rayコンソールでのサービスマップ確認）。
- `npx cdk destroy` の片付け手順もREADMEに記載済み。

## 次にやること（再開時）

1. スライドについては現状、追加対応は不要（レビュー指摘は全て対応済み・再publish済み）。
   ユーザーからスライドの追加修正依頼があれば、7節の作業ファイルパス（`/private/tmp/...`配下、
   ただしセッション固有スクラッチパッドのため消えている可能性あり → `/design`スキルの
   「Updating an existing canvas」手順でアーティファクトURLから`--extract`して復元）を編集し、
   再seed→同URLへ再publishする。
2. ユーザーが「デプロイしたい」と言ったら: `cd infra && npx cdk bootstrap && npx cdk deploy` を実行（AWS認証情報が必要）。デプロイ完了後、`AlbDnsName`出力にcurlし、数分待ってからX-Rayコンソールのサービスマップで`nextjs-app`のトレースを確認。
3. それ以外の変更依頼があれば、`infra/lib/otel-ecs-stack.ts`（インフラ本体）または `app/src/app/`（アプリ本体）を編集。
4. ローカルでの動作確認は `README.md`「ローカルでの動作確認」節、またはこのファイルの「4. 検証済み事項」の手順を再実行すれば良い。

## 重要な既知の落とし穴（再発防止用メモ）

- Next.js standalone サーバーは `Dockerfile` に `ENV HOSTNAME=0.0.0.0` がないと、同一コンテナ内での `127.0.0.1` 宛てリクエストが失敗する。これは既に修正済みだが、Dockerfileを作り直す際は要注意。
- ADOT Node.js自動計装イメージ（`adot-autoinstrumentation-node`）はENTRYPOINTでファイルを自動コピーしない。initコンテナの`command`に明示的に`cp -a /autoinstrumentation/. <mount-path>`を書く必要がある（Java版とは挙動が異なる）。
- `npm install`や`docker`コマンドはこの開発環境のサンドボックスだとEPERM/権限エラーになることがある（npmキャッシュのパーミッション、ネットワークソケットのbindなど）。`dangerouslyDisableSandbox: true`が必要な場面が複数あった。
