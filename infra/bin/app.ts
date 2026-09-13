#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { OtelEcsStack } from '../lib/otel-ecs-stack';

const app = new cdk.App();

new OtelEcsStack(app, 'NextjsEcsOtelAutoStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'us-west-2',
  },
});
