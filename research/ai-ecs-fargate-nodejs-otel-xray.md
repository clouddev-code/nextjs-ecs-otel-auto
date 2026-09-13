# Next.js on ECS Fargate: OpenTelemetry Node.js自動計装とADOT CollectorによるX-Rayトレーシング

## ADOT Node.js自動計装イメージ

AWSはJavaと同様に、Node.js向けの公式ADOT自動計装イメージを公開している。イメージURIは `public.ecr.aws/aws-observability/adot-autoinstrumentation-node` で、ソースは [aws-observability/aws-otel-js-instrumentation](https://github.com/aws-observability/aws-otel-js-instrumentation) リポジトリである。同リポジトリはリリースのたびに（例: v0.12.0, 2025-06-30）このイメージとnpmパッケージ `@aws/aws-distro-opentelemetry-node-autoinstrumentation` を公開している。

Javaイメージ（`public.ecr.aws/aws-observability/adot-autoinstrumentation-java:v1.31.1`）が `/javaagent.jar` を1ファイルだけ含むのに対し、Nodeイメージは `/autoinstrumentation` ディレクトリ配下に計装ライブラリ一式を含む。重要な点として、このイメージにはファイルを自動コピーするENTRYPOINTは焼き込まれていない。Kubernetes版（OpenTelemetry Operator）ではOperatorがinitContainerに `command` を注入するが、ECSでは自分でコンテナ定義の `command` にコピーコマンドを明示する必要がある。AWS公式ドキュメント（CloudWatch Application Signals ECS sidecarガイド）に記載されている確定パターンは以下の通り。

```json
{
  "name": "init",
  "image": "public.ecr.aws/aws-observability/adot-autoinstrumentation-node:<version>",
  "essential": false,
  "command": ["cp", "-a", "/autoinstrumentation/.", "/otel-auto-instrumentation-node"],
  "mountPoints": [
    { "sourceVolume": "opentelemetry-auto-instrumentation-node", "containerPath": "/otel-auto-instrumentation-node", "readOnly": false }
  ]
}
```

コピー後、アプリコンテナ側で設定する `NODE_OPTIONS` の値は次の通りで固定である。

```
NODE_OPTIONS=--require /otel-auto-instrumentation-node/autoinstrumentation.js
```

なお、マウントパス名（`otel-auto-instrumentation-node`）はボリューム名・コンテナパスと一致させる必要があるが、任意の名前を選べる。upstreamのOpenTelemetry Operator用イメージ `otel/autoinstrumentation-nodejs`（k8s向け、AWS非公式）も同一の `/autoinstrumentation` ソースパスと `cp -a` パターンを使っており、Operatorが自動生成する場合は `/otel-auto-instrumentation-nodejs/autoinstrumentation.js` というパスがデフォルトになる。ECSでは自分でパスを決められるため、上記AWS公式ガイドの値をそのまま踏襲するのが安全である。

ESM形式のNext.jsアプリ（App Routerでも通常はCommonJS方式のNode.js起動になるためinitコンテナ方式で問題ないが、`"type": "module"` を使う場合）は、この init コンテナ方式は使えない。代わりに `npm install @aws/aws-distro-opentelemetry-node-autoinstrumentation` をアプリに直接依存させ、`NODE_OPTIONS="--import @aws/aws-distro-opentelemetry-node-autoinstrumentation/register --experimental-loader=@opentelemetry/instrumentation/hook.mjs"` を設定する。この場合ボリューム共有もinitコンテナも不要になる。

## Fargateタスクでのコンテナ間ボリューム共有（CDK）

ECSのボリューム定義で `host` プロパティを省略すると、Dockerデーモンがタスクスコープのエフェメラルなパスを自動割り当てする「host未指定のbind mount」になる。これはFargateでもサポートされており（AWS公式ドキュメント: "If the host parameter is empty, then the Docker daemon assigns a host path for your data volume, but the data is not guaranteed to persist after the containers associated with it stop running"）、まさに今回のinitコンテナ→アプリコンテナ間でファイルを渡すユースケースに合致する。`sourcePath` はEC2起動タイプ専用のパラメータであり、Fargateでは使用できない（指定しないこと）。

CDK（TypeScript）では `ecs.Volume` のうち `name` のみを指定し、`host` は省略する。

```ts
const taskDefinition = new ecs.FargateTaskDefinition(this, "TaskDef", {
  cpu: 512,
  memoryLimitMiB: 1024,
  volumes: [{ name: "otel-auto-instrumentation-node" }],
});

const initContainer = taskDefinition.addContainer("OtelInit", {
  image: ecs.ContainerImage.fromRegistry(
    "public.ecr.aws/aws-observability/adot-autoinstrumentation-node:v0.12.0"
  ),
  essential: false,
  command: ["cp", "-a", "/autoinstrumentation/.", "/otel-auto-instrumentation-node"],
});
initContainer.addMountPoints({
  sourceVolume: "otel-auto-instrumentation-node",
  containerPath: "/otel-auto-instrumentation-node",
  readOnly: false,
});

const appContainer = taskDefinition.addContainer("App", {
  image: ecs.ContainerImage.fromEcrRepository(repo, tag),
  essential: true,
  environment: {
    NODE_OPTIONS: "--require /otel-auto-instrumentation-node/autoinstrumentation.js",
  },
});
appContainer.addMountPoints({
  sourceVolume: "otel-auto-instrumentation-node",
  containerPath: "/otel-auto-instrumentation-node",
  readOnly: false,
});
appContainer.addContainerDependencies({
  container: initContainer,
  condition: ecs.ContainerDependencyCondition.SUCCESS,
});
```

`ContainerDependencyCondition` は `START` / `COMPLETE` / `SUCCESS` / `HEALTHY` の4種類が存在する。ファイルコピーのようなワンショットタスクでは、終了コード0を要求する `SUCCESS` が `COMPLETE` より安全である（`COMPLETE` は異常終了でも条件を満たしてしまう）。`essential: false` は `COMPLETE` / `SUCCESS` 条件を使う前提条件であり、必須コンテナには設定できない。

Fargate固有の注意点は次の2つに整理できる。1つ目は、`dependsOn`（コンテナ依存関係）を使うにはプラットフォームバージョン1.3.0以降（Linux）が必要という点で、CDKのデフォルト（`LATEST`）であれば問題にならないが、明示的に古いバージョンを固定している場合は確認が必要である。2つ目は、`ephemeralStorage`（タスクの合計エフェメラルストレージ拡張）を使う場合はプラットフォームバージョン1.4.0以降が必要という点で、今回のボリューム共有自体には無関係だが、大きな計装ファイルやアプリのビルド成果物でタスクのデフォルトストレージ（20GiB）を圧迫する場合に関係してくる。

## ADOT CollectorとX-Rayエクスポート設定

ADOT Collectorの公式イメージは `public.ecr.aws/aws-observability/aws-otel-collector` で、2026年9月時点の最新版は v0.50.0 系である（[aws-otel-collector GitHub Releases](https://github.com/aws-observability/aws-otel-collector/releases)）。本番運用では `:latest` ではなく特定バージョンタグを固定することを推奨する。

OTLP（gRPC/HTTP）を受け取りX-Rayへエクスポートする最小構成は、AWS公式リポジトリの `config/ecs/ecs-xray.yaml` を踏襲すると次の内容になる。

```yaml
extensions:
  health_check:

receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch/traces:
    timeout: 1s
    send_batch_size: 50
  resourcedetection:
    detectors: [env, system, ecs, ec2]

exporters:
  awsxray:

service:
  extensions: [health_check]
  pipelines:
    traces:
      receivers: [otlp]
      processors: [resourcedetection, batch/traces]
      exporters: [awsxray]
```

`awsxray` エクスポーターは追加設定なしでOTLP形式のスパンをX-Ray形式に変換して送信する。このYAMLをSSM Parameter Storeに保存し、ADOT Collectorコンテナの起動コマンド（`--config=/path/to/config.yaml`、またはSSM経由なら環境変数 `AOT_CONFIG_CONTENT` 相当の仕組み）で読み込ませるのが一般的な運用パターンである。

X-Rayへの書き込みに必要なIAM権限は、タスクロール（実行ロールではない）に付与する。AWS管理ポリシー `AWSXRayDaemonWriteAccess`（ARN: `arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess`）が許可するアクションは次の5つである。

```json
{
  "Effect": "Allow",
  "Action": [
    "xray:PutTraceSegments",
    "xray:PutTelemetryRecords",
    "xray:GetSamplingRules",
    "xray:GetSamplingTargets",
    "xray:GetSamplingStatisticSummaries"
  ],
  "Resource": ["*"]
}
```

CDKでは `taskDefinition.taskRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName("AWSXRayDaemonWriteAccess"))` で付与できる。トレース送信のみであれば `PutTraceSegments` と `PutTelemetryRecords` の2つが本質的に必要な権限で、残り3つはX-Rayのリモートサンプリングルール取得用である。

## Node.js OTel SDKの環境変数

X-Rayとの互換性を得るには、トレースIDの先頭8バイトをUnixタイムスタンプにするX-Ray準拠のID生成（`AWSXRayIdGenerator`）と、X-Ray形式のトレースコンテキスト伝播（`AWSXRayPropagator`）が必要になる。これらは環境変数だけでは設定できない項目で、素のOpenTelemetry Node SDKを使う場合はコード側で `new NodeSDK({ textMapPropagator: new AWSXRayPropagator(), ... })` のように明示的に組み込む必要がある（AWS公式ドキュメント: "AWS X-Ray Remote Sampling is currently not available to be configured for OpenTelemetry JS. However, support for X-Ray Remote Sampling is currently available through the ADOT Auto-Instrumentation for Node.js"）。

今回採用するADOT Node.js自動計装（`autoinstrumentation.js`）は、この点を解決するために存在する。ADOTの `register.ts` はデフォルトで `OTEL_PROPAGATORS` が未設定の場合に `baggage,xray,tracecontext` を自動設定し、X-Ray用のプロパゲータとID生成をあらかじめ組み込んでいる。したがって、環境変数だけで完結させたい場合はADOTイメージ経由の自動計装を使うのが唯一の現実的な選択肢であり、ユーザーが個別に指定する `AWS_XRAY_ID_GENERATOR` や `OTEL_AWS_XRAY_ID_GENERATOR` のような環境変数は存在しない。

アプリコンテナに設定すべき環境変数は次の通りである。

```json
[
  { "name": "NODE_OPTIONS", "value": "--require /otel-auto-instrumentation-node/autoinstrumentation.js" },
  { "name": "OTEL_SERVICE_NAME", "value": "nextjs-app" },
  { "name": "OTEL_TRACES_EXPORTER", "value": "otlp" },
  { "name": "OTEL_EXPORTER_OTLP_PROTOCOL", "value": "grpc" },
  { "name": "OTEL_EXPORTER_OTLP_ENDPOINT", "value": "http://localhost:4317" },
  { "name": "OTEL_PROPAGATORS", "value": "tracecontext,baggage,xray" },
  { "name": "OTEL_TRACES_SAMPLER", "value": "xray" },
  { "name": "OTEL_TRACES_SAMPLER_ARG", "value": "endpoint=http://localhost:2000" }
]
```

`OTEL_EXPORTER_OTLP_PROTOCOL` は `grpc`（Collectorのgrpcレシーバ、ポート4317）と `http/protobuf`（httpレシーバ、ポート4318、パスは `/v1/traces` を含める必要がある）のどちらも選べるが、ADOTのデフォルトは `http/protobuf` である点に注意する。純粋にADOT Collector経由でX-Rayへ送るだけの構成であれば `OTEL_TRACES_SAMPLER=xray` と `OTEL_TRACES_SAMPLER_ARG` によるX-Rayリモートサンプリングは必須ではなく、省略して `parentbased_always_on`（ADOTのデフォルト）のままでも動作する。CloudWatch Application Signalsを使わない今回の要件では、`OTEL_AWS_APPLICATION_SIGNALS_ENABLED` や `OTEL_METRICS_EXPORTER=awsemf` は不要であり、むしろ明示的に `OTEL_METRICS_EXPORTER=none` としてメトリクス送信を無効化しておくと、X-Rayエクスポートのみに絞った構成として意図が明確になる。

## CDK L2コンストラクトの選定

`aws-ecs-patterns.ApplicationLoadBalancedFargateService` は、コンストラクト生成後に `service.taskDefinition.addContainer()` を呼び出すことでサイドカーコンテナを追加できる。ただし、この構成には2つの制約がある。1つ目は、`taskImageOptions` で作成されるメインコンテナのCPU/メモリはタスク全体の値がそのまま割り当てられ、後からサイドカーを追加すると合計が超過しやすいという点である。2つ目は、initコンテナのような `essential: false` かつ `containerDependencies` を要する構成は `taskImageOptions` の型に用意されておらず、結局L1相当の `addContainer` / `addContainerDependencies` を後付けする必要がある点である。

今回のようにinitコンテナ・アプリコンテナ・ADOT Collectorサイドカーの3コンテナで構成し、かつコンテナ間の起動順序制御（`containerDependencies`）とボリュームマウントを細かく指定する必要がある場合は、`ApplicationLoadBalancedFargateService` のようなL3パターンを部分的に迂回して使うより、最初から `ecs.FargateTaskDefinition` + `addContainer` の組み合わせ（L2）で構築する方が構成の見通しがよく、CPU/メモリ配分やヘルスチェック、ロードバランサー統合（`ApplicationLoadBalancer` + `ApplicationTargetGroup` + `FargateService` を個別に組み立てる）を含めて全体を制御しやすい。

## 参考リンク

- [ADOT Node.js auto-instrumentation image (ECR Public Gallery)](https://gallery.ecr.aws/aws-observability/adot-autoinstrumentation-node)
- [ADOT Java auto-instrumentation image (ECR Public Gallery)](https://gallery.ecr.aws/aws-observability/adot-autoinstrumentation-java)
- [aws-observability/aws-otel-js-instrumentation (GitHub)](https://github.com/aws-observability/aws-otel-js-instrumentation)
- [Deploy Application Signals using the sidecar strategy on Amazon ECS (AWS公式)](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-Application-Signals-ECS-Sidecar.html)
- [Amazon ECS task definition parameters for Fargate](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html)
- [aws-otel-collector ECS X-Ray config (ecs-xray.yaml)](https://github.com/aws-observability/aws-otel-collector/blob/main/config/ecs/ecs-xray.yaml)
- [ADOT Collector image (ECR Public Gallery)](https://gallery.ecr.aws/aws-observability/aws-otel-collector)
- [AWSXRayDaemonWriteAccess managed policy](https://docs.aws.amazon.com/aws-managed-policy/latest/reference/AWSXRayDaemonWriteAccess.html)
- [Migrate to OpenTelemetry Node.js (AWS X-Ray Developer Guide)](https://docs.aws.amazon.com/xray/latest/devguide/migrate-xray-to-opentelemetry-nodejs.html)
- [CDK ContainerDefinition API reference](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ecs.ContainerDefinition.html)
