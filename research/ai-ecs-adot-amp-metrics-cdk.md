# ECS Fargate上のADOT CollectorからAmazon Managed Service for Prometheusへメトリクス送信する構成のCDK調査

本調査は、ECS Fargate上のNode.jsアプリのメトリクスをADOT Collector（`public.ecr.aws/aws-observability/aws-otel-collector:v0.50.0`）経由でAmazon Managed Service for Prometheus（AMP）へremote writeする構成を、AWS CDK（TypeScript）で追加するための技術調査である。

## 調査結果サマリー

主要な調査結果は以下の5点である。

- AMP Workspace用のL2コンストラクトはaws-cdk-libに存在しない。`aws-cdk-lib/aws-aps`のL1 `CfnWorkspace`を直接使う必要がある。
- ADOT CollectorからAMPへのメトリクス送信は、`prometheusremotewrite` exporterと`sigv4auth` extensionの組み合わせが標準（AWS公式ドキュメントもこの構成を採用）であり、両コンポーネントはv0.50.0にも同梱されている。
- remote write専用のマネージドポリシー`AmazonPrometheusRemoteWriteAccess`が実在し、許可アクションは`aps:RemoteWrite`のみである。
- AMP用のInterface VPCエンドポイントは存在する（`aps`と`aps-workspaces`の2種）が、remote writeエンドポイントはパブリックエンドポインであり、NAT Gateway経由のインターネットegressでも到達可能である。
- ADOT Node.js auto-instrumentationはOTLPエクスポーターの既定送信先が`http://localhost:4318`であることは公式ドキュメントで確認できたが、`OTEL_METRICS_EXPORTER`等の個別環境変数の既定値、およびNode.jsランタイムメトリクスのデフォルト収集有無については、公式ドキュメントに明記が見当たらず「不明」とする。

## 1. AMP WorkspaceをCDKで作成する方法

### L2コンストラクトの有無

`aws-cdk-lib/aws-aps`モジュールを確認したところ、含まれるクラスは`CfnWorkspace` / `CfnRuleGroupsNamespace` / `CfnAnomalyDetector`のいずれも`Cfn`プレフィックス付き（L1コンストラクト）であり、L2コンストラクトは**存在しない**。AMP Workspaceを作成する場合はL1の`CfnWorkspace`を直接扱う必要がある。

### L1 CfnWorkspaceのモジュールパスと主要プロパティ

モジュールパスは`aws-cdk-lib/aws-aps`（TypeScript import例: `import { aws_aps as aps } from 'aws-cdk-lib';`）である。

`CfnWorkspace`の主要プロパティ（すべて省略可能）は以下のとおりである。

- `alias`: ワークスペースの識別用エイリアス（string、最大100文字）。
- `kmsKeyArn`: 保存データ暗号化に使うカスタマー管理KMSキーのARN（省略時はAWS管理キー）。
- `loggingConfiguration`: ルール評価ログなどの出力先CloudWatch Logsロググループを指定する`LoggingConfigurationProperty`（`logGroupArn`を持つ）。
- `alertManagerDefinition`: Alertmanager設定を文字列で指定。
- `queryLoggingConfiguration` / `workspaceConfiguration`: クエリロギングや、ラベルセットごとのインジェスト上限・保持期間を設定する追加プロパティ（新しいCDKバージョンで追加）。
- `tags`: タグの配列（`CfnTag[]`）。

### ARN・remote writeエンドポイントの取得方法

`CfnWorkspace`インスタンスの属性（Fn::GetAtt相当）として以下が公式に定義されている。

- `attrArn`: ワークスペースのARN（例: `arn:aws:aps:<region>:123456789012:workspace/ws-xxxx`）。
- `attrPrometheusEndpoint`: remote write/queryに使うPrometheus互換エンドポイントのベースURL（例: `https://aps-workspaces.<region>.amazonaws.com/workspaces/ws-xxxx/api/v1/`）。実際のremote write URLはこの末尾に`remote_write`を付与した形になる。
- `attrWorkspaceId`: ワークスペースの一意ID（例: `ws-xxxx`）。

情報源:
- https://constructs.dev/packages/aws-cdk-lib/v/2.269.0/api/CfnWorkspace?lang=typescript&submodule=aws_aps
- https://docs.aws.amazon.com/cdk/api/v1/python/aws_cdk.aws_aps/CfnWorkspace.html

## 2. ADOT CollectorからAMPへのメトリクス送信方式

### 標準的な方式の確認

AWS公式ドキュメント「Set up metrics ingestion from Amazon ECS using AWS Distro for Open Telemetry」では、`prometheusremotewrite` exporterと`sigv4auth` extensionを組み合わせる構成がそのまま提示されており、これが標準的な方式であることを確認した。`sigv4auth`はAMPへのHTTPリクエストにAWS SigV4署名を付与するためのextensionである。

### v0.50.0への同梱有無

`aws-observability/aws-otel-collector`リポジトリの`v0.50.0`タグ時点のREADME（Built-in Components一覧）を確認したところ、以下の両方が明記されていた。

- Exporter一覧: `prometheusremotewriteexporter`
- Extension一覧: `sigv4authextension`

したがって、既定のADOT Collectorイメージ`v0.50.0`にこれら2コンポーネントは同梱されており、追加ビルドは不要である。

### AWS公式サンプルcollector-config.yaml（ECS向け）

AWS公式ドキュメントに掲載されているECS向けサンプル設定は以下のとおり（`my-remote-URL`・`my-region`はプレースホルダー）。

```yaml
receivers:
  prometheus:
    config:
      global:
        scrape_interval: 15s
        scrape_timeout: 10s
      scrape_configs:
        - job_name: "prometheus"
          static_configs:
            - targets: [ 0.0.0.0:9090 ]
  awsecscontainermetrics:
    collection_interval: 10s
processors:
  filter:
    metrics:
      include:
        match_type: strict
        metric_names:
          - ecs.task.memory.utilized
          - ecs.task.memory.reserved
          - ecs.task.cpu.utilized
          - ecs.task.cpu.reserved
          - ecs.task.network.rate.rx
          - ecs.task.network.rate.tx
          - ecs.task.storage.read_bytes
          - ecs.task.storage.write_bytes
exporters:
  prometheusremotewrite:
    endpoint: my-remote-URL
    auth:
      authenticator: sigv4auth
  logging:
    loglevel: info
extensions:
  health_check:
  pprof:
    endpoint: :1888
  zpages:
    endpoint: :55679
  sigv4auth:
    region: my-region
    service: aps
service:
  extensions: [pprof, zpages, health_check, sigv4auth]
  pipelines:
    metrics:
      receivers: [prometheus]
      exporters: [logging, prometheusremotewrite]
    metrics/ecs:
      receivers: [awsecscontainermetrics]
      processors: [filter]
      exporters: [logging, prometheusremotewrite]
```

自前のOTLP受信パイプラインに組み込む場合は、`otlp`レシーバーで受けたメトリクスを`prometheusremotewrite` exporter（`auth.authenticator: sigv4auth`）に流すpipelineを追加し、`endpoint`には`CfnWorkspace.attrPrometheusEndpoint + "remote_write"`を設定する形になる。既存のトレース用パイプライン（`memory_limiter`/`resourcedetection`/`tail_sampling`/`batch` → `awsxray`）とは独立した`metrics`パイプラインとして追加すればよい。

情報源:
- https://docs.aws.amazon.com/prometheus/latest/userguide/AMP-onboard-ingest-metrics-OpenTelemetry-ECS.html
- https://github.com/aws-observability/aws-otel-collector/blob/v0.50.0/README.md

## 3. IAMパーミッション

### 必要なIAMアクション

remote writeにはAPI操作`aps:RemoteWrite`のみが必要である。

### AmazonPrometheusRemoteWriteAccess マネージドポリシー

実在する。詳細は以下のとおり。

- 正式名称: `AmazonPrometheusRemoteWriteAccess`
- ARN: `arn:aws:iam::aws:policy/AmazonPrometheusRemoteWriteAccess`
- ポリシー内容: `aps:RemoteWrite`を`Resource: "*"`に対して許可するのみ（書き込み専用、クエリ等は許可しない）。

ECSタスクロール（remote writeを行うADOT Collectorサイドカーが引き受けるタスクロール）にこのマネージドポリシーをアタッチすれば要件を満たす。特定ワークスペースのみに絞りたい場合は、同等のカスタムポリシーで`Resource`をワークスペースARN（`attrArn`）に限定すればよい。

情報源:
- https://docs.aws.amazon.com/aws-managed-policy/latest/reference/AmazonPrometheusRemoteWriteAccess.html

## 4. ネットワーク到達性

### VPC Interfaceエンドポイントの有無とサービス名

AMP向けのInterface VPCエンドポイントは存在し、用途別に2種類ある。

- `com.amazonaws.<region>.aps-workspaces`: remote write／クエリなど、Prometheus互換APIへのデータプレーンアクセス用。
- `com.amazonaws.<region>.aps`: ワークスペースの作成・削除などコントロールプレーン（管理API）用。

remote writeで使うのは`aps-workspaces`側である。

### CDKのInterfaceVpcEndpointAwsServiceの対応定数

`aws-cdk-lib/aws-ec2`の`InterfaceVpcEndpointAwsService`列挙体に以下の定数が存在することを確認した。

- `InterfaceVpcEndpointAwsService.PROMETHEUS`: コントロールプレーン用（`aps`）に対応。
- `InterfaceVpcEndpointAwsService.PROMETHEUS_WORKSPACES`: データプレーン（remote write／クエリ、`aps-workspaces`）用に対応。

remote write専用でVPCエンドポイントを追加するなら`PROMETHEUS_WORKSPACES`を使用する。

### NAT Gateway経由（VPCエンドポイントなし）での到達可否

AMPのremote writeエンドポイント（`https://aps-workspaces.<region>.amazonaws.com/...`）は**パブリックエンドポイント**であり、VPC Interfaceエンドポイント（PrivateLink）はインターネットを経由せずに閉域接続したい場合のオプションという位置づけである。したがって、既存VPCがprivate subnet + NAT Gateway 1つでインターネットegress可能な構成であれば、セキュリティグループ／NACLがHTTPS(443)アウトバウンドを許可している限り、VPCエンドポイントなしでもNAT経由でAMPのremote writeエンドポインドに到達可能である。全通信を閉域化したい、あるいはNAT Gatewayのデータ処理料金を削減したい場合にのみ、VPCエンドポイント追加を検討すればよい。

情報源:
- https://docs.aws.amazon.com/prometheus/latest/userguide/AMP-and-interface-VPC.html
- https://constructs.dev/packages/aws-cdk-lib/v/2.269.0/api/InterfaceVpcEndpointAwsService?lang=typescript&submodule=aws_ec2

## 5. Node.js側の設定

### メトリクス送信に必要な環境変数

AWS公式ドキュメント「Tracing and Metrics with the AWS Distro for OpenTelemetry JavaScript Auto-Instrumentation」によれば、`@aws/aws-distro-opentelemetry-node-autoinstrumentation`は既定でOTLPエクスポーターを使用し、送信先は`http://localhost:4318`（トレース・メトリクス共通）である。同ページで明示的に説明されている環境変数は`NODE_OPTIONS`（auto-instrumentationの起動用）、`OTEL_TRACES_SAMPLER`／`OTEL_TRACES_SAMPLER_ARG`（サンプリング設定）にとどまり、`OTEL_METRICS_EXPORTER`や`OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`の既定値についての明記は確認できなかった（**不明**）。

OpenTelemetry標準仕様上は`OTEL_METRICS_EXPORTER`の既定値は`otlp`、`OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`未指定時は`OTEL_EXPORTER_OTLP_ENDPOINT`（既定`http://localhost:4318`）に`/v1/metrics`を付与した値が使われるのが一般的な挙動だが、これはOpenTelemetry本体の仕様に基づく推測であり、ADOT JS auto-instrumentation固有の挙動としてAWS公式ドキュメントで直接確認はできていない（**不明**）。コレクター側のOTLP受信ポートを4318（HTTP）または4317（gRPC）に合わせ、必要に応じて`OTEL_EXPORTER_OTLP_ENDPOINT`をコレクターのサイドカーアドレスに明示的に設定することを推奨する。

### Node.js標準ランタイムメトリクスのデフォルト収集有無

AWS公式ドキュメント（ADOT JS auto-instrumentationページ）には、プロセスメモリ／GC／イベントループ等のNode.jsランタイムメトリクスがデフォルトで収集されるかどうかについての記載が見当たらず、**不明**である。

### 追加npmパッケージの要否

OpenTelemetry JS公式リポジトリの情報によると、Node.jsランタイムメトリクス（CPU・メモリ・イベントループ等）の収集は`@opentelemetry/instrumentation-host-metrics`が担う。この機能は`@opentelemetry/auto-instrumentations-node`バンドルに含まれるが**既定では無効**であり、有効化するには環境変数`OTEL_NODE_ENABLED_INSTRUMENTATIONS`にホストメトリクス計装を明示的に含める必要がある。なお旧パッケージ`@opentelemetry/host-metrics`は非推奨（deprecated）であり、新規導入では`@opentelemetry/instrumentation-host-metrics`系を使うことが推奨されている。

ADOT JS auto-instrumentationがこの`auto-instrumentations-node`バンドルをベースにしているかどうかは今回のAWS公式ドキュメント調査だけでは断定できなかった（**不明**）ため、実装時にはADOT JS auto-instrumentationの依存関係を確認し、ホストメトリクス計装が無効な場合は明示的な有効化設定、または別途`@opentelemetry/instrumentation-host-metrics`の手動登録を検討する必要がある。

情報源:
- https://aws-otel.github.io/docs/getting-started/js-sdk/trace-metric-auto-instr/
- https://www.npmjs.com/package/@opentelemetry/host-metrics
- https://github.com/open-telemetry/opentelemetry-js-contrib/tree/main/packages/instrumentation-host-metrics

## 参考リンク

- [CfnWorkspace (aws-cdk-lib.aws_aps)](https://constructs.dev/packages/aws-cdk-lib/v/2.269.0/api/CfnWorkspace?lang=typescript&submodule=aws_aps)
- [CreateWorkspace API Reference (Amazon Managed Service for Prometheus)](https://docs.aws.amazon.com/prometheus/latest/APIReference/API_CreateWorkspace.html)
- [Set up metrics ingestion from Amazon ECS using AWS Distro for Open Telemetry](https://docs.aws.amazon.com/prometheus/latest/userguide/AMP-onboard-ingest-metrics-OpenTelemetry-ECS.html)
- [aws-observability/aws-otel-collector README（v0.50.0タグ）](https://github.com/aws-observability/aws-otel-collector/blob/v0.50.0/README.md)
- [AmazonPrometheusRemoteWriteAccess managed policy](https://docs.aws.amazon.com/aws-managed-policy/latest/reference/AmazonPrometheusRemoteWriteAccess.html)
- [Using Amazon Managed Service for Prometheus with interface VPC endpoints](https://docs.aws.amazon.com/prometheus/latest/userguide/AMP-and-interface-VPC.html)
- [InterfaceVpcEndpointAwsService (aws-cdk-lib.aws_ec2)](https://constructs.dev/packages/aws-cdk-lib/v/2.269.0/api/InterfaceVpcEndpointAwsService?lang=typescript&submodule=aws_ec2)
- [Tracing and Metrics with the AWS Distro for OpenTelemetry JavaScript Auto-Instrumentation](https://aws-otel.github.io/docs/getting-started/js-sdk/trace-metric-auto-instr/)
- [@opentelemetry/host-metrics (npm)](https://www.npmjs.com/package/@opentelemetry/host-metrics)
