# nextjs-ecs-otel-auto

Next.js（App Router）のサンプルアプリを ECS Fargate 上で動かし、OpenTelemetry の
**自動計装**（アプリのコード変更なし）で取得したトレースを ADOT Collector 経由で
AWS X-Ray に送信するサンプル一式。インフラは AWS CDK（TypeScript）で構築する。

## アーキテクチャ

ECS タスク（Fargate）1つに 4 つのコンテナを配置する。

```
ECS Task
├─ [0] FireLensLogRouter (sidecar, essential:true)
│      image: public.ecr.aws/aws-observability/aws-for-fluent-bit
│      App の logConfiguration(awsfirelens) からログを受け取り、S3 バケットへ出力
│      （OtelInit / OtelCollector はログ収集自体をしていない）
│
├─ [1] OtelInit (init container, essential:false)
│      image: public.ecr.aws/aws-observability/adot-autoinstrumentation-node
│      command: cp -a /autoinstrumentation/. /otel-auto-instrumentation-node
│      → 共有ボリューム otel-auto-instrumentation-node に計装ファイル一式を配置して終了
│
├─ [2] OtelCollector (sidecar, essential:true)
│      image: public.ecr.aws/aws-observability/aws-otel-collector
│      OTLP(gRPC:4317 / HTTP:4318) を受信 → awsxray exporter で X-Ray に送信
│
└─ [3] App (essential:true, dependsOn: OtelInit=SUCCESS, OtelCollector=START, FireLensLogRouter=START)
       Next.js (App Router) / next start (standalone build)
       NODE_OPTIONS=--require /otel-auto-instrumentation-node/autoinstrumentation.js
       → [1] が配置した自動計装をロードし、OTLP で localhost:4317 (Collector) に送信
       → コンテナヘルスチェック: /api/hello に対する node の fetch（30秒間隔）
```

- Java のエージェント方式（initContainer で `javaagent.jar` を配置し
  `JAVA_TOOL_OPTIONS` でロード）と同じ考え方を Node.js に適用したもの。
  ADOT の Node.js 自動計装イメージはファイルを自動コピーする ENTRYPOINT を持たないため、
  init コンテナの `command` に明示的に `cp -a` を指定している。
- コンテナ間のファイル共有には、Fargate でも使える「host 未指定のボリューム」
  （タスクスコープのエフェメラルボリューム）を使用（EC2 起動タイプ専用の `sourcePath` は使わない）。
- X-Ray 互換のトレース ID 生成・伝播（`AWSXRayIdGenerator` / `AWSXRayPropagator`）は
  素の OpenTelemetry Node SDK では環境変数だけで設定できないため、これを内蔵している
  ADOT の自動計装を使うことが本方式の前提になっている。
- Fargate タスクは **ARM64（AWS Graviton）** で実行する（`runtimePlatform.cpuArchitecture:
  ARM64`）。4 コンテナのイメージ（ADOT 自動計装 / ADOT Collector / aws-for-fluent-bit / App）
  はいずれも ARM64 マニフェストを提供していることを確認済み。

### ログ（FireLens / Fluent Bit → S3）

- ログを収集するのは **App コンテナのみ**。`logConfiguration.logDriver: awsfirelens`
  で、`FireLensLogRouter` サイドカー（`aws-for-fluent-bit`、Fluent Bit の組み込み `s3`
  output プラグインを使用）経由でログを S3 バケット（`logsBucket`）に送る。1MB または
  1分ごとにまとめて gzip 圧縮した1オブジェクトとして `PutObject` される
  （1行ずつではない）ため、CloudWatch Logs のようなリアルタイムの `tail` はできない。
- OtelInit / OtelCollector は `logConfiguration` を持たず、標準出力はどこにも
  収集されない（意図的。ログが必要な場合は個別に `awslogs`/`awsfirelens` を追加する）。
- `FireLensLogRouter` 自身のログだけは、ログパイプライン自体の不具合を追えるように
  通常の `awslogs` ドライバで CloudWatch Logs（`ServiceLogGroup`）に出す。
- S3 へのアップロードはタスクロール（`TaskRole`）の権限で行われる（Fluent Bit は
  タスク内のコンテナとして動くため、実行ロールではなくタスクロールに
  `s3:PutObject` 系の権限を付与している）。
- ADOT Collector のイメージにはシェルが無いため、Docker 形式の
  コンテナヘルスチェック（`HealthCheck`）は **App コンテナにのみ** 設定している
  （下記「実装上のポイント」参照）。

### ネットワーク（VPC）

- 2 AZ、パブリックサブネット＋プライベートサブネット（egress あり）構成。
- **Regional NAT Gateway を 1 つ**（AZ ごとではなく VPC 全体で共有）配置。ADOT の
  イメージは `public.ecr.aws`（ECR Public、VPC エンドポイント非対応）から取得するため、
  VPC エンドポイントを揃えてもインターネット経由の egress は完全には無くせず、
  NAT Gateway は残す構成にしている。
- **VPC エンドポイント**（プライベートサブネットから AWS API 呼び出しを PrivateLink
  経由にし、NAT Gateway 経由のトラフィックとコストを削減）:
  - Gateway: `S3`（ECR のイメージレイヤー取得、および Fluent Bit から `logsBucket` への
    ログ送信の両方がこの経路を通る）
  - Interface: `ecr.api` / `ecr.dkr`（プライベート ECR からの App イメージ取得）、
    `ssm`（Collector 設定を格納した SSM パラメータの読み取り）、
    `xray`（Collector から X-Ray API への送信）
    （CloudWatch Logs はこのスタックで一切使用しないため `logs` エンドポイントは無し）

## ディレクトリ構成

```
app/     Next.js アプリ（App Router: /, /about, /api/hello）。OTel 関連の依存は一切含まない
infra/   AWS CDK（TypeScript）。ECS/ALB/VPC/IAM/SSM を構築
research/  調査メモ（ADOT イメージ仕様、ECS ボリューム共有、Collector 設定など）
```

### サンプルアプリの動作

- `/`（Server Component）が起動時に `/api/hello`（Route Handler）へ `fetch` する。
  これにより「アプリ内 2 ホップ」の分散トレースが自動計装だけで X-Ray の
  サービスマップに現れる。

## 前提条件

- Node.js 22.x（`nvm use 22.23.2`）
- Docker（イメージビルドに使用。ローカル確認は OrbStack/Docker Desktop 等）
- AWS CLI の認証情報（`cdk deploy` を行う場合）
- AWS CDK CLI（`infra/` 配下で `npx cdk ...` を使うので事前インストール不要）

## デプロイ手順

```fish
cd infra
npm install
# 初回のみ（対象アカウント/リージョンに CDK 用リソースをブートストラップ）
npx cdk bootstrap
npx cdk deploy
```

デプロイ後、出力される `AlbDnsName` にアクセスして動作確認する。

```fish
set -x ALB (aws cloudformation describe-stacks --stack-name NextjsEcsOtelAutoStack --query "Stacks[0].Outputs[?OutputKey=='AlbDnsName'].OutputValue" --output text)
curl http://$ALB/
curl http://$ALB/api/hello
```

数分後、AWS コンソールの **X-Ray > Traces / Service map** で
`nextjs-app`（ALB → App → API 内部呼び出し）のトレースが確認できる。

### Prometheus メトリクスの確認（AMP）

ADOT Collector は Node.js のランタイムメトリクス（イベントループ遅延、GC、ヒープ等）を
`prometheusremotewrite` exporter 経由で Amazon Managed Service for Prometheus (AMP) に
送信している。AMP のデータプレーン API は SigV4 署名が必要で、`aws amp` CLI には
メトリクスをクエリするサブコマンドが無いため、`awscurl`（curl 風に SigV4 署名してくれる
ツール）を `uvx` で都度実行して確認する。

```fish
set -x AWS_REGION us-west-2
set -x AMP_WS_ID (aws amp list-workspaces --alias nextjs-otel-amp --query "workspaces[0].workspaceId" --output text)

# 収集されているメトリクス名の一覧
uvx awscurl --service aps --region $AWS_REGION \
  "https://aps-workspaces.$AWS_REGION.amazonaws.com/workspaces/$AMP_WS_ID/api/v1/label/__name__/values"

# 個別メトリクスの現在値（例: イベントループ遅延）
uvx awscurl --service aps --region $AWS_REGION \
  "https://aps-workspaces.$AWS_REGION.amazonaws.com/workspaces/$AMP_WS_ID/api/v1/query?query=nodejs_eventloop_lag_seconds"
```

到達を確認済みの主なメトリクス名: `nodejs_eventloop_*`, `v8js_gc_duration_seconds_*`,
`v8js_memory_heap_*`, `http_server_duration_*`, `http_client_duration_*`, `target_info`。

`uvx awscurl` が使えない環境では、`boto3` で SigV4 署名して `requests` で直接叩く方法でも
確認できる（`uv run --with boto3 --with requests python3 script.py` で実行）。

### 後片付け

```fish
cd infra
npx cdk destroy
```

## ローカルでの動作確認（Docker のみ、OTel なし）

```fish
cd app
npm install
npm run build
docker build -t nextjs-ecs-otel-auto-app .
docker run --rm -p 3000:3000 nextjs-ecs-otel-auto-app
curl http://127.0.0.1:3000/api/hello
```

## 実装上のポイント／ハマりどころ

- **Next.js standalone サーバーの HOSTNAME バインド問題**: `next build` の
  `output: 'standalone'` が生成する `server.js` は `process.env.HOSTNAME` に
  バインドする。Docker はコンテナ起動時に `HOSTNAME` をコンテナ ID に自動設定するため、
  何もしないと `127.0.0.1` ではなくコンテナ自身の IP にしかバインドされず、
  アプリ内部の `127.0.0.1` 宛て `fetch`（`/` → `/api/hello`）が `ECONNREFUSED` になる。
  `Dockerfile` で `ENV HOSTNAME=0.0.0.0` を明示することで解消している
  （ローカルでの Docker 実行と ECS 本番環境の両方で必要）。
- **サンプリング**: デモとして常時トレースを出す `OTEL_TRACES_SAMPLER=always_on` を
  設定している。本番相当にする場合は X-Ray のリモートサンプリングを使う
  （`OTEL_TRACES_SAMPLER=xray` + ADOT Collector 側の `awsproxy` extension が必要）。
- **CDK L2 構成**: init コンテナ・アプリ・Collector サイドカーという 3 コンテナ構成で
  起動順序制御（`containerDependencies`）とボリュームマウントを細かく指定する必要が
  あるため、`aws-ecs-patterns.ApplicationLoadBalancedFargateService` は使わず、
  `ecs.FargateTaskDefinition` + `addContainer` を直接組み立てている。
- **`Cannot execute the operation on ended Span` という警告ログ**: ADOT の Node.js
  自動計装が Next.js 自身の内部トレーシングと二重に span を操作しようとして出る
  既知の無害な警告で、トレース自体は正しくエクスポートされる（ローカル E2E で
  `OTEL_TRACES_EXPORTER=console` を使い、initコンテナ相当の `cp -a` → ボリューム →
  `NODE_OPTIONS` の一連の流れを実機構成で検証し、`/` → `/api/hello` の2ホップが
  同一 traceId で相関することを確認済み）。
- **アーキテクチャ固定**: `ContainerImage.fromAsset` に
  `platform: Platform.LINUX_ARM64` を指定し、`FargateTaskDefinition` にも
  `runtimePlatform: { cpuArchitecture: ARM64 }` を指定している。ビルド環境の
  CPU アーキテクチャに関わらず、常に Graviton（ARM64）向けイメージがビルドされる。
- **App コンテナのヘルスチェックと `NODE_OPTIONS`**: コンテナヘルスチェックの
  コマンドは `docker exec` 相当でコンテナの環境変数を継承するため、素直に
  `node -e "..."` を実行すると、App 本体と同じ `NODE_OPTIONS`
  （`--require .../autoinstrumentation.js`）が毎回のヘルスチェックにも適用されて
  しまう。ヘルスチェックのたびに OTel 自動計装を再ロードするのは無駄なので、
  `NODE_OPTIONS=` でその実行だけ空に上書きしてから `node -e` を呼んでいる。
- **ADOT Collector イメージにはシェルが無い**: `public.ecr.aws/aws-observability/
  aws-otel-collector` イメージには `/bin/sh` が存在しないため、`CMD-SHELL` 形式の
  コンテナヘルスチェックを設定できない（`docker run --entrypoint sh ...` で
  `exec: "sh": executable file not found` になることを確認済み）。そのため
  コンテナヘルスチェックは App コンテナにのみ設定している。
