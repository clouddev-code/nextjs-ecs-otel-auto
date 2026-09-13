# HANDOFF: nextjs-ecs-otel-auto / infra

最終更新: コンテナヘルスチェック・FireLens(Fluent Bit)→S3ログ(Appコンテナのみ)を
`infra/lib/otel-ecs-stack.ts` に実装し `tsc`/`cdk synth` で検証したが、**まだ
`cdk deploy` していない**状態（コンテキスト使用量81%到達のため保存）。

## ⚠️ 重要: ライブ環境とコードの差分（次にやることの最優先事項）

`aws sts get-caller-identity` / `aws cloudformation describe-stacks` /
`aws ecs describe-services` で確認済みの事実:

- スタック `NextjsEcsOtelAutoStack` は **実際に AWS 上にデプロイ済み**
  （account `905860205176`, region `us-west-2`, `StackStatus: UPDATE_COMPLETE`）。
  「デプロイは保留中」という記述が別の `.claude/HANDOFF.md`
  （リポジトリルート直下）に残っているが、それは古い情報。**実際は課金対象リソース
  （NAT Gateway, ALB, Fargateタスク, AMP Workspace 等）が今も稼働中。**
- ECS Service (`nextjs-otel-service`) は `desiredCount:1, runningCount:1` で稼働中。
  `capacityProviderStrategy` は既に `FARGATE_SPOT`（weight:1）になっている
  = **Fargate Spot 化は既にデプロイ・反映済み**。
- 現在デプロイされているタスク定義 (`nextjs-otel-taskdef:3`) のコンテナは
  `OtelInit` / `OtelCollector` / `App` の3つのみで、**`FireLensLogRouter`は
  存在せず、`App`コンテナに`HealthCheck`も設定されていない**
  （`aws ecs describe-task-definition`で実機確認済み）。
  → 今回このセッションでローカルの `infra/lib/otel-ecs-stack.ts` に追加した
    「Appコンテナのヘルスチェック」「FireLens(Fluent Bit)→S3ログ(Appのみ)」は
    **コード変更のみで、まだ `cdk deploy` していない＝ライブ環境には未反映**。
- 次回この作業を引き継ぐ際は、まず
  ```fish
  eval "$(aws configure export-credentials --format env)"  # 認証情報を環境変数化
  cd infra && npx cdk diff
  ```
  でこの差分（FireLensLogRouter追加、Appのlogging変更、healthCheck追加）が
  想定通りであることを確認してから、ユーザーに確認の上 `cdk deploy` すること
  （このプロジェクトの既存ルール：課金リソースを伴う変更は事前にAskUserQuestionで
  確認してからdeployする）。

## ゴール（原文の流れ、全て着手・ほぼ完了）
1. otel設定でmemory_limiterなし・tail samplingを実装したい
   → ユーザー訂正で「memory_limiterあり」に変更。**実装済み・デプロイ済み**
2. ECS Cluster/Service/TaskRole/SecurityGroup/ALB/TargetGroup/TaskExecutionRole/
   TaskDefinition(family) の明示的な名前付け → **全て実装・デプロイ済み**
3. traceだけでなくNode.jsのmetricsもAmazon Managed Prometheus (AMP) に収集したい
   → **実装・デプロイ・実データ到達確認まで完了**

現時点でユーザーからの新規依頼は来ていない。次にメッセージが来たら、まずこのファイルと
直近のやり取りを踏まえて続きを判断すること。

## ステータス: 全項目デプロイ済み・動作確認済み（アカウント905860205176, us-west-2）

- スタック名: `NextjsEcsOtelAutoStack`
- リソース本体: `infra/lib/otel-ecs-stack.ts`
- Collector設定テンプレート: `infra/assets/otel-collector/collector-config.yaml`
- 命名prefix定数: `NAME_PREFIX = 'nextjs-otel'`

### 明示的に命名済みのリソース
| リソース | 名前 |
|---|---|
| ECS Cluster | `nextjs-otel-cluster` |
| ECS Service | `nextjs-otel-service` |
| Security Group (service) | `nextjs-otel-service-sg` |
| IAM Task Role | `nextjs-otel-task-role` |
| IAM Task Execution Role | `nextjs-otel-task-exec-role`（マネージドポリシー手動アタッチなし、CDKが自動付与） |
| TaskDefinition family | `nextjs-otel-taskdef` |
| ALB | `nextjs-otel-alb`（**現在のDNS**: `nextjs-otel-alb-801241176.us-west-2.elb.amazonaws.com`。旧DNSは失効済み） |
| Target Group | `nextjs-otel-tg` |
| AMP Workspace | `nextjs-otel-amp`（workspaceId: `ws-844549e6-4238-454b-8bd3-3597db15d1b4`） |

### Collector設定 (collector-config.yaml) の現状
- extensions: `health_check`, `sigv4auth`（region/serviceはCDKでプレースホルダー置換）
- processors: `memory_limiter`(limit_mib:200, spike_limit_mib:40, check_interval:1s) /
  `resourcedetection` / `tail_sampling`(errors-policy, slow-traces-policy 500ms,
  baseline 10%probabilistic) / `batch/traces` / `batch/metrics`
- exporters: `awsxray`（トレース）, `prometheusremotewrite`（メトリクス、AMPへ、sigv4auth認証）
- pipelines:
  - `traces`: `[otlp]` → `[memory_limiter, resourcedetection, tail_sampling, batch/traces]` → `[awsxray]`
  - `metrics`: `[otlp]` → `[memory_limiter, resourcedetection, batch/metrics]` → `[prometheusremotewrite]`
- OtelCollectorコンテナに `memoryLimitMiB: 256`（ハード制限、memory_limiterの前提）
- YAMLはCDK側で `__AMP_REMOTE_WRITE_ENDPOINT__` / `__AWS_REGION__` プレースホルダーを
  `.split().join()` で置換してからSSM StringParameterに渡している
  （`cdk.Fn.sub`は`${VAR}`構文専用でプレースホルダーと合わないため不採用。
  `replaceAll`はtsconfigのtarget制約でコンパイルエラーになるため`split/join`を使用）

### App側の設定 (`infra/lib/otel-ecs-stack.ts` の appContainer environment)
- `OTEL_TRACES_EXPORTER: 'otlp'`, `OTEL_METRICS_EXPORTER: 'otlp'`（'none'から変更済み）
- `OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc'`, `OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4317'`
  （trace/metrics共通、signal別エンドポイント指定は不要と確認済み）
- **appの依存関係は無変更**（`app/package.json`はOTel非依存のまま）。ADOTの
  `adot-autoinstrumentation-node:v0.12.0` に同梱されている
  `@opentelemetry/instrumentation-host-metrics` / `-runtime-node` が
  `OTEL_METRICS_EXPORTER=otlp` にしただけで有効化され、Node.jsランタイムメトリクス
  （GC/イベントループ/ヒープ等）が自動収集される、と実際にGitHub上のpackage.json
  （`@opentelemetry/auto-instrumentations-node@0.77.0`の依存関係）で確認済み。

### AMP関連のIAM
- taskRoleに `aps:RemoteWrite` を **AMP Workspace ARNのみに絞って** 付与
  （`AmazonPrometheusRemoteWriteAccess`マネージドポリシーは全ワークスペース対象で
  広すぎるため意図的に不採用、カスタムPolicyStatementで実装）

### 動作確認済み（デプロイ後に実施）
- サービス: `Running:1/Desired:1`
- ALB経由: `/`・`/api/hello`ともHTTP 200
- X-Rayトレース: 正常に届いている（`errors-policy`等tail_samplingも動作確認済み、
  不審なスキャナーアクセス`/config.json.orig`の404トレースをX-Rayで確認した実績あり）
- AMPメトリクス: Prometheus HTTP API（SigV4署名、`aws amp`CLIにはクエリ機能がないため
  boto3+requestsで手動署名して確認）で以下のメトリクス名を実際に取得・到達確認済み:
  `nodejs_eventloop_*`, `v8js_gc_duration_seconds_*`, `v8js_memory_heap_*`,
  `http_server_duration_*`, `http_client_duration_*`, `target_info`
  - 確認用スクリプト: `uv run --with boto3 --with requests python3 <script>`で
    `https://aps-workspaces.us-west-2.amazonaws.com/workspaces/{id}/api/v1/label/__name__/values`
    にSigV4署名付きGETを送る方式（AWS CLIに直接のクエリコマンドはない）

## 重要な設計判断・ハマりどころ（再デプロイ時に必ず確認）

1. **AWS認証情報の癖**: `~/.aws/config`の`[default]`プロファイルが独自の`login_session`
   キー形式（標準の`sso_session`/`credential_process`ではない）。`aws` CLIは解決できるが
   Node.js SDK（CDK CLI）は解決できず`Unable to resolve AWS account to use`エラーになる。
   **対策**: `cdk`系コマンドの前に毎回
   ```fish
   for line in (aws configure export-credentials --format env-no-export)
       set -l parts (string split -m 1 "=" -- $line)
       set -gx $parts[1] $parts[2]
   end
   ```
   （bash/Claudeのbashツールなら `eval "$(aws configure export-credentials --format env)"`）
   を実行してから `npx cdk ...` を叩く。SSOセッション失効時は要再ログイン。boto3で
   直接AWS APIを呼ぶ場合も同様にこのeval経由で環境変数を渡す必要がある。

2. **ECS Cluster名・Service名・ALB名・TaskDefinition family名はCloudFormation上immutable**。
   変更すると`replace`（削除→再作成）が発生する。
   - Cluster/Service rename: 実施済み、ダウンタイムほぼなしで成功
   - ALB rename: 実施時に**ハマった** — Target Groupの名前を変えずにALBだけリネームすると、
     「1つのTarget Groupは複数のLoad Balancerに紐付けられない」エラーで自動ロールバックする。
     **対策**: `listener.addTargets()`に`targetGroupName`も明示指定し、TGごと新規リソース化
     することで解決済み。今後同様の変更をする際は要注意。

3. **cdk deployは10分でBashツールがタイムアウトする**（`Exit code 143`）ことがあるが、
   CloudFormation側の処理はAWS上で継続しているので、タイムアウト後は
   `aws cloudformation describe-stacks --query 'Stacks[0].StackStatus'` で実際の状態を
   確認すること（今まで複数回、実際は正常に`UPDATE_COMPLETE`していた）。

4. **危険な操作（置換を伴うリソース変更、新規課金リソース作成）は都度AskUserQuestionで
   確認してからdeployする運用**にしている。今後も同様の変更の前は必ず確認を取ること。

5. **AMP Workspaceへの疎通確認**: `aws amp`CLIにはメトリクスをクエリするサブコマンドが
   存在しない（control-planeのworkspace管理のみ）。データプレーンのPrometheus HTTP API
   （`https://aps-workspaces.{region}.amazonaws.com/workspaces/{id}/api/v1/...`）を
   直接SigV4署名して叩く必要があり、`awscurl`もbotocoreもシステムのpython3には
   入っていなかったため `uv run --with boto3 --with requests python3 script.py` で
   都度環境を作って確認した。

## リポジトリ構成（変更なし）
```
/Users/hiruta/work/nextjs-ecs-otel-auto/
├── app/       Next.js 16 (App Router)。OTel依存は一切含まない
├── infra/     AWS CDK (TypeScript)
│   ├── lib/otel-ecs-stack.ts        スタック本体
│   ├── assets/otel-collector/collector-config.yaml   ADOT Collector設定テンプレート
│   └── bin/app.ts                   env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-west-2' }
├── research/  aws-researcherエージェントによる調査メモ
│   └── ai-ecs-adot-amp-metrics-cdk.md   AMP連携調査の詳細（出典URL含む）
└── README.md
```

## 今回のセッションでの追加変更（未デプロイ、`infra/lib/otel-ecs-stack.ts`）

ユーザー指示1:「Fargate Spotにしておきたい」→ **ただしこれは上記の通り既にライブ環境に
反映済みだった**（過去の別セッションが実施した可能性が高い）。今回のコードにも
`cluster: { enableFargateCapacityProviders: true }` と
`FargateService: { capacityProviderStrategies: [{capacityProvider: 'FARGATE_SPOT', weight: 1}] }`
を追加済みだが、ライブ側と内容は一致しているはずなので `cdk deploy` しても
実質差分は生まないと想定される（要`cdk diff`で確認）。

ユーザー指示2:「container health checkとFluentbitでS3にログ送るようにしておいて」
→ advisorに1回相談（他コンテナ併用のCloudWatch案は不採用、素直なFireLens単一出力を採用）
→ 実装後、ユーザーから「logとるコンテナはappのみであとは要らないです」と追加指示
→ **最終的な実装内容**:

1. **Appコンテナのみコンテナヘルスチェック**を追加:
   ```
   command: ['CMD-SHELL',
     'NODE_OPTIONS= node -e "fetch(\'http://127.0.0.1:3000/api/hello\').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"']
   interval: 30s, timeout: 5s, retries: 3, startPeriod: 30s
   ```
   `NODE_OPTIONS=`でヘルスチェック実行時だけ空にし、OTel自動計装の毎回再ロードを防止。
   `127.0.0.1`を使用（`localhost`だと`::1`解決のリスクがあるためadvisor助言で回避）。
   OtelCollectorには設定していない: `public.ecr.aws/aws-observability/aws-otel-collector`
   イメージには`/bin/sh`が無く`CMD-SHELL`が使えないことを実機確認済み
   （`docker run --entrypoint sh ... aws-otel-collector:v0.50.0` →
   `exec: "sh": executable file not found in $PATH`）。

2. **FireLens (Fluent Bit) → S3、Appコンテナのみ**:
   - 新規コンテナ `FireLensLogRouter`（`taskDefinition.addFirelensLogRouter`,
     image: `public.ecr.aws/aws-observability/aws-for-fluent-bit:2.32.2`。
     `docker manifest inspect`でarm64対応を確認済みのバージョンをピン留め。
     `:stable`のような floating tag は使っていない）。
   - 新規S3バケット `logsBucket`
     （`${NAME_PREFIX}-logs-${account}-${region}`, blockPublicAccess: BLOCK_ALL,
     encryption: S3_MANAGED, removalPolicy: DESTROY, autoDeleteObjects: true）。
   - `logsBucket.grantPut(taskRole)` — **タスクロール**に付与（Fluent Bitはタスク内の
     コンテナとして動くため実行ロールではない点に注意）。
   - Appコンテナの`logging`を`ecs.LogDrivers.firelens({options: {Name: 's3', bucket:
     logsBucket.bucketName, region, total_file_size: '1M', upload_timeout: '1m',
     use_put_object: 'On', compression: 'gzip', s3_key_format:
     '/app/%Y/%m/%d/%H/%M/%S-$UUID'}})`に変更。1MBまたは1分ごとにgzip1オブジェクトで
     `PutObject`（1行ずつのリアルタイム送信ではない）。
   - **OtelInit・OtelCollectorには`logging`を一切設定していない**（意図的、
     ユーザー指示により標準出力はどこにも収集されない）。
   - 既存の`logGroup`（CloudWatch）は`FireLensLogRouter`自身のログ専用に用途変更
     （ログパイプライン自体が壊れた場合の可視性を残すため）。
   - Appコンテナの`dependsOn`に`FireLensLogRouter: START`を追加
     （既存の`OtelInit: SUCCESS`, `OtelCollector: START`に加えて3つ目の条件）。

3. **検証**: `npx tsc --noEmit`・`npx cdk synth`とも成功（infra/ディレクトリで実行）。
   生成テンプレートで`awsfirelens`ドライバがAppのみ1件、OtelInit/OtelCollectorに
   `LogConfiguration`が存在しないこと、`HealthCheck`がAppのみに設定されていること、
   `FirelensConfiguration: {Type: fluentbit}`、S3バケットとタスクロールへの
   `s3:PutObject`系権限、を確認済み。**`cdk deploy`は未実施**（Docker上でのフル
   E2E再実行、およびAWS実機でのS3ログ到達確認もまだ）。

4. README.md（リポジトリルート）も上記に合わせて更新済み
   （アーキテクチャ図に`FireLensLogRouter`追加、「ログ」節新設してApp限定である旨明記、
   「実装上のポイント」にヘルスチェック関連の落とし穴2件追加）。

## `cdk diff` 実施済み・内容確認済み（次はユーザーのdeploy可否の返事待ち）

`eval "$(aws configure export-credentials --format env)"` は**サンドボックス無効化
（`dangerouslyDisableSandbox: true`）が必要**（`~/.aws/login/cache/*.json`読み取りが
通常サンドボックスでは`Operation not permitted`になるため）。これをした上で
`npx cdk diff --no-color` を実行し、差分を確認済み:

- 新規: `LogsBucket`(S3) + バケットポリシー + `autoDeleteObjects`用Lambdaカスタムリソース一式
- `TaskRole`に`s3:PutObject`系権限追加（`LogsBucket`宛て）
- `TaskDefinition`（`may be replaced`と表示されるが、ECS TaskDefinitionは変更のたびに
  新リビジョンが作られる仕様のため実質無害。CloudFormation都合の表示）:
  - `FireLensLogRouter`追加（自身のログのみCloudWatch `firelens`ストリームへ、既存の`logGroup`使用）
  - `OtelInit`・`OtelCollector`: `LogConfiguration`が完全に削除（ログ収集なし、意図通り）
  - `App`: `LogConfiguration`が`awslogs`→`awsfirelens`(S3)、`HealthCheck`追加、
    `dependsOn`に`FireLensLogRouter: START`追加
- Fargate Spot関連の差分は出ていない（＝ライブ環境と一致、既にSpotは反映済みだったと確認できた）
- ユーザーには上記サマリーを提示済み。「otel-init、CWLogsは残っているようです」という
  ユーザーの指摘は、CDKのdiffが`ContainerDefinitions`配列を**位置ベース**で比較したことによる
  表示アーティファクト（新配列index0の`FireLensLogRouter`と旧配列index0の`OtelInit`が
  位置的に重なって`"otel-init"`→`"firelens"`という差し替え表示になっただけ）と説明し、
  ユーザーも納得（「fluentbit containerでした」と返信）。実体は問題なし。

## 未回答の質問（次に返答が来たらここから再開）

ユーザーが`cdk diff`の同じ行（`FireLensLogRouter`の`LogConfiguration: {LogDriver: awslogs,
awslogs-stream-prefix: firelens}`）について再度「残ってませんか」と質問→
これは`OtelInit`ではなく`FireLensLogRouter`自身（Fluent Bit本体）のログで、
「ログ配送の仕組みが壊れた時に気づけるようルーター自身のログだけ残す」という
advisor助言による意図的な設計、と回答済み。その上で
**「これも消してCloudWatchを完全にゼロにするか、現状のまま(ルーター自己診断ログだけ残す)
でよいか」をユーザーに質問し、返答待ちの状態**。

- もし「消してよい」と返答があれば: `fireLensRouter`の
  `logging: ecs.LogDrivers.awsLogs({streamPrefix: 'firelens', logGroup})`を削除
  （`logging`プロパティごと外す）。さらにその場合`logGroup`(ServiceLogGroup)自体が
  完全に不要になるので、CLAUDE.mdの「未使用になったものは残さず削除」方針に従い
  `logs.LogGroup`の宣言ごと削除すること。`npx tsc --noEmit`・`npx cdk synth`で再検証。
- もし「現状のままでよい」と返答があれば: 変更不要、そのまま
  下記TODO 1（`cdk deploy`の可否確認）に進む。
- どちらの返答であっても、その後まだ`cdk deploy`の実行可否の返事もまだ得られていない
  （前回のターンで質問済み・未回答）ので、あわせて確認すること。

## 現時点でのTODO（最優先順）

1. **ユーザーに`cdk deploy`実行の可否を確認中（直前のメッセージで質問済み、返答待ち）**。
   同意が得られたら:
   ```fish
   cd infra
   eval "$(aws configure export-credentials --format env)"  # sandboxを無効化して実行必須
   npx cdk deploy
   ```
   （`cdk deploy`は対話で`y/n`確認が入る場合があるので`--require-approval never`は
   使わず、通常通り実行してよいか都度確認する運用を継続。10分でBashツールが
   タイムアウトすることがあるが、CloudFormation側は継続しているので
   `aws cloudformation describe-stacks --stack-name NextjsEcsOtelAutoStack
   --query 'Stacks[0].StackStatus'`で状態を確認すること）。
2. デプロイ後: S3バケット（`logsBucket`）にAppコンテナのログが実際に届くか、
   ECSコンソール/`aws ecs describe-tasks`でAppコンテナの`healthStatus: HEALTHY`を確認する。
3. それ以外の新規依頼が来ればそちらを優先。
