import * as fs from 'node:fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as aps from 'aws-cdk-lib/aws-aps';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

const ADOT_NODE_AUTOINSTRUMENTATION_IMAGE =
  'public.ecr.aws/aws-observability/adot-autoinstrumentation-node:v0.12.0';
const ADOT_COLLECTOR_IMAGE = 'public.ecr.aws/aws-observability/aws-otel-collector:v0.50.0';
const FLUENT_BIT_IMAGE = 'public.ecr.aws/aws-observability/aws-for-fluent-bit:2.32.2';

const OTEL_VOLUME_NAME = 'otel-auto-instrumentation-node';
const OTEL_MOUNT_PATH = '/otel-auto-instrumentation-node';

const NAME_PREFIX = 'nextjs-otel';

// Substituted into collector-config.yaml at synth time -- the AMP workspace's remote
// write endpoint and the stack region aren't known until the CfnWorkspace is declared.
const AMP_ENDPOINT_PLACEHOLDER = '__AMP_REMOTE_WRITE_ENDPOINT__';
const AWS_REGION_PLACEHOLDER = '__AWS_REGION__';

export class OtelEcsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      // Single, regional NAT Gateway shared by every AZ's private subnet (not one per AZ) --
      // still required because the ADOT images are pulled from public.ecr.aws, which has
      // no VPC endpoint and therefore needs internet egress.
      natGateways: 1,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
    });

    // Gateway endpoint for S3 -- ECR stores image layers in S3, so pulling the private
    // "App" image from private subnets goes through this instead of the NAT Gateway.
    vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    // Interface endpoints so the AWS API calls the task makes (image pull, SSM parameter
    // read for the collector config, X-Ray trace export) stay on AWS PrivateLink instead
    // of routing out through the NAT Gateway.
    const interfaceEndpoints: [string, ec2.InterfaceVpcEndpointAwsService][] = [
      ['EcrApiEndpoint', ec2.InterfaceVpcEndpointAwsService.ECR],
      ['EcrDkrEndpoint', ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER],
      ['SsmEndpoint', ec2.InterfaceVpcEndpointAwsService.SSM],
      ['XRayEndpoint', ec2.InterfaceVpcEndpointAwsService.XRAY],
    ];
    for (const [id, service] of interfaceEndpoints) {
      vpc.addInterfaceEndpoint(id, { service });
    }

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      clusterName: `${NAME_PREFIX}-cluster`,
      containerInsights: true,
      enableFargateCapacityProviders: true,
    });

    const serviceSecurityGroup = new ec2.SecurityGroup(this, 'ServiceSecurityGroup', {
      vpc,
      securityGroupName: `${NAME_PREFIX}-service-sg`,
      description: 'Security group for the Next.js/OTel Fargate service',
      allowAllOutbound: true,
    });

    const ampWorkspace = new aps.CfnWorkspace(this, 'AmpWorkspace', {
      alias: `${NAME_PREFIX}-amp`,
    });

    const taskRole = new iam.Role(this, 'TaskRole', {
      roleName: `${NAME_PREFIX}-task-role`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    taskRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AWSXRayDaemonWriteAccess')
    );
    // Scoped to this workspace only, rather than the broader AmazonPrometheusRemoteWriteAccess
    // managed policy (which allows RemoteWrite to every AMP workspace in the account).
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['aps:RemoteWrite'],
        resources: [ampWorkspace.attrArn],
      })
    );

    // CDK grants this role exactly what each container needs (ECR pull, log group write,
    // SSM parameter read for AOT_CONFIG_CONTENT) as addContainer()/addLogging()/secrets
    // are wired up below -- no need to attach AmazonECSTaskExecutionRolePolicy by hand.
    const taskExecutionRole = new iam.Role(this, 'TaskExecutionRole', {
      roleName: `${NAME_PREFIX}-task-exec-role`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    const collectorConfigTemplate = fs.readFileSync(
      path.join(__dirname, '..', 'assets', 'otel-collector', 'collector-config.yaml'),
      'utf-8'
    );
    const collectorConfigParam = new ssm.StringParameter(this, 'OtelCollectorConfig', {
      description: 'ADOT Collector config: OTLP -> AWS X-Ray (traces) / AMP (metrics)',
      stringValue: collectorConfigTemplate
        .split(AMP_ENDPOINT_PLACEHOLDER)
        .join(`${ampWorkspace.attrPrometheusEndpoint}api/v1/remote_write`)
        .split(AWS_REGION_PLACEHOLDER)
        .join(this.region),
    });

    // The App container's logs go to S3 via the FireLens/Fluent Bit sidecar below (including
    // the router's own logs -- no CloudWatch Logs usage anywhere in this stack).
    const logsBucket = new s3.Bucket(this, 'LogsBucket', {
      bucketName: `${NAME_PREFIX}-logs-${this.account}-${this.region}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
    });
    // Fluent Bit runs as a container in the task and uploads under the task role's
    // credentials, not the execution role's.
    logsBucket.grantPut(taskRole);

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      family: `${NAME_PREFIX}-taskdef`,
      cpu: 512,
      memoryLimitMiB: 1024,
      taskRole,
      executionRole: taskExecutionRole,
      volumes: [{ name: OTEL_VOLUME_NAME }],
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    // FireLens/Fluent Bit sidecar: routes the App container's logs (via the `firelens`
    // log driver on its `logging` prop below) into `logsBucket` as gzip'd objects, one
    // PutObject per upload window (batches by size/time, not per line).
    const fireLensRouter = taskDefinition.addFirelensLogRouter('FireLensLogRouter', {
      image: ecs.ContainerImage.fromRegistry(FLUENT_BIT_IMAGE),
      essential: true,
      memoryReservationMiB: 128,
      firelensConfig: { type: ecs.FirelensLogRouterType.FLUENTBIT },
    });

    // 1) Init container: copies the OTel Node.js auto-instrumentation files onto the
    //    shared task volume, then exits. The app container waits for it to SUCCEED.
    const initContainer = taskDefinition.addContainer('OtelInit', {
      image: ecs.ContainerImage.fromRegistry(ADOT_NODE_AUTOINSTRUMENTATION_IMAGE),
      essential: false,
      command: ['cp', '-a', '/autoinstrumentation/.', OTEL_MOUNT_PATH],
    });
    initContainer.addMountPoints({
      sourceVolume: OTEL_VOLUME_NAME,
      containerPath: OTEL_MOUNT_PATH,
      readOnly: false,
    });

    // 2) ADOT Collector sidecar: receives OTLP from the app and exports to X-Ray.
    const collectorContainer = taskDefinition.addContainer('OtelCollector', {
      image: ecs.ContainerImage.fromRegistry(ADOT_COLLECTOR_IMAGE),
      essential: true,
      // Hard limit backs the collector config's memory_limiter (limit_mib: 200,
      // spike_limit_mib: 40) -- without a container-level ceiling, memory_limiter has
      // nothing to protect against and the collector could OOM-kill the whole task.
      memoryLimitMiB: 256,
      secrets: {
        AOT_CONFIG_CONTENT: ecs.Secret.fromSsmParameter(collectorConfigParam),
      },
      portMappings: [
        { containerPort: 4317, protocol: ecs.Protocol.TCP },
        { containerPort: 4318, protocol: ecs.Protocol.TCP },
      ],
    });

    // 3) Next.js app container: loads the copied auto-instrumentation via NODE_OPTIONS
    //    and exports traces to the collector over localhost.
    const appContainer = taskDefinition.addContainer('App', {
      image: ecs.ContainerImage.fromAsset(path.join(__dirname, '..', '..', 'app'), {
        platform: cdk.aws_ecr_assets.Platform.LINUX_ARM64,
      }),
      essential: true,
      environment: {
        PORT: '3000',
        // Fargate (awsvpc mode) injects the task ENI's private DNS name as HOSTNAME,
        // overriding the image's `ENV HOSTNAME=0.0.0.0`. The Next.js standalone server
        // binds to $HOSTNAME, so without this override internal loopback fetches fail
        // with ECONNREFUSED 127.0.0.1.
        HOSTNAME: '0.0.0.0',
        NODE_OPTIONS: `--require ${OTEL_MOUNT_PATH}/autoinstrumentation.js`,
        OTEL_SERVICE_NAME: 'nextjs-app',
        OTEL_TRACES_EXPORTER: 'otlp',
        OTEL_METRICS_EXPORTER: 'otlp',
        OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4317',
        OTEL_PROPAGATORS: 'tracecontext,baggage,xray',
        OTEL_TRACES_SAMPLER: 'always_on',
      },
      portMappings: [{ containerPort: 3000, protocol: ecs.Protocol.TCP }],
      logging: ecs.LogDrivers.firelens({
        options: {
          Name: 's3',
          bucket: logsBucket.bucketName,
          region: this.region,
          total_file_size: '1M',
          upload_timeout: '1m',
          use_put_object: 'On',
          compression: 'gzip',
          s3_key_format: '/app/%Y/%m/%d/%H/%M/%S-$UUID',
        },
      }),
      healthCheck: {
        // NODE_OPTIONS is cleared for the probe itself -- otherwise every health check
        // would also load the OTel auto-instrumentation via --require, on top of the
        // long-running process already doing so.
        command: [
          'CMD-SHELL',
          'NODE_OPTIONS= node -e "fetch(\'http://127.0.0.1:3000/api/hello\').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"',
        ],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(30),
      },
    });
    appContainer.addMountPoints({
      sourceVolume: OTEL_VOLUME_NAME,
      containerPath: OTEL_MOUNT_PATH,
      readOnly: true,
    });
    appContainer.addContainerDependencies(
      {
        container: initContainer,
        condition: ecs.ContainerDependencyCondition.SUCCESS,
      },
      {
        container: collectorContainer,
        condition: ecs.ContainerDependencyCondition.START,
      },
      {
        container: fireLensRouter,
        condition: ecs.ContainerDependencyCondition.START,
      }
    );

    const service = new ecs.FargateService(this, 'Service', {
      cluster,
      taskDefinition,
      serviceName: `${NAME_PREFIX}-service`,
      securityGroups: [serviceSecurityGroup],
      desiredCount: 1,
      circuitBreaker: { rollback: true },
      // Run entirely on Fargate Spot -- this is a demo/verification workload, not one that
      // needs on-demand's interruption guarantees.
      capacityProviderStrategies: [{ capacityProvider: 'FARGATE_SPOT', weight: 1 }],
    });

    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      loadBalancerName: `${NAME_PREFIX}-alb`,
      internetFacing: true,
    });
    const listener = alb.addListener('Listener', { port: 80, open: true });
    listener.addTargets('AppTarget', {
      // Forces a new target group alongside the new ALB/Listener -- an unnamed (unchanged)
      // target group would stay attached to the old ALB during the swap, and a target
      // group can only be associated with one load balancer at a time.
      targetGroupName: `${NAME_PREFIX}-tg`,
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [service.loadBalancerTarget({ containerName: 'App', containerPort: 3000 })],
      healthCheck: {
        path: '/api/hello',
        healthyHttpCodes: '200',
      },
    });

    new cdk.CfnOutput(this, 'AlbDnsName', { value: alb.loadBalancerDnsName });
  }
}
